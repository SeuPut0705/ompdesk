/**
 * What OMPdesk costs with many sessions open: RSS and CPU of every process the app runs, grouped as the app's own
 * (main, renderer, GPU, helpers) and per session (each omp and what it starts), sampled with `ps` (macOS, Linux).
 *
 * The opt-in spec `e2e/session-footprint.e2e.ts` drives the built app through its phases (fake omp for scale, a few
 * real omp) and writes one JSON report; this file holds the sampler it uses and the command line that runs it and
 * prints or compares reports:
 *
 *   bun scripts/session-footprint.ts run [--fake 20] [--real 2] [--out <file.json>]
 *   bun scripts/session-footprint.ts show <report.json> [<other.json>]
 *
 * `run` takes the `playwright` lock slot (`bun run locked`). Nothing it starts outlives it: the spec quits each app
 * and the sampler counts the detached omp workers (brokers) that appeared during a phase, so a leak shows.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";

/** What a process is to OMPdesk. */
export type Role =
	| "main"
	| "renderer"
	| "gpu"
	| "utility"
	| "stock-helper"
	| "stats-host"
	| "mcp-hub"
	| "ai-memory"
	| "omp"
	| "omp-worker"
	| "other";

export interface Proc {
	pid: number;
	ppid: number;
	rssBytes: number;
	/** CPU time used so far, in milliseconds. */
	cpuMs: number;
	/** macOS `phys_footprint` (what memory pressure counts: dirty and compressed pages, no shared clean ones). */
	footprintBytes?: number;
	command: string;
}

export interface Sample {
	at: number;
	procs: Proc[];
}

/** `ps` CPU time (`[[dd-]hh:]mm:ss.cc`) in milliseconds. */
export function cpuTimeMs(text: string): number {
	const [days, rest] = text.includes("-") ? (text.split("-") as [string, string]) : ["0", text];
	const parts = rest.split(":").map(Number);
	while (parts.length < 3) parts.unshift(0);
	const [hours = 0, minutes = 0, seconds = 0] = parts;
	return Math.round(((Number(days) * 24 + hours) * 3600 + minutes * 60 + seconds) * 1000);
}

export function parsePs(text: string): Proc[] {
	const procs: Proc[] = [];
	for (const line of text.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
		if (!match) continue;
		procs.push({
			pid: Number(match[1]),
			ppid: Number(match[2]),
			rssBytes: Number(match[3]) * 1024,
			cpuMs: cpuTimeMs(match[4] ?? "0"),
			command: match[5] ?? "",
		});
	}
	return procs;
}

export function samplePs(): Sample {
	const text = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,rss=,time=,command="], {
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
	return { at: Date.now(), procs: parsePs(text) };
}

export function roleOf(proc: Proc, mainPid: number): Role {
	const command = proc.command;
	if (proc.pid === mainPid) return "main";
	if (command.includes("--type=renderer")) return "renderer";
	if (command.includes("--type=gpu-process")) return "gpu";
	if (command.includes("--type=utility")) return "utility";
	if (command.includes("stock-helper/host")) return "stock-helper";
	if (command.includes("stats-host")) return "stats-host";
	if (command.includes("mcp-hub")) return "mcp-hub";
	if (command.includes("ai-memory")) return "ai-memory";
	if (/--mode rpc-ui\b/.test(command)) return "omp";
	if (command.includes("__omp_worker")) return "omp-worker";
	return "other";
}

export interface Tree {
	/** Every process under the app's main process, and the detached omp workers given. */
	procs: Array<Proc & { role: Role; session?: number }>;
}

/** The memory a process costs: its footprint where measured, else its RSS. */
export const bytesOf = (proc: Proc) => proc.footprintBytes ?? proc.rssBytes;

const UNIT: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };

/** Fills in each process's `phys_footprint` with one `footprint` run (macOS; elsewhere the tree is unchanged). */
export function withFootprints(tree: Tree): Tree {
	if (process.platform !== "darwin" || tree.procs.length === 0) return tree;
	const result = spawnSync(
		"/usr/bin/footprint",
		tree.procs.flatMap(proc => ["-p", String(proc.pid)]),
		{
			encoding: "utf8",
			maxBuffer: 16 * 1024 * 1024,
		},
	);
	const found = new Map<number, number>();
	for (const match of (result.stdout ?? "").matchAll(/\[(\d+)\]: \S+\s+Footprint: ([\d.]+) (B|KB|MB|GB)/g))
		found.set(Number(match[1]), Number(match[2]) * (UNIT[match[3] ?? "B"] ?? 1));
	return {
		procs: tree.procs.map(proc => {
			const bytes = found.get(proc.pid);
			return bytes === undefined ? proc : { ...proc, footprintBytes: bytes };
		}),
	};
}

/**
 * The app's process tree in `sample`: main and its descendants, each tagged with its role and, under an omp, the pid
 * of that omp (its session). `detached` adds omp workers that left the tree (a daemon broker re-parents to launchd).
 */
export function appTree(sample: Sample, mainPid: number, detached: ReadonlySet<number> = new Set()): Tree {
	const children = new Map<number, Proc[]>();
	for (const proc of sample.procs) {
		const list = children.get(proc.ppid) ?? [];
		list.push(proc);
		children.set(proc.ppid, list);
	}
	const out: Tree["procs"] = [];
	const walk = (proc: Proc, session: number | undefined) => {
		const role = roleOf(proc, mainPid);
		const own = role === "omp" ? proc.pid : session;
		out.push({ ...proc, role, ...(own === undefined ? {} : { session: own }) });
		for (const child of children.get(proc.pid) ?? []) walk(child, own);
	};
	const main = sample.procs.find(proc => proc.pid === mainPid);
	if (main) walk(main, undefined);
	for (const proc of sample.procs)
		if (detached.has(proc.pid) && !out.some(entry => entry.pid === proc.pid))
			out.push({ ...proc, role: roleOf(proc, mainPid) });
	return { procs: out };
}

/** omp workers that appeared after `before` and now have no parent but launchd: candidates for `appTree`'s `detached`. */
export function detachedWorkers(before: Sample, now: Sample): Set<number> {
	const known = new Set(before.procs.map(proc => proc.pid));
	return new Set(
		now.procs
			.filter(proc => proc.ppid === 1 && !known.has(proc.pid) && proc.command.includes("__omp_worker"))
			.map(proc => proc.pid),
	);
}

export interface PhaseSummary {
	name: string;
	/** Sessions with a live omp. */
	sessions: number;
	/** Bytes by role (summed over processes of that role). */
	rss: Partial<Record<Role, number>>;
	/** RSS of the app's own processes (everything but omp and its children). */
	fixedBytes: number;
	/** RSS of every session tree (omp and what it started). */
	sessionBytes: number;
	totalBytes: number;
	/** Average CPU over the phase window, in % of one core, by role. */
	cpu: Partial<Record<Role, number>>;
	cpuTotal: number;
	/** Wall time the CPU numbers cover. */
	windowMs: number;
	notes?: string;
	/** The largest processes in the last sample: role, MB, CPU % over the phase, command (cut). */
	top: Array<{ role: Role; mb: number; cpu: number; command: string }>;
}

const median = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] ?? 0) : 0;
};

/**
 * One phase from its samples (taken `windowMs` apart or more): RSS is the median over the samples, CPU the CPU time
 * used between the first and the last sample by processes alive in both, over the wall time between them.
 */
export function summarize(name: string, trees: Array<{ at: number; tree: Tree }>, notes?: string): PhaseSummary {
	const first = trees[0];
	const last = trees.at(-1);
	if (!first || !last) throw new Error(`phase ${name} has no samples`);
	const perSample = trees.map(({ tree }) => {
		const out: Partial<Record<Role, number>> = {};
		for (const proc of tree.procs) out[proc.role] = (out[proc.role] ?? 0) + bytesOf(proc);
		return out;
	});
	const roles = new Set(perSample.flatMap(entry => Object.keys(entry) as Role[]));
	const rss: Partial<Record<Role, number>> = {};
	for (const role of roles) rss[role] = median(perSample.map(entry => entry[role] ?? 0));
	const sessionBytes = median(
		trees.map(({ tree }) =>
			tree.procs
				.filter(proc => proc.session !== undefined || proc.role === "omp-worker")
				.reduce((sum, proc) => sum + bytesOf(proc), 0),
		),
	);
	const totals = trees.map(({ tree }) => tree.procs.reduce((sum, proc) => sum + bytesOf(proc), 0));
	const totalBytes = median(totals);
	const windowMs = last.at - first.at;
	const cpu: Partial<Record<Role, number>> = {};
	const cpuOf = new Map<number, number>();
	let cpuTotal = 0;
	if (windowMs > 0) {
		const before = new Map(first.tree.procs.map(proc => [proc.pid, proc]));
		for (const proc of last.tree.procs) {
			const start = before.get(proc.pid);
			if (!start) continue;
			const share = ((proc.cpuMs - start.cpuMs) / windowMs) * 100;
			cpuOf.set(proc.pid, share);
			cpu[proc.role] = (cpu[proc.role] ?? 0) + share;
			cpuTotal += share;
		}
	}
	const top = [...last.tree.procs]
		.sort((a, b) => bytesOf(b) - bytesOf(a))
		.slice(0, 10)
		.map(proc => ({
			role: proc.role,
			mb: Math.round(bytesOf(proc) / 2 ** 20),
			cpu: Math.round((cpuOf.get(proc.pid) ?? 0) * 10) / 10,
			command: proc.command.slice(0, 160),
		}));
	return {
		name,
		sessions: median(trees.map(({ tree }) => tree.procs.filter(proc => proc.role === "omp").length)),
		rss,
		fixedBytes: totalBytes - sessionBytes,
		sessionBytes,
		totalBytes,
		cpu,
		cpuTotal,
		windowMs,
		...(notes ? { notes } : {}),
		top,
	};
}

export interface Report {
	commit: string;
	date: string;
	machine: { totalBytes: number; platform: string; arch: string };
	phases: PhaseSummary[];
	/** Restore (start an asleep tab until ready), ms, per try. */
	restoreMs?: Record<string, number[]>;
}

const MB = 1024 * 1024;
const mb = (bytes: number | undefined) => `${Math.round((bytes ?? 0) / MB)}`;
const pct = (value: number | undefined) => (value ?? 0).toFixed(1);

/** The table `show` prints: one row per phase, MB and % of a core. */
export function formatReport(report: Report, label = ""): string {
	const lines = [
		`${label}${report.commit} ${report.date} (${Math.round(report.machine.totalBytes / 1024 ** 3)} GB ${report.machine.platform})`,
		"phase                              sess  total MB  fixed MB  per-sess MB  main  rend  omp  | cpu%: total main rend omp",
	];
	for (const phase of report.phases) {
		const per = phase.sessions ? phase.sessionBytes / phase.sessions : 0;
		lines.push(
			[
				phase.name.padEnd(34),
				String(phase.sessions).padStart(4),
				mb(phase.totalBytes).padStart(9),
				mb(phase.fixedBytes).padStart(9),
				mb(per).padStart(12),
				mb(phase.rss.main).padStart(5),
				mb(phase.rss.renderer).padStart(5),
				mb(phase.rss.omp).padStart(5),
				" |",
				pct(phase.cpuTotal).padStart(10),
				pct(phase.cpu.main).padStart(5),
				pct(phase.cpu.renderer).padStart(5),
				pct(phase.cpu.omp).padStart(5),
			].join(" "),
		);
	}
	for (const [name, tries] of Object.entries(report.restoreMs ?? {}))
		lines.push(`restore ${name}: ${tries.map(ms => `${Math.round(ms)} ms`).join(", ")}`);
	return lines.join("\n");
}

function main(argv: string[]): void {
	const [command, ...rest] = argv;
	const flag = (name: string, fallback: string) => {
		const index = rest.indexOf(`--${name}`);
		return index >= 0 ? (rest[index + 1] ?? fallback) : fallback;
	};
	if (command === "show") {
		for (const [index, file] of rest.entries())
			console.log(
				`${formatReport(JSON.parse(readFileSync(file, "utf8")) as Report, rest.length > 1 ? `[${index}] ` : "")}\n`,
			);
		return;
	}
	if (command === "run") {
		const out = path.resolve(flag("out", `tmp/session-footprint-${Date.now()}.json`));
		const result = spawnSync(
			"bun",
			["run", "locked", "--", "bunx", "playwright", "test", "e2e/session-footprint.e2e.ts", "--workers=1"],
			{
				stdio: "inherit",
				env: {
					...process.env,
					OMP_GUI_FOOTPRINT_OUT: out,
					OMP_GUI_FOOTPRINT_FAKE: flag("fake", "20"),
					OMP_GUI_FOOTPRINT_REAL: flag("real", "2"),
					OMP_GUI_FOOTPRINT_COMMIT: execFileSync("git", ["rev-parse", "--short", "HEAD"], {
						encoding: "utf8",
					}).trim(),
				},
			},
		);
		if (result.status !== 0) process.exit(result.status ?? 1);
		console.log(formatReport(JSON.parse(readFileSync(out, "utf8")) as Report));
		console.log(`\nreport: ${out}`);
		return;
	}
	console.error(
		"usage: bun scripts/session-footprint.ts run [--fake N] [--real N] [--out file] | show <report.json>...",
	);
	process.exit(2);
}

if (import.meta.main) main(process.argv.slice(2));
