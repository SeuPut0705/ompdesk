/**
 * Autopilot's check of a land candidate: the commit that merges the default branch, which moved on, into a green
 * cycle's commit. A clean textual merge is not a green one (the default branch's commits and the cycle's can break
 * each other), so the exact candidate commit is checked out on its own (a detached `git worktree add` in a temporary
 * folder, prepared as every new worktree is: `.worktreeinclude` and the repository's setup hook), the cycle's own
 * check command runs there under the setup supervisor, and the folder is removed again whatever happened. The command
 * is the one the cycle's tool calls ran and passed (it passed the bridge's guard there); the run's worktree path in it
 * points at the temporary checkout instead. Nothing here touches the run's worktree or the user's checkout.
 *
 * The files are exactly the candidate's; HEAD is then moved (`reset --soft`) to the default branch's tip it merges, so
 * the run's whole change shows as uncommitted. A check that only looks at what changed against HEAD (this repository's
 * `check:changed`) would find nothing on a clean checkout of the candidate and pass without checking anything; this
 * way it checks the run's change on top of the default branch as it is now.
 */
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promises as fs } from "original-fs";
import { withoutGitSelectors } from "../shared/git-env";
import { gitRaw } from "./local/git/exec";
import { prepareWorktree } from "./local/git/worktree-seed";
import { findGitBash } from "./setup/paths";
import { SUPERVISOR_STOPPED_CODE, spawnSupervised } from "./setup/supervisor";
import { shellSpawnEnv } from "./shell-env";
import { findOnPath } from "./spawn";

/** A check that runs this long is stopped and counts as failed (the candidate is not landed). */
export const LAND_CHECK_TIMEOUT_MS = 30 * 60_000;
const OUTPUT_TAIL = 2_000;
/** A line that starts an error report: JavaScript's error names, `error:`/`Error:` lines, a Python traceback. */
const ERROR_LINE = /^\s*(?:[A-Z][A-Za-z]*Error\b|Error:|error(?:\[[^\]]*\])?:|Traceback)/;
const ERROR_LINES = 12;

/**
 * What a refused land shows of the check: the first error and the lines under it, then the output's end. A runner that
 * lists every failing file after its errors (vitest groups files that failed the same way) filled the whole tail with
 * file names, and the reason was gone.
 */
export function checkExcerpt(output: string): string {
	const tail = output.slice(-OUTPUT_TAIL);
	const lines = output.split("\n");
	const first = lines.findIndex(line => ERROR_LINE.test(line));
	if (first < 0) return tail;
	const head = lines
		.slice(first, first + ERROR_LINES)
		.join("\n")
		.slice(0, OUTPUT_TAIL / 2);
	if (tail.includes(head)) return tail;
	return `${head}\n…\n${output.slice(-(OUTPUT_TAIL - head.length - 3))}`;
}

export interface LandCheckInput {
	/** The run's worktree: the repository the candidate lives in, and the path the command may name. */
	root: string;
	/** The main checkout (where `.worktreeinclude` copies from). */
	primary: string;
	/** The candidate commit, checked out exactly. */
	sha: string;
	/** The default branch tip the candidate merges: HEAD in the temporary checkout, so the run's change is uncommitted. */
	base?: string;
	command: string;
	timeoutMs?: number;
}

export interface LandCheck {
	ok: boolean;
	exitCode: number | null;
	timedOut: boolean;
	durationMs: number;
	/** The end of what the setup hook (when it failed) and the command printed. */
	tail: string;
}

/** The shell the agent's bash tool would run it in: bash (with pipefail, so `cmd | tail` fails when cmd does), else sh. */
function shellFor(command: string, env: NodeJS.ProcessEnv): { file: string; args: string[] } {
	if (process.platform === "win32") {
		const bash = findGitBash(env);
		if (bash) return { file: bash, args: ["-o", "pipefail", "-c", command] };
		return { file: env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", command] };
	}
	const bash = findOnPath(["bash"], env.PATH ?? "", process.platform === "darwin" ? "darwin" : "linux", ["/bin/bash"]);
	return bash ? { file: bash, args: ["-o", "pipefail", "-c", command] } : { file: "/bin/sh", args: ["-c", command] };
}

/** How a shell command can name a Windows path: escaped, as is, with forward slashes, as Git Bash's `/c/…`. */
function windowsSpellings(p: string): string[] {
	const native = path.win32.normalize(p);
	const drive = /^([A-Za-z]):(.*)$/.exec(native);
	const forms = (head: string, rest: string) => [
		`${head}${rest.replaceAll("\\", "\\\\")}`,
		`${head}${rest}`,
		`${head}${rest.replaceAll("\\", "/")}`,
	];
	if (!drive) return forms("", native);
	const [, letter = "", rest = ""] = drive;
	const msys = rest.replaceAll("\\", "/");
	return [letter.toUpperCase(), letter.toLowerCase()].flatMap(l => [...forms(`${l}:`, rest), `/${l}${msys}`]);
}

/**
 * The cycle's command with the run's worktree path pointed at the temporary checkout, written the way the command wrote
 * it. On Windows the agent's bash (Git Bash) reads an unquoted `C:\a\b` as `C:ab`, so a command that passed there names
 * the worktree as `C:/a/b`, `/c/a/b`, `C:\\a\\b` or a quoted `C:\a\b`, whatever spelling the run's root has.
 */
export function pointCommandAt(
	command: string,
	root: string,
	tree: string,
	platform: NodeJS.Platform = process.platform,
): string {
	if (platform !== "win32") return command.split(root).join(tree);
	const targets = windowsSpellings(tree);
	return windowsSpellings(root).reduce((text, spelling, i) => text.split(spelling).join(targets[i] ?? tree), command);
}

/**
 * The environment a session's omp (and so its bash tool) gets: the login shell's PATH and exports under the app's
 * own (`shellSpawnEnv`, as `SidecarManager` spawns). A Finder-launched app's own PATH is launchd's bare one, where the
 * cycle's `bun run check` was "command not found" and no green cycle ever landed over a moved default branch.
 */
async function sessionEnv(): Promise<NodeJS.ProcessEnv> {
	return withoutGitSelectors({ ...process.env, ...(await shellSpawnEnv()) });
}

async function run(command: string, cwd: string, timeoutMs: number): Promise<Omit<LandCheck, "durationMs">> {
	const { promise, resolve } = Promise.withResolvers<Omit<LandCheck, "durationMs">>();
	const chunks: Buffer[] = [];
	let timedOut = false;
	const env = await sessionEnv();
	const child = spawnSupervised({ ...shellFor(command, env), shell: false }, env, cwd);
	const timer = setTimeout(() => {
		timedOut = true;
		child.stdin?.end();
	}, timeoutMs);
	child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
	child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
	let done = false;
	const finish = (code: number | null, error?: string) => {
		if (done) return;
		done = true;
		clearTimeout(timer);
		const output = Buffer.concat(chunks).toString("utf8") + (error ? `${error}\n` : "");
		// A stopped check's own exit code is never taken as a pass.
		const exitCode = timedOut || code === SUPERVISOR_STOPPED_CODE ? null : code;
		resolve({ ok: !timedOut && exitCode === 0, exitCode, timedOut, tail: checkExcerpt(output) });
	};
	child.on("error", error => finish(null, error.message));
	child.on("close", code => finish(code));
	return promise;
}

/** Check `sha` out on its own, prepare it, run `command` there, and remove the checkout again. Never throws. */
export async function checkLandCandidate(input: LandCheckInput): Promise<LandCheck> {
	const started = Date.now();
	const elapsed = (result: Omit<LandCheck, "durationMs">): LandCheck => ({
		...result,
		durationMs: Date.now() - started,
	});
	const dir = await fs.mkdtemp(path.join(tmpdir(), "ompdesk-land-check-"));
	const tree = path.join(dir, "tree");
	// No hook of the repository runs on the way in (a post-checkout hook would run code before the check does).
	const noHooks = ["-c", `core.hooksPath=${path.join(dir, "no-hooks")}`];
	try {
		const added = await gitRaw(input.root, [...noHooks, "worktree", "add", "--detach", "-q", tree, input.sha], {
			timeoutMs: 120_000,
		});
		if (added.code !== 0) {
			return elapsed({ ok: false, exitCode: null, timedOut: false, tail: added.stderr.slice(-OUTPUT_TAIL) });
		}
		const prepared = await prepareWorktree(input.primary, tree);
		if (prepared.setup && !prepared.setup.ok) {
			return elapsed({
				ok: false,
				exitCode: prepared.setup.exitCode,
				timedOut: prepared.setup.timedOut,
				tail: `worktree setup (${prepared.setup.script}) failed:\n${prepared.setup.outputTail}`.slice(-OUTPUT_TAIL),
			});
		}
		if (input.base) {
			const reset = await gitRaw(tree, ["reset", "-q", "--soft", input.base], { timeoutMs: 60_000 });
			if (reset.code !== 0) {
				return elapsed({ ok: false, exitCode: null, timedOut: false, tail: reset.stderr.slice(-OUTPUT_TAIL) });
			}
		}
		const command = pointCommandAt(input.command, input.root, tree);
		return elapsed(await run(command, tree, input.timeoutMs ?? LAND_CHECK_TIMEOUT_MS));
	} catch (error) {
		return elapsed({
			ok: false,
			exitCode: null,
			timedOut: false,
			tail: error instanceof Error ? error.message : String(error),
		});
	} finally {
		await gitRaw(input.root, ["worktree", "remove", "--force", "--force", tree], { timeoutMs: 120_000 }).catch(
			() => undefined,
		);
		await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
		await gitRaw(input.root, ["worktree", "prune"], { timeoutMs: 60_000 }).catch(() => undefined);
	}
}
