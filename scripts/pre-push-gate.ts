/**
 * The pre-push gate (`.githooks/pre-push` runs it for every `git push` of this repository, whoever pushes: a person,
 * `scripts/agent-commit.sh --push`, a session's own `git push`): the static checks CI's `static` job runs, on exactly
 * the commits being pushed, before they leave the computer. A push that CI's biome, typecheck, surface policy or
 * fix-commit rule would refuse is refused here in about a minute instead of in a red run twenty minutes later.
 *
 *   fix-tests  scripts/lint-fix-tests.mjs on the pushed range (always; well under a second)
 *   biome      biome check on the range's changed files
 *   surfaces   scripts/lint-surfaces.mjs
 *   types      tsc --noEmit --incremental, on the cache `check:types` keeps in place; no `vitest` slot (see `tscCommand`)
 *   budget     the phone's first-screen JavaScript budget (scripts/check-main-bundle.ts), only for a renderer change and
 *              only when this checkout's `out/` was built from exactly the pushed inputs, which means the build's own
 *              check already passed; a fresh build takes minutes, so otherwise the output says it was skipped
 *
 * Only the checks the change needs run: a push of docs, native Rust or workflows runs fix-tests alone.
 *
 * The checks read exactly the pushed commit. In a working tree that holds those files unchanged (a worktree of one's
 * own, after the commit) they run in place, on the warm typecheck cache `bun run check:types` keeps and the `out/`
 * `bun run build` left. Otherwise (the shared checkout holds other sessions' unfinished edits, which would refuse a
 * push that is fine) they run on a copy in `<git dir>/ompdesk-gate/tree` that moves from one pushed commit to the next
 * by the files that differ, so its own typecheck cache stays warm too; a mutex keeps two pushes of one checkout from
 * moving it at once. A gate that cannot run its checks (no node_modules, a failed extract) says SKIPPED and lets the
 * push through: a broken gate must never make every push impossible.
 *
 * `git push --no-verify` skips it, a person's call; an agent never does.
 */
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { processAlive } from "../src/main/process-alive";
import { withoutGitSelectors } from "../src/shared/git-env";
import { inputHash, rebuildReason } from "./build-cache";
import { biomeFiles, changedScope } from "./changed-scope";

const ZERO_SHA = /^0+$/;
const SHA = /[0-9a-f]{40}/g;
const MS_PER_SECOND = 1000;

export interface PushRef {
	localRef: string;
	localSha: string;
	remoteRef: string;
	remoteSha: string;
}

/** The lines git feeds a pre-push hook: `<local ref> <local sha> <remote ref> <remote sha>`. */
export function parsePushRefs(stdin: string): PushRef[] {
	return stdin
		.split("\n")
		.map(line => line.trim().split(/\s+/))
		.filter(parts => parts.length === 4)
		.map(([localRef = "", localSha = "", remoteRef = "", remoteSha = ""]) => ({
			localRef,
			localSha,
			remoteRef,
			remoteSha,
		}));
}

/** A ref the gate has nothing to check on: a deleted branch, a tag. */
export function isGated(ref: PushRef): boolean {
	return !ZERO_SHA.test(ref.localSha) && !ref.localRef.startsWith("refs/tags/");
}

export interface Plan {
	biome: string[];
	/** The surface policy: `only` names the files its per-file rules read (null: the whole tree); null when it has nothing to read. */
	surfaces: { only: string[] | null } | null;
	types: boolean;
	/** A renderer change: the first-screen budget applies. */
	budget: boolean;
}

/** A change to a lint itself or to the duplicate rules' allow list: the per-file rules run on the whole tree. */
const LINT_SOURCE = /^scripts\/lint-[^/]+\.(?:mjs|json)$/;
/** What the surface policy reads: the app's TypeScript and the gui-bridge. */
const SURFACE_INPUT = /^(?:src\/.*\.tsx?|resources\/gui-bridge\/.*\.ts)$/;
/** What the typechecker reads: TypeScript, the JSON it imports and the configuration that decides how. */
const TYPE_INPUT = /\.[cm]?tsx?$|^tsconfig[^/]*\.json$|^package\.json$|^bun\.lock$|^(?:src|e2e|scripts)\/.*\.json$/;

/** Which checks a change needs, from its changed files (repository-relative, forward slashes). */
export function planGate(files: readonly string[]): Plan {
	const scope = changedScope(files);
	const lintChanged = scope.files.some(file => LINT_SOURCE.test(file));
	const surfaceFiles = scope.files.filter(file => SURFACE_INPUT.test(file));
	return {
		biome: biomeFiles(scope.files),
		surfaces: lintChanged || surfaceFiles.length > 0 ? { only: lintChanged ? null : surfaceFiles } : null,
		types: scope.files.some(file => TYPE_INPUT.test(file)),
		budget: scope.files.some(file => /^src\/(?:renderer|shared)\//.test(file)),
	};
}

/** What the checks read: the top-level files, these folders and the JSON the code imports from `native/`. */
const COPIED_DIRS = ["src", "e2e", "scripts", "resources"];
const INPUT_PATHS = [...COPIED_DIRS, ":(glob)native/**/*.json", ":(glob)*"];
/** What a move of the copy leaves alone. */
const KEPT_IN_COPY = ["node_modules", ".gate-sha", ".gate.tsbuildinfo"];

/** Whether the copy holds `file` (repository-relative, forward slashes). */
export function isCopied(file: string): boolean {
	if (file.startsWith("native/")) return file.endsWith(".json");
	return !file.includes("/") || COPIED_DIRS.some(dir => file.startsWith(`${dir}/`));
}

const git = (cwd: string, args: string[]): Buffer =>
	execFileSync("git", args, {
		cwd,
		env: withoutGitSelectors(process.env),
		maxBuffer: 1 << 30,
		stdio: ["ignore", "pipe", "pipe"],
	});
const gitText = (cwd: string, args: string[]): string => git(cwd, args).toString("utf8").trim();
const hasCommit = (cwd: string, sha: string): boolean => {
	try {
		git(cwd, ["cat-file", "-e", `${sha}^{commit}`]);
		return true;
	} catch {
		return false;
	}
};

/** The base a pushed ref is measured from: what the remote already has, else where it left origin/main. */
export function rangeBase(cwd: string, ref: PushRef): string {
	if (!ZERO_SHA.test(ref.remoteSha) && hasCommit(cwd, ref.remoteSha)) return ref.remoteSha;
	try {
		return gitText(cwd, ["merge-base", ref.localSha, "origin/main"]);
	} catch {
		return `${ref.localSha}~1`;
	}
}

function extract(cwd: string, tree: string, sha: string, paths: string[]): void {
	const chunk = 400;
	for (let at = 0; at < paths.length; at += chunk) {
		const tar = git(cwd, ["archive", "--format=tar", sha, "--", ...paths.slice(at, at + chunk)]);
		execFileSync("tar", ["-x", "-C", tree], { input: tar, maxBuffer: 1 << 30 });
	}
}

/** The copy's paths of `sha`: the folders above, the files at its top level and `native/`'s JSON. */
function copiedPaths(cwd: string, sha: string): string[] {
	const paths: string[] = [];
	for (const line of gitText(cwd, ["ls-tree", sha]).split("\n")) {
		const [meta = "", name = ""] = line.split("\t");
		if (COPIED_DIRS.includes(name) || meta.split(" ")[1] === "blob") paths.push(name);
	}
	for (const file of gitText(cwd, ["ls-tree", "-r", "--name-only", sha, "--", "native"]).split("\n")) {
		if (file && isCopied(file)) paths.push(file);
	}
	return paths;
}

/**
 * Make `tree` hold `sha`'s files: all of them the first time (or after a move that failed half way), afterwards only
 * the files that differ from the commit it held, so the typecheck's cache and the node_modules link survive.
 */
export function syncTree(cwd: string, tree: string, sha: string): void {
	fs.mkdirSync(tree, { recursive: true });
	const marker = path.join(tree, ".gate-sha");
	const held = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim() : "";
	if (held === sha) return;
	fs.rmSync(marker, { force: true });
	if (held && hasCommit(cwd, held)) {
		const entries = git(cwd, ["diff", "--no-renames", "--name-status", "-z", held, sha]).toString("utf8").split("\0");
		const changed: string[] = [];
		for (let at = 0; at + 1 < entries.length; at += 2) {
			const file = entries[at + 1] ?? "";
			if (!isCopied(file)) continue;
			if (entries[at] === "D") fs.rmSync(path.join(tree, file), { force: true });
			else changed.push(file);
		}
		extract(cwd, tree, sha, changed);
	} else {
		for (const entry of fs.readdirSync(tree)) {
			if (!KEPT_IN_COPY.includes(entry)) fs.rmSync(path.join(tree, entry), { recursive: true, force: true });
		}
		extract(cwd, tree, sha, copiedPaths(cwd, sha));
	}
	fs.writeFileSync(marker, `${sha}\n`);
}

/** Run `work` while holding the directory `lock`: wait for a live holder, take over a dead one's. */
export async function withMutex<T>(lock: string, work: () => Promise<T>, onWait: () => void): Promise<T> {
	for (let told = false; ; told = true) {
		try {
			fs.mkdirSync(lock);
			fs.writeFileSync(path.join(lock, "pid"), String(process.pid));
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const pid = Number(fs.readFileSync(path.join(lock, "pid"), "utf8").trim() || 0);
			if (!pid || !processAlive(pid)) {
				fs.rmSync(lock, { recursive: true, force: true });
				continue;
			}
			if (!told) onWait();
			await sleep(MS_PER_SECOND);
		}
	}
	try {
		return await work();
	} finally {
		fs.rmSync(lock, { recursive: true, force: true });
	}
}

interface StepResult {
	label: string;
	code: number;
	ms: number;
	output: string;
}

function runStep(label: string, command: string[], cwd: string): Promise<StepResult> {
	const started = performance.now();
	const { promise, resolve } = Promise.withResolvers<StepResult>();
	const [file = "", ...args] = command;
	const child = spawn(file, args, { cwd, env: withoutGitSelectors(process.env), stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	const collect = (chunk: Buffer) => {
		output += chunk;
	};
	child.stdout.on("data", collect);
	child.stderr.on("data", collect);
	const done = (code: number, extra = "") =>
		resolve({ label, code, ms: performance.now() - started, output: output + extra });
	child.on("error", error => done(1, `${error.message}\n`));
	child.on("close", code => done(code ?? 1));
	return promise;
}

const seconds = (ms: number) => `${(ms / MS_PER_SECOND).toFixed(1)}s`;
const say = (line: string) => console.log(`[pre-push] ${line}`);

/**
 * Whether this working tree holds exactly the files the checks read of the pushed commit: then they run in it (a build's
 * `out/` and the typecheck's cache are warm here), else on a copy of the commit.
 */
export function worktreeHolds(root: string, sha: string): boolean {
	try {
		git(root, ["diff", "--quiet", sha, "--", ...INPUT_PATHS]);
		return gitText(root, ["ls-files", "--others", "--exclude-standard", "--", ...COPIED_DIRS]) === "";
	} catch {
		return false;
	}
}

/**
 * The first-screen budget's verdict without a build: `out/` carries the pushed inputs' stamp (written only after
 * `check-main-bundle.ts` passed on it) when the working tree is the pushed commit and `bun run build` left `out/` as it is.
 */
export function budgetNote(root: string, inPlace: boolean): string {
	if (!inPlace)
		return "budget skipped: this working tree is not the pushed commit, and only a build of its inputs counts";
	const reason = rebuildReason(root, inputHash(root, process.env), process.env);
	return reason
		? `budget skipped: out/ is not built from these inputs (${reason}); \`bun run build\` checks it, CI's build job always does`
		: "budget ok: out/ was built from exactly these inputs and passed the first-screen budget";
}

/** The static checks, run in `dir`; `types` is the typecheck's command. */
function staticChecks(plan: Plan, dir: string, modules: string, types: string[]): Array<Promise<StepResult>> {
	const steps: Array<Promise<StepResult>> = [];
	if (plan.biome.length > 0) {
		const biome = path.join(modules, "@biomejs", "biome", "bin", "biome");
		const command = [process.execPath, biome, "check", "--no-errors-on-unmatched", ...plan.biome];
		steps.push(runStep(`biome check on ${plan.biome.length} file(s)`, command, dir));
	}
	if (plan.surfaces) {
		const files = plan.surfaces.only ? ["--only", ...plan.surfaces.only] : [];
		const label = plan.surfaces.only
			? `surface policy (${plan.surfaces.only.length} file(s) and the duplicate rules)`
			: "surface policy (whole tree)";
		steps.push(runStep(label, ["node", "scripts/lint-surfaces.mjs", ...files], dir));
	}
	if (plan.types) steps.push(runStep("typecheck (incremental)", types, dir));
	return steps;
}

/**
 * The typecheck, one node process on its own incremental cache, with no slot of the machine's lock (`bun run check:types`
 * takes a `vitest` slot): on 14 Nov 2026 five gate runs held the slot 35 to 53 s each and waited 111 to 1,227 s for it
 * behind other sessions' full test runs, so the queue was the whole cost of a push.
 */
function tscCommand(modules: string, buildInfo: string): string[] {
	return [
		"node",
		path.join(modules, "typescript", "bin", "tsc"),
		"--noEmit",
		"--incremental",
		"--tsBuildInfoFile",
		buildInfo,
	];
}

/** The checks on a copy of `sha` (see the header); throws when the copy cannot be made. */
async function copyChecks(root: string, tree: string, sha: string, plan: Plan): Promise<StepResult[]> {
	const modules = path.join(root, "node_modules");
	const synced = performance.now();
	syncTree(root, tree, sha);
	const link = path.join(tree, "node_modules");
	if (!fs.existsSync(link)) fs.symlinkSync(modules, link, "junction");
	say(`copy of ${sha.slice(0, 9)} ready in ${seconds(performance.now() - synced)}`);
	return Promise.all(staticChecks(plan, tree, link, tscCommand(link, ".gate.tsbuildinfo")));
}

async function gate(root: string, gitDir: string, ref: PushRef): Promise<number> {
	const started = performance.now();
	const base = rangeBase(root, ref);
	const files = gitText(root, ["diff", "--no-renames", "--name-only", "--diff-filter=ACMR", base, ref.localSha])
		.split("\n")
		.filter(Boolean);
	const plan = planGate(files);
	const range = `${base}..${ref.localSha}`;
	say(
		`${ref.localRef} -> ${ref.remoteRef}: ${files.length} changed file(s), ${range.replaceAll(SHA, sha => sha.slice(0, 9))}`,
	);

	const notes: string[] = [];
	const results: StepResult[] = [
		await runStep("fix commits carry a test", [process.execPath, "scripts/lint-fix-tests.mjs", range], root),
	];
	const gateDir = path.join(gitDir, "ompdesk-gate");
	fs.mkdirSync(gateDir, { recursive: true });
	const inPlace =
		plan.biome.length > 0 || plan.surfaces || plan.types || plan.budget ? worktreeHolds(root, ref.localSha) : false;
	if (plan.biome.length > 0 || plan.surfaces || plan.types) {
		const modules = path.join(root, "node_modules");
		const wait = () => say("another push of this checkout is running its gate; waiting for it");
		try {
			if (!fs.existsSync(modules)) throw new Error(`no node_modules in ${root}; run .ompdesk/worktree-setup`);
			if (inPlace) {
				say("this working tree is the pushed commit: checking it in place");
				results.push(
					...(await Promise.all(
						staticChecks(
							plan,
							root,
							modules,
							tscCommand(modules, path.join("node_modules", ".cache", "tsc", "check.tsbuildinfo")),
						),
					)),
				);
			} else {
				say("this working tree differs from the pushed commit: checking a copy of the commit");
				const tree = path.join(gateDir, "tree");
				results.push(
					...(await withMutex(path.join(gateDir, "lock"), () => copyChecks(root, tree, ref.localSha, plan), wait)),
				);
			}
		} catch (error) {
			notes.push(
				`SKIPPED biome, surfaces and types: the gate could not run them (${(error as Error).message}); the push goes on`,
			);
		}
	}
	if (plan.budget) notes.push(budgetNote(root, inPlace));

	for (const result of results)
		say(`${result.code === 0 ? "ok     " : "FAILED "}${result.label} (${seconds(result.ms)})`);
	for (const note of notes) say(note);
	const failed = results.filter(result => result.code !== 0);
	for (const result of failed) console.error(`\n[pre-push] ${result.label}:\n${result.output.trimEnd()}`);
	say(`${failed.length > 0 ? "refused" : "passed"} in ${seconds(performance.now() - started)}`);
	if (failed.length === 0) return 0;
	fs.writeFileSync(path.join(gateDir, "refused"), `${ref.localSha}\n`);
	console.error(
		"[pre-push] Fix it, commit, push again. `git push --no-verify` skips the gate: a person's call, never an agent's.",
	);
	return 1;
}

if (import.meta.main) {
	const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
	const gitDir = path.resolve(root, gitText(root, ["rev-parse", "--absolute-git-dir"]));
	let code = 0;
	for (const ref of parsePushRefs(fs.readFileSync(0, "utf8")).filter(isGated)) code ||= await gate(root, gitDir, ref);
	process.exit(code);
}
