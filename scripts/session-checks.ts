/**
 * How much of the sessions' time went to checks and tests, read from stock omp's session journals: the measurement
 * behind `scripts/changed-tests.ts`, `.omp/rules/waste-guards.md` › "Measured and not guarded" and the `checks` part
 * of the Pace line. Counts, durations, command lines and test runners' output only; never a person's message.
 *
 *   bun scripts/session-checks.ts [--days N] [--failures] [--json <file>]
 *
 * Per folder group (this repository's checkouts against everything else): active time, time inside tool calls and how
 * much of it a check was running for (`pace()`, `src/main/session-pace.ts`: the Pace line's own numbers), the time
 * blocked in `wait` split by what was waited for (a check, a subagent, both, another job, no job), and every check run
 * by family. Then what a count of runs cannot say:
 *   - what each wide run (`check:changed`, `vitest related`, a whole suite) failed on, per failed test file: a timeout
 *     or a temp folder Windows would not release (load), an assertion that passed when the file was run again alone
 *     with nothing edited (load), one that failed in another checkout's wide run too (not this change), one that passed
 *     alone only after an edit, one still failing alone, or one never run again (`--failures` lists them);
 *   - a wide check started again after the same command passed with no edit in between;
 *   - polls by kind.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { testCounts } from "../resources/gui-bridge/command-verdict-core";
import { checkRun, pace, unionSeconds } from "../src/main/session-pace";

const SESSIONS = path.join(os.homedir(), ".omp", "agent", "sessions");
const OUTPUT_KEEP = 400_000;

type Family =
	| "ci-watch"
	| "check:changed"
	| "gate"
	| "playwright"
	| "vitest"
	| "typecheck"
	| "cargo"
	| "lint"
	| "build"
	| "other";

const FAMILIES: readonly [Family, RegExp][] = [
	["ci-watch", /\bgh\s+run\s+watch\b|\bwatch-run\.ts\b/],
	["check:changed", /\bcheck:changed\b(?!.*--list)|\bcheck-changed\.ts\b(?!.*--list)/],
	["gate", /\bbun\s+run\s+gate\b|\bscripts\/gate\.ts\b/],
	["playwright", /\bplaywright\s+test\b|\bbun\s+run\s+(?:parity|flake)\b/],
	["vitest", /\bvitest\b|\bbun\s+run\s+test(?::[\w:-]+)?\b|\bbun\s+test\b|\bjest\b|\bpytest\b/],
	["cargo", /\bcargo\s+(?:test|check|clippy|build|nextest)\b|\bbuild:native\b/],
	["typecheck", /\bcheck:types\b|\btsc\b|\btypecheck\b/],
	["lint", /\bbiome\b|\beslint\b|\blint[\w:-]*\b/],
	["build", /\bbuild\b/],
];

const TEST_FILE = /(?:[\w@.-]+[\\/])*[\w.-]+\.(?:test|e2e|spec)\.[cm]?[jt]sx?/g;
const SOURCE_DIR_ARG = /\s(?:src|e2e|scripts|resources|tests?)[\\/][\w./\\-]+/;

/** A run over more than the files the session named: the changed-file gate, `vitest related`, a suite with no file. */
function isWide(command: string, family: Family): boolean {
	const namesTest = command.search(TEST_FILE) >= 0;
	if (family === "check:changed" || family === "gate" || family === "typecheck") return true;
	if (family === "vitest")
		return (
			/\bvitest\s+related\b/.test(command) ||
			(!namesTest && !SOURCE_DIR_ARG.test(command) && !/\s-t\s/.test(command))
		);
	if (family === "playwright")
		return /\bplaywright\s+test\b/.test(command) && !namesTest && !/\s(?:-g|--grep)\s/.test(command);
	if (family === "cargo") return /\bcargo\s+(?:test|nextest\s+run)\b/.test(command) && /--workspace\b/.test(command);
	return false;
}

type Cause = "timeout" | "temp-folder" | "assertion";

interface Failure {
	file: string;
	cause: Cause;
	/** The session edited this file, ran it by name, or edited the file it tests, before the run. */
	own: boolean;
	/** What the next run naming this file alone showed. */
	rerun: "pass-no-edit" | "pass-after-edit" | "fail" | "none";
}

interface Run {
	session: string;
	at: number;
	command: string;
	family: Family;
	wide: boolean;
	background: boolean;
	seconds?: number;
	failed?: boolean;
	/** Test files the run's own summary counted, when it printed one. */
	testFiles?: number;
	/** `check:changed`'s own steps in seconds (`types`, `vitest`, …) and how long it waited for the machine's lock. */
	steps?: Record<string, number>;
	lockWaitS?: number;
	/** Successful edit, write and ast_edit calls before this run started. */
	editsBefore: number;
	names: string[];
	failures: Failure[];
	failedStep?: string;
}

interface SessionStats {
	file: string;
	cwd: string;
	subagent: boolean;
	activeS: number;
	toolS: number;
	/** Time inside tool calls while a check ran (the Pace line's `checks`). */
	checkS: number;
	waitS: number;
	waits: number;
	wait: { check: number; subagent: number; both: number; otherJob: number; noJob: number };
	taskS: number;
	childSessionS: number;
	runs: Run[];
	polls: Record<string, number>;
	/** A wide check started again after the same command passed, nothing edited in between. */
	repeatsAfterPass: Run[];
}

interface Spilled {
	meta?: { minimized?: { artifactId?: string } };
}

interface Job extends Spilled {
	id?: string;
	jobId?: string;
	type?: string;
	status?: string;
	durationMs?: number;
	settledAtMs?: number;
	errorText?: string;
	resultText?: string;
}

interface Details extends Spilled {
	exitCode?: number;
	async?: { jobId?: string };
	jobs?: Job[];
}

interface Part {
	type?: string;
	id?: string;
	name?: string;
	text?: string;
	arguments?: Record<string, unknown>;
}

interface Entry {
	type?: string;
	customType?: string;
	cwd?: string;
	timestamp?: string | number;
	data?: { toolCallId?: string };
	details?: Details;
	content?: Part[] | string;
	message?: {
		role?: string;
		content?: Part[] | string;
		toolCallId?: string;
		toolName?: string;
		isError?: boolean;
		details?: Details;
	};
}

function text(content: Part[] | string | undefined): string {
	if (typeof content === "string") return content;
	return (content ?? []).map(part => part.text ?? "").join("\n");
}

const FAIL_LINE = /^\s*FAIL\s+(?:\|\w+\|\s+)?(\S+\.(?:test|e2e|spec)\.[cm]?[jt]sx?)/;
const CAUSES: readonly [Cause, RegExp][] = [
	["timeout", /timed out|exceeded timeout|Timeout \d+ms exceeded/i],
	["temp-folder", /\b(?:EPERM|EBUSY|ENOTEMPTY)\b/],
];

/** The test files vitest's failure sections name, each with the cause of its failures (an assertion wins). */
function failedFiles(output: string): Map<string, Cause> {
	const found = new Map<string, Cause>();
	const lines = output.split("\n");
	for (const [index, line] of lines.entries()) {
		const file = FAIL_LINE.exec(line)?.[1]?.replaceAll("\\", "/");
		if (!file) continue;
		const under = lines.slice(index + 1, index + 4).join("\n");
		const cause = CAUSES.find(([, pattern]) => pattern.test(under))?.[0] ?? "assertion";
		if (found.get(file) !== "assertion") found.set(file, cause);
	}
	return found;
}

const stem = (file: string): string =>
	path.basename(file).replace(/\.(?:test|e2e|spec)\.[cm]?[jt]sx?$|\.[cm]?[jt]sx?$|\.rs$/, "");

/** The end of the full output of a call or job whose shown text stock minimized, spilled beside the journal. */
function spilled(file: string, details: Spilled | undefined): string | undefined {
	const id = details?.meta?.minimized?.artifactId;
	if (!id) return undefined;
	const dir = file.replace(/\.jsonl$/, "");
	try {
		const name = fs.readdirSync(dir).find(entry => entry.startsWith(`${id}.`));
		if (!name) return undefined;
		const full = path.join(dir, name);
		const size = fs.statSync(full).size;
		const handle = fs.openSync(full, "r");
		const buffer = Buffer.alloc(Math.min(size, OUTPUT_KEEP));
		fs.readSync(handle, buffer, 0, buffer.length, size - buffer.length);
		fs.closeSync(handle);
		return buffer.toString("utf8");
	} catch {
		return undefined;
	}
}

function read(file: string): SessionStats | undefined {
	const lines = fs.readFileSync(file, "utf8").split("\n");
	const whole = pace(lines);
	if (whole.wallS === 0) return undefined;
	const stats: SessionStats = {
		file,
		cwd: "",
		subagent: path.relative(SESSIONS, file).split(path.sep).length > 2,
		activeS: whole.wallS - whole.idleS,
		toolS: whole.toolS,
		checkS: whole.checks?.seconds ?? 0,
		waitS: whole.tools.wait?.seconds ?? 0,
		waits: whole.tools.wait?.calls ?? 0,
		wait: { check: 0, subagent: 0, both: 0, otherJob: 0, noJob: 0 },
		taskS: whole.tools.task?.seconds ?? 0,
		childSessionS: 0,
		runs: [],
		polls: whole.pollKinds ?? {},
		repeatsAfterPass: [],
	};
	const starts = new Map<string, number>();
	const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
	const jobs = new Map<string, Run>();
	const edited = new Set<string>();
	const named = new Set<string>();
	const lastPass = new Map<string, number>();
	let edits = 0;

	const settle = (run: Run, failed: boolean, seconds: number | undefined, output: string): void => {
		if (run.failed !== undefined) return;
		run.failed = failed || (testCounts(output).failed ?? 0) > 0 || /\[check:changed\] FAILED/.test(output);
		if (seconds !== undefined) run.seconds = seconds;
		const counted = /Test Files\s+.*\((\d+)\)/.exec(output)?.[1];
		if (counted) run.testFiles = Number(counted);
		for (const step of output.matchAll(/\[check:changed\] [✓✗] ([\w-]+) ([\d.]+)s/g))
			run.steps = { ...run.steps, [step[1] ?? ""]: Number(step[2]) };
		for (const waited of output.matchAll(/\[lock\] waited ([\d.]+)s/g))
			run.lockWaitS = (run.lockWaitS ?? 0) + Number(waited[1]);
		if (!run.failed) {
			lastPass.set(run.command, edits);
			return;
		}
		run.failedStep =
			/\[check:changed\] FAILED: ([\w, :-]+)/.exec(output)?.[1] ??
			/Command timed out after \d+ seconds/.exec(output)?.[0];
		for (const [failedFile, cause] of failedFiles(output))
			run.failures.push({
				file: failedFile,
				cause,
				own:
					edited.has(failedFile) ||
					named.has(failedFile) ||
					[...edited].some(source => stem(source) === stem(failedFile)),
				rerun: "none",
			});
	};

	for (const line of lines) {
		if (!line) continue;
		let entry: Entry;
		try {
			entry = JSON.parse(line) as Entry;
		} catch {
			continue;
		}
		if (entry.type === "session" && entry.cwd) stats.cwd = entry.cwd;
		const stamp = entry.timestamp;
		const at =
			typeof stamp === "number" ? stamp / 1000 : typeof stamp === "string" ? Date.parse(stamp) / 1000 : undefined;
		if (at === undefined) continue;
		if (entry.type === "custom" && entry.customType === "tool_execution_start") {
			if (entry.data?.toolCallId) starts.set(entry.data.toolCallId, at);
			continue;
		}
		if (entry.type === "custom_message" && entry.customType === "async-result") {
			for (const job of entry.details?.jobs ?? []) {
				const run = job.jobId ? jobs.get(job.jobId) : undefined;
				if (!run) continue;
				const seconds = job.durationMs !== undefined ? job.durationMs / 1000 : undefined;
				settle(run, job.status === "failed", seconds, spilled(file, job) ?? text(entry.content));
			}
			continue;
		}
		const message = entry.message;
		if (entry.type !== "message" || !message) continue;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content)
				if (part.type === "toolCall" && part.name && part.id)
					calls.set(part.id, { name: part.name, args: part.arguments ?? {} });
			continue;
		}
		if (message.role !== "toolResult" || !message.toolCallId) continue;
		const call = calls.get(message.toolCallId);
		const began = starts.get(message.toolCallId);
		const name = message.toolName ?? call?.name ?? "?";
		const details = message.details ?? {};
		const args = call?.args ?? {};
		const took = began !== undefined ? at - began : 0;
		if (name === "edit" || name === "write" || name === "ast_edit") {
			if (!message.isError) edits++;
			const targets =
				typeof args.path === "string"
					? [args.path]
					: [...String(args.input ?? "").matchAll(/^\[([^\]#]+)#/gm)].map(match => match[1] ?? "");
			for (const target of targets) edited.add(target.replaceAll("\\", "/"));
		}
		if (
			name === "ompdesk_session_result" ||
			(name === "write" && String(args.path).includes("xd://ompdesk_session_result"))
		)
			stats.childSessionS += took;
		if (name === "bash" && typeof args.command === "string" && checkRun(args.command)) {
			const command = args.command;
			const family = FAMILIES.find(([, pattern]) => pattern.test(command))?.[0] ?? "other";
			const names = [...command.matchAll(TEST_FILE)].map(match => match[0].replaceAll("\\", "/"));
			const run: Run = {
				session: path.relative(SESSIONS, file),
				at: began ?? at,
				command,
				family,
				wide: isWide(command, family),
				background: details.async?.jobId !== undefined,
				editsBefore: edits,
				names,
				failures: [],
			};
			if (run.wide && lastPass.get(run.command) === edits) stats.repeatsAfterPass.push(run);
			stats.runs.push(run);
			for (const testFile of names) named.add(testFile);
			if (details.async?.jobId !== undefined) jobs.set(details.async.jobId, run);
			else
				settle(
					run,
					message.isError === true || typeof details.exitCode === "number",
					began !== undefined ? took : undefined,
					spilled(file, details) ?? text(message.content),
				);
		}
		if (name !== "wait" || began === undefined) continue;
		const spans: Record<"check" | "agent" | "job", [number, number][]> = { check: [], agent: [], job: [] };
		for (const job of details.jobs ?? []) {
			const end = job.settledAtMs !== undefined ? job.settledAtMs / 1000 : at;
			const from = Math.max(began, end - (job.durationMs ?? 0) / 1000);
			const to = Math.min(at, end);
			const run = job.id ? jobs.get(job.id) : undefined;
			if (to > from) spans[job.type !== "bash" ? "agent" : run ? "check" : "job"].push([from, to]);
			if (run && (job.status === "completed" || job.status === "failed"))
				settle(
					run,
					job.status === "failed",
					(job.durationMs ?? 0) / 1000,
					spilled(file, job) ?? `${job.errorText ?? job.resultText ?? ""}\n${text(message.content)}`,
				);
		}
		const checkS = unionSeconds(spans.check);
		const agentS = unionSeconds(spans.agent);
		const bothS = checkS + agentS - unionSeconds([...spans.check, ...spans.agent]);
		const anyS = unionSeconds([...spans.check, ...spans.agent, ...spans.job]);
		stats.wait.check += checkS - bothS;
		stats.wait.subagent += agentS - bothS;
		stats.wait.both += bothS;
		stats.wait.otherJob += anyS - (checkS + agentS - bothS);
		stats.wait.noJob += Math.max(0, took - anyS);
	}
	// What a wide run failed on, run again alone: say whether it failed again, and whether anything was edited between.
	for (const [index, run] of stats.runs.entries())
		for (const failure of run.failures) {
			const again = stats.runs.slice(index + 1).find(later => !later.wide && later.names.includes(failure.file));
			if (!again) continue;
			// A rerun of several files fails as a whole: this file failed again only when the rerun names it (or names none).
			const failedAgain =
				again.failed === true &&
				(again.failures.length === 0 || again.failures.some(other => other.file === failure.file));
			failure.rerun = failedAgain
				? "fail"
				: again.editsBefore === run.editsBefore
					? "pass-no-edit"
					: "pass-after-edit";
		}
	return stats;
}

function journals(days: number): string[] {
	const since = Date.now() - days * 86_400_000;
	const files: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".jsonl") && fs.statSync(full).mtimeMs >= since) files.push(full);
		}
	};
	walk(SESSIONS);
	return files;
}

const hours = (s: number): string => `${(s / 3600).toFixed(1)} h`;
const HERE = /ompdesk|[\\/]\.omp[\\/]wt[\\/]gui-/i;

function summarize(label: string, sessions: SessionStats[]): string[] {
	const main = sessions.filter(s => !s.subagent);
	const sum = (pick: (s: SessionStats) => number, from = sessions): number =>
		from.reduce((total, s) => total + pick(s), 0);
	const runs = sessions.flatMap(s => s.runs);
	const seconds = (list: Run[]): number => list.reduce((total, run) => total + (run.seconds ?? 0), 0);
	const share = (part: number, whole: number): string => `${whole > 0 ? Math.round((part / whole) * 100) : 0}%`;
	const out = [
		`== ${label}: ${main.length} sessions, ${sessions.length - main.length} subagent journals`,
		`sessions: active ${hours(sum(s => s.activeS, main))} · in tool calls ${hours(sum(s => s.toolS, main))} · of that with a check running ${hours(sum(s => s.checkS, main))} (${share(
			sum(s => s.checkS, main),
			sum(s => s.toolS, main),
		)}) · in wait ${hours(sum(s => s.waitS, main))} (${sum(s => s.waits, main)} waits) · in task ${hours(sum(s => s.taskS, main))} · in ompdesk_session_result ${hours(sum(s => s.childSessionS, main))}`,
		`subagents: active ${hours(sum(s => s.activeS) - sum(s => s.activeS, main))} · in tool calls ${hours(sum(s => s.toolS) - sum(s => s.toolS, main))} · with a check running ${hours(sum(s => s.checkS) - sum(s => s.checkS, main))}`,
		`wait on (all journals): a check ${hours(sum(s => s.wait.check))} · a subagent ${hours(sum(s => s.wait.subagent))} · both ${hours(sum(s => s.wait.both))} · another job ${hours(sum(s => s.wait.otherJob))} · no job (a message, a reply) ${hours(sum(s => s.wait.noJob))}`,
		`checks: ${runs.length} runs, ${hours(seconds(runs))} of run time (${runs.filter(run => run.seconds === undefined).length} with no recorded end)`,
	];
	const families = new Map<Family, Run[]>();
	for (const run of runs) families.set(run.family, [...(families.get(run.family) ?? []), run]);
	for (const [name, list] of [...families].sort((a, b) => seconds(b[1]) - seconds(a[1]))) {
		const timed = list.filter(run => run.seconds !== undefined).length;
		out.push(
			`   ${name.padEnd(14)} ${hours(seconds(list)).padStart(7)}  runs ${String(list.length).padStart(4)}  avg ${String(Math.round(seconds(list) / Math.max(1, timed))).padStart(4)} s  failed ${String(list.filter(run => run.failed).length).padStart(3)}  wide ${String(list.filter(run => run.wide).length).padStart(3)}  background ${list.filter(run => run.background).length}`,
		);
	}
	const wideTests = runs.filter(
		run => run.wide && (run.family === "check:changed" || run.family === "vitest" || run.family === "gate"),
	);
	const failures = wideTests.flatMap(run =>
		run.failures.map(failure => ({ ...failure, checkout: run.session.split(path.sep)[0] })),
	);
	// A test file that failed in the wide runs of two checkouts was broken by neither's change.
	const checkouts = new Map<string, Set<string | undefined>>();
	for (const failure of failures)
		if (failure.cause === "assertion")
			checkouts.set(failure.file, (checkouts.get(failure.file) ?? new Set()).add(failure.checkout));
	const verdicts = new Map<string, number>();
	for (const failure of failures) {
		const verdict =
			failure.cause !== "assertion"
				? failure.cause === "timeout"
					? "timed out"
					: "temp folder not released"
				: failure.rerun === "pass-no-edit"
					? "passed alone, nothing edited"
					: (checkouts.get(failure.file)?.size ?? 0) > 1
						? "failed in other checkouts' runs too"
						: failure.rerun === "pass-after-edit"
							? "passed alone after an edit"
							: failure.rerun === "fail"
								? "still failed alone"
								: "never run again";
		verdicts.set(verdict, (verdicts.get(verdict) ?? 0) + 1);
	}
	const files = wideTests
		.map(run => run.testFiles)
		.filter(value => value !== undefined)
		.sort((a, b) => a - b);
	const changed = runs.filter(run => run.family === "check:changed" && run.seconds !== undefined);
	const stepSeconds = new Map<string, number>();
	for (const run of changed)
		for (const [step, took] of Object.entries(run.steps ?? {}))
			stepSeconds.set(step, (stepSeconds.get(step) ?? 0) + took);
	const repeats = sessions.flatMap(s => s.repeatsAfterPass);
	const polls: Record<string, number> = {};
	for (const s of sessions) for (const [kind, n] of Object.entries(s.polls)) polls[kind] = (polls[kind] ?? 0) + n;
	const polled = sessions.map(s => Object.values(s.polls).reduce((total, n) => total + n, 0)).filter(n => n > 0);
	out.push(
		`wide vitest runs (check:changed, vitest related, a whole suite): ${wideTests.length}, ${hours(seconds(wideTests))}, failed ${wideTests.filter(run => run.failed).length}; test files per run: median ${files[Math.floor(files.length / 2)] ?? "?"}, most ${files.at(-1) ?? "?"}`,
		`   failed test files ${failures.length}: ${[...verdicts].map(([name, n]) => `${name} ${n}`).join(" · ")}`,
		`   of those, in a file the session edited, named or whose source it edited: ${failures.filter(failure => failure.own).length}`,
		`   check:changed by step: ${[...stepSeconds].map(([step, took]) => `${step} ${hours(took)}`).join(" · ")} · waiting for the lock ${hours(changed.reduce((total, run) => total + (run.lockWaitS ?? 0), 0))} · steps printed in ${changed.filter(run => run.steps).length} of ${changed.length} runs`,
		`wide checks started again after the same command passed with no edit in between: ${repeats.length} of ${runs.filter(run => run.wide).length} (${hours(seconds(repeats))})`,
		`polls: ${
			Object.entries(polls)
				.map(([kind, n]) => `${kind} ${n}`)
				.join(" · ") || "none"
		}; ${polled.length} journals polled, most ${Math.max(0, ...polled)}`,
	);
	return out;
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const value = (name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
	const sessions = journals(Number(value("--days") ?? 3))
		.map(read)
		.filter(stats => stats !== undefined);
	console.log(
		[
			...summarize(
				"this repository",
				sessions.filter(s => HERE.test(s.cwd)),
			),
			"",
			...summarize(
				"other folders",
				sessions.filter(s => !HERE.test(s.cwd)),
			),
		].join("\n"),
	);
	if (args.includes("--failures"))
		for (const run of sessions.flatMap(s => s.runs).filter(candidate => candidate.wide && candidate.failed))
			console.log(
				`\n${run.session.slice(0, 60)} ${new Date(run.at * 1000).toISOString()} ${run.family} ${Math.round(run.seconds ?? 0)} s, ${run.testFiles ?? "?"} test files, failed step: ${run.failedStep ?? "?"}\n  $ ${run.command.replace(/\s+/g, " ").slice(0, 200)}\n${run.failures.map(failure => `  ${failure.own ? "own  " : "other"} ${failure.cause.padEnd(11)} rerun ${failure.rerun.padEnd(15)} ${failure.file}`).join("\n")}`,
			);
	const json = value("--json");
	if (json) fs.writeFileSync(json, JSON.stringify(sessions, null, 1));
}
