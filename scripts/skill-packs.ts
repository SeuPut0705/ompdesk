/**
 * The three vendored skill packs (pstack, ECC, REA) and how each one is kept current. One table, one rule:
 *
 *   bun scripts/skill-packs.ts check [<name>] [--github-output]  pin vs newest eligible upstream (no files written)
 *   bun scripts/skill-packs.ts bump <name>    move <name>'s pin to its newest eligible upstream, resync, regenerate
 *                                             the notices and verify; exits 0 with nothing written when it is current
 *   bun scripts/skill-packs.ts version <name> the pinned version
 *
 * Eligible = public for at least bunfig.toml's `minimumReleaseAge` (3 days), the same hold `bun install` gives every
 * new dependency version. A git pack takes the newest commit touching its folder whose committer date is past the
 * hold (GitHub sets that date when it merges a pull request; a pushed commit carries the pusher's own date); REA
 * takes the highest stable `rea-agents` release whose registry publish time is past it.
 * `.github/workflows/skills-bump.yml` runs this daily and commits each bump that passes to main.
 */
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";

const ROOT = path.resolve(import.meta.dir, "..");
const WINDOWS = process.platform === "win32";

interface PackBase {
	name: string;
	/** The pin file, relative to the repository; only its `commit`/`version` lines are rewritten. */
	config: string;
	/** package.json script that regenerates the vendored copy from the pin. */
	sync: string;
	tests: string[];
	/** Some tests skip without an installed omp; the bump refuses to count them as passed then. */
	needsOmp: boolean;
}

interface GitPack extends PackBase {
	kind: "git";
	repo: string;
	/** The upstream folder the pack is copied from; only commits touching it count. */
	path: string;
	/** Upstream JSON file whose `version` names the release at a commit. */
	versionFile: string;
}

interface NpmPack extends PackBase {
	kind: "npm";
	package: string;
}

type Pack = GitPack | NpmPack;

const PACKAGING_TESTS = ["src/main/packaging-config.test.ts", "src/renderer/lib/command-registry-coverage.test.ts"];
/**
 * The built-in formal-verification skill (resources/omp-builtin/formal) is no pack's, so no bump rewrites it; these
 * keep any pack's bump from undoing it: a rival skill, a link to the pstack skills it replaced, its routing dropped,
 * or stock no longer listing it next to the bumped pack (the stock test needs omp, which the bump job installs).
 */
const FORMAL_TESTS = ["src/main/formal/pack-guard.test.ts", "src/main/formal/formal-stock.test.ts"];

const PACKS: Pack[] = [
	{
		kind: "git",
		name: "pstack",
		config: "resources/omp-builtin/pstack/pstack-config.json",
		repo: "cursor/plugins",
		path: "pstack",
		versionFile: "pstack/plugin.json",
		sync: "sync:pstack",
		tests: [
			"src/main/pstack/pack-drift.test.ts",
			"src/main/bridge-pstack.test.ts",
			...PACKAGING_TESTS,
			...FORMAL_TESTS,
		],
		needsOmp: true,
	},
	{
		kind: "git",
		name: "ecc",
		config: "resources/omp-builtin/ecc/ecc-config.json",
		repo: "affaan-m/ECC",
		path: "pi/core",
		versionFile: "pi/core/package.json",
		sync: "sync:ecc",
		tests: ["src/main/ecc/pack-drift.test.ts", "src/main/ecc/ecc-stock.test.ts", ...PACKAGING_TESTS, ...FORMAL_TESTS],
		needsOmp: true,
	},
	{
		kind: "npm",
		name: "rea",
		config: "resources/omp-builtin/rea/rea-config.json",
		package: "rea-agents",
		sync: "sync:rea-skill",
		tests: [
			"src/main/mcp-hub-rea.test.ts",
			"src/main/builtin-mcp.test.ts",
			"src/main/builtin-mcp-spawn.test.ts",
			"src/shared/builtin-mcp.test.ts",
			"src/renderer/components/settings/BuiltinReaRow.test.tsx",
			...PACKAGING_TESTS,
			...FORMAL_TESTS,
		],
		needsOmp: true,
	},
];

const Pin = z.object({
	commit: z.string().optional(),
	version: z.string(),
	curatedTools: z.array(z.string()).optional(),
});
const Versioned = z.object({ version: z.string() });
const PublishTimes = z.record(z.string(), z.string());
const RpcReply = z.object({
	id: z.number().optional(),
	result: z.unknown().optional(),
	error: z.object({ message: z.string() }).optional(),
});
const ToolsPage = z.object({ tools: z.array(z.object({ name: z.string() })), nextCursor: z.string().optional() });

/** bunfig.toml's `[install] minimumReleaseAge` in ms: one hold for dependencies and skill packs alike. */
const MIN_AGE_MS = (() => {
	const match = /^minimumReleaseAge\s*=\s*(\d+)/m.exec(fs.readFileSync(path.join(ROOT, "bunfig.toml"), "utf8"));
	if (!match) throw new Error("bunfig.toml has no minimumReleaseAge");
	return Number(match[1]) * 1000;
})();

interface Release {
	/** What the pin file stores: a commit sha (git) or the version itself (npm). */
	ref: string;
	version: string;
	at: Date;
}

interface Status {
	pack: Pack;
	pinned: Release;
	/** Newest upstream release past the hold, when newer than the pin. */
	eligible: Release | null;
	/** Newest upstream release still inside the hold, when newer than the pin and `eligible`. */
	held: Release | null;
}

function readPin(pack: Pack): z.infer<typeof Pin> {
	return Pin.parse(JSON.parse(fs.readFileSync(path.join(ROOT, pack.config), "utf8")));
}

/** Rewrite only the pin's top-level `commit`/`version` lines, so the rest of the hand-formatted file stays. */
function writePin(pack: Pack, release: Release): void {
	const file = path.join(ROOT, pack.config);
	let text = fs.readFileSync(file, "utf8");
	for (const [key, value] of pack.kind === "git"
		? [
				["commit", release.ref],
				["version", release.version],
			]
		: [["version", release.version]]) {
		const pattern = new RegExp(`^(\\t"${key}": )"[^"]*"`, "m");
		if (!pattern.test(text)) throw new Error(`${pack.config} has no top-level "${key}"`);
		text = text.replace(pattern, `$1"${value}"`);
	}
	fs.writeFileSync(file, text);
}

function gitStatus(pack: GitPack, cutoff: Date): Status {
	const pin = readPin(pack);
	if (!pin.commit) throw new Error(`${pack.config} has no commit`);
	const pinned = pin.commit;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${pack.name}-pin-`));
	const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
	const release = (ref: string): Release => ({
		ref,
		version: Versioned.parse(JSON.parse(git("show", `${ref}:${pack.versionFile}`))).version,
		at: new Date(git("show", "-s", "--format=%cI", ref)),
	});
	/** Only a descendant of the pin is newer: a pin past the folder's last change stays. */
	const newerThanPin = (ref: string) => {
		if (!ref || ref === pinned) return false;
		try {
			execFileSync("git", ["-C", dir, "merge-base", "--is-ancestor", pinned, ref], { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	};
	try {
		execFileSync("git", ["clone", "-q", "--filter=blob:none", "--bare", `https://github.com/${pack.repo}`, dir]);
		const eligibleRef = git("log", "-1", "--format=%H", `--until=${cutoff.toISOString()}`, "HEAD", "--", pack.path);
		const headRef = git("log", "-1", "--format=%H", "HEAD", "--", pack.path);
		return {
			pack,
			pinned: { ref: pinned, version: pin.version, at: new Date(git("show", "-s", "--format=%cI", pinned)) },
			eligible: newerThanPin(eligibleRef) ? release(eligibleRef) : null,
			held: headRef !== eligibleRef && newerThanPin(headRef) ? release(headRef) : null,
		};
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function npmStatus(pack: NpmPack, cutoff: Date): Status {
	const pin = readPin(pack);
	const times = PublishTimes.parse(
		JSON.parse(execFileSync("npm", ["view", pack.package, "time", "--json"], { encoding: "utf8", shell: WINDOWS })),
	);
	const newer = Object.entries(times)
		.filter(([version]) => /^\d+\.\d+\.\d+$/.test(version) && Bun.semver.order(version, pin.version) > 0)
		.map(([version, time]): Release => ({ ref: version, version, at: new Date(time) }))
		.sort((a, b) => Bun.semver.order(b.version, a.version));
	const eligible = newer.find(release => release.at <= cutoff) ?? null;
	return {
		pack,
		pinned: { ref: pin.version, version: pin.version, at: new Date(times[pin.version] ?? 0) },
		eligible,
		held: newer[0] && newer[0] !== eligible ? newer[0] : null,
	};
}

function packStatus(pack: Pack): Status {
	const cutoff = new Date(Date.now() - MIN_AGE_MS);
	return pack.kind === "git" ? gitStatus(pack, cutoff) : npmStatus(pack, cutoff);
}

function describe({ pack, pinned, eligible, held }: Status): string {
	const label = (release: Release) => {
		const at = release.at.toISOString().slice(0, 16);
		return pack.kind === "git"
			? `${release.version} (${release.ref.slice(0, 7)}, ${at}Z)`
			: `${release.version} (${at}Z)`;
	};
	const lines = [`${pack.name}: pinned ${label(pinned)}`];
	lines.push(eligible ? `  newer and past the hold: ${label(eligible)}` : "  current: nothing newer past the hold");
	if (held) {
		const from = new Date(held.at.getTime() + MIN_AGE_MS).toISOString().slice(0, 16);
		lines.push(`  held back: ${label(held)}, eligible from ${from}Z`);
	}
	return lines.join("\n");
}

function packNamed(name: string): Pack {
	const pack = PACKS.find(entry => entry.name === name);
	if (!pack) throw new Error(`unknown pack "${name}" (known: ${PACKS.map(entry => entry.name).join(", ")})`);
	return pack;
}

function run(command: string, args: string[]): void {
	console.log(`$ ${command} ${args.join(" ")}`);
	execFileSync(command, args, { cwd: ROOT, stdio: "inherit", shell: WINDOWS });
}

/** The relay mounts the curated tools by name: the new release's catalog must still hold every one. */
async function verifyReaCatalog(pack: NpmPack, version: string): Promise<void> {
	const curated = readPin(pack).curatedTools ?? [];
	const child = spawn(WINDOWS ? "npx.cmd" : "npx", ["-y", `${pack.package}@${version}`, "mcp"], {
		stdio: ["pipe", "pipe", "inherit"],
		shell: WINDOWS,
	});
	const waiting = new Map<number, (reply: z.infer<typeof RpcReply>) => void>();
	createInterface({ input: child.stdout }).on("line", line => {
		const reply = RpcReply.parse(JSON.parse(line));
		if (reply.id !== undefined) waiting.get(reply.id)?.(reply);
	});
	let next = 0;
	const request = (method: string, params: unknown) =>
		new Promise<unknown>((resolve, reject) => {
			const id = ++next;
			const timer = setTimeout(() => reject(new Error(`${pack.package} ${method} timed out`)), 120_000);
			waiting.set(id, reply => {
				clearTimeout(timer);
				if (reply.error) reject(new Error(`${pack.package} ${method}: ${reply.error.message}`));
				else resolve(reply.result);
			});
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	try {
		await request("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "ompdesk-skill-packs", version: "1" },
		});
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
		const names: string[] = [];
		let cursor: string | undefined;
		do {
			const page = ToolsPage.parse(await request("tools/list", cursor ? { cursor } : {}));
			names.push(...page.tools.map(tool => tool.name));
			cursor = page.nextCursor;
		} while (cursor);
		const missing = curated.filter(tool => !names.includes(tool));
		if (missing.length)
			throw new Error(`${pack.package}@${version} dropped curated tools: ${missing.join(", ")} (rea-config.json)`);
		console.log(
			`${pack.package}@${version}: all ${curated.length} curated tools are in its ${names.length}-tool catalog`,
		);
	} finally {
		child.kill();
	}
}

async function bump(pack: Pack): Promise<void> {
	if (pack.needsOmp && !Bun.which("omp")) throw new Error(`${pack.name}'s stock tests need an installed omp`);
	const status = packStatus(pack);
	console.log(describe(status));
	if (!status.eligible) return;
	writePin(pack, status.eligible);
	run("bun", ["run", pack.sync]);
	if (pack.kind === "npm") await verifyReaCatalog(pack, status.eligible.version);
	run("bun", ["run", "gen:licenses"]);
	run("bunx", ["vitest", "run", ...pack.tests]);
	run("bun", ["run", "licenses:check"]);
	console.log(`bumped ${pack.name} to ${status.eligible.version}`);
}

const [command, name] = process.argv.slice(2);
if (command === "check") {
	const statuses = (name && !name.startsWith("--") ? [packNamed(name)] : PACKS).map(packStatus);
	for (const status of statuses) console.log(describe(status));
	const outdated = statuses.filter(status => status.eligible).map(status => status.pack.name);
	console.log(outdated.length ? `outdated: ${outdated.join(" ")}` : "every pack is current");
	if (process.argv.includes("--github-output") && process.env.GITHUB_OUTPUT)
		fs.appendFileSync(process.env.GITHUB_OUTPUT, `outdated=${outdated.join(" ")}\n`);
} else if (command === "bump" && name) {
	await bump(packNamed(name));
} else if (command === "version" && name) {
	console.log(readPin(packNamed(name)).version);
} else {
	throw new Error("usage: bun scripts/skill-packs.ts check [<name>] [--github-output] | bump <name> | version <name>");
}
