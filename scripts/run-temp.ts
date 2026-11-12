/**
 * One temp folder per test run, on every platform, for Playwright (`playwright.config.ts`) and Vitest
 * (`vitest.config.ts`) alike. TEMP, TMP and TMPDIR of the runner point at `ompdesk-run-<pid>-XXXXXX`, so its
 * workers, the apps, fakes and real omps they start, and Playwright's own files all write there: every `mkdtemp` a
 * test never removes, every profile of a worker that crashed before its `afterEach`. The folder goes with every
 * process still naming it when the runner exits or, after a runner that was killed, when the next runner of either
 * kind starts. One Mac's temp folder held 19,313 entries of test runs before this, a Windows PC 289 app profiles
 * and 405 WebKit profiles after a day.
 *
 * The folder's name carries its owner's pid, so claiming it is one atomic `mkdtemp`: there is no moment in which a
 * folder exists without an owner for a sweep to misjudge. A reused pid only keeps a dead run's folder until that
 * process ends too; it never makes a live run's look dead.
 */
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { windowsProcesses } from "../e2e/process-tree";
import { processAlive } from "../src/main/process-alive";

/** The run's own temp folder, set once by the runner and inherited by everything it starts. */
export const RUN_TEMP_ENV = "OMPDESK_RUN_TEMP";
/** The temp folder the run started with, for what outlives a run (a compiled helper's cache, opt-in evidence). */
export const BASE_TEMP_ENV = "OMPDESK_BASE_TEMP";
const NAME = /^ompdesk-run-(\d+)-/;
/** Chromium on macOS asks this before the system for its temp folder (the app's `.com.seuput.ompdesk.XXXXXX`). */
const TEMP_VARS = ["TEMP", "TMP", "TMPDIR", "MAC_CHROMIUM_TMPDIR"] as const;

/**
 * Where run folders are made. macOS's per-user temp folder (`/var/folders/<2>/<30>/T`) takes 48 of the 103 bytes a
 * unix socket path may have, and a run folder inside it would leave the control socket's short fallback
 * (`ompdesk-<uid>-<tag>/control.sock`, 38 bytes) and Chromium's singleton socket (43) no room; `/private/tmp` is 12
 * bytes, the real path of `/tmp`, on the same volume, and a `mkdtemp` folder there is the user's alone (0700).
 */
export function runTempParent(base: string, platform: NodeJS.Platform = process.platform): string {
	return platform === "darwin" && /^\/(private\/)?var\/folders\//.test(base) ? "/private/tmp" : base;
}

/** The pid in a run folder's name; null for any other entry. */
export function runOwner(dir: string): number | null {
	const pid = NAME.exec(path.basename(dir))?.[1];
	return pid ? Number(pid) : null;
}

/**
 * Gives this run its temp folder and points the temp variables at it; returns it. The first call in a runner makes
 * the folder, clears those of runs that died and arranges for this one to go when the process exits, however the
 * run went (a listing, a setup that failed, tests that crashed). A worker that loads the runner's config again, and a
 * run started inside another run (a test that runs Playwright), inherit the folder and leave it to its owner.
 */
export function claimRunTemp(): string {
	const claimed = process.env[RUN_TEMP_ENV];
	if (claimed && fs.existsSync(claimed)) return claimed;
	const base = os.tmpdir();
	const dir = fs.mkdtempSync(path.join(runTempParent(base), `ompdesk-run-${process.pid}-`));
	process.env[BASE_TEMP_ENV] = base;
	process.env[RUN_TEMP_ENV] = dir;
	for (const name of TEMP_VARS) process.env[name] = dir;
	sweepStaleRunTemps(path.dirname(dir));
	process.once("exit", () => releaseRunTemp(dir, base));
	return dir;
}

/**
 * The temp folder outside this run's own, for what is kept across runs and for a test that needs the real one (a
 * path-length case, a rename across devices).
 */
export const baseTemp = (): string => process.env[BASE_TEMP_ENV] ?? os.tmpdir();

/** A `mkdtemp` tail, a hex id or a number at the end of a name, before its extension. */
const RANDOM_TAIL = /[-_.](?:(?=[a-z]*[A-Z0-9])[A-Za-z0-9]{6,}|(?=[a-f]*\d)[0-9a-f]{4,}|\d+)$/;

/** `ompdesk-wake-a1B2c3` and `ompdesk-wake-Zz9Yy8` are one kind of entry, `ompdesk-wake-*`. */
function entryKind(name: string): string {
	const extension = /\.[a-z]{2,5}$/.exec(name)?.[0] ?? "";
	let stem = name.slice(0, name.length - extension.length);
	const whole = stem;
	for (let tail = RANDOM_TAIL.exec(stem); tail; tail = RANDOM_TAIL.exec(stem)) stem = stem.slice(0, tail.index);
	return stem === whole ? name : `${stem}-*${extension}`;
}

/** `names` counted by kind, most frequent first: what a listing of thousands of temp entries comes down to. */
export function groupEntries(names: readonly string[]): [kind: string, count: number][] {
	const counts = new Map<string, number>();
	for (const name of names) counts.set(entryKind(name), (counts.get(entryKind(name)) ?? 0) + 1);
	return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function processesNaming(dir: string): number[] {
	if (process.platform === "win32") {
		const needle = dir.toLowerCase();
		return windowsProcesses()
			.filter(entry => entry.commandLine?.toLowerCase().includes(needle))
			.map(entry => entry.pid);
	}
	return execFileSync("ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
		.split("\n")
		.filter(line => line.includes(dir))
		.map(line => Number.parseInt(line, 10));
}

/**
 * Ends every process whose command line names `dir` (on Windows with what it started), then removes `dir`: a
 * detached fake server, an app a crashed worker left. An empty folder has nothing to hold it and is removed unasked.
 */
export function clearRunTemp(dir: string): void {
	if (fs.readdirSync(dir).length > 0) {
		for (const pid of processesNaming(dir)) {
			if (pid === process.pid) continue;
			if (process.platform === "win32")
				spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
			else
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// Gone meanwhile, or another user's.
				}
		}
	}
	fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/**
 * The end of a run: removes its folder and, when tests left something in it, says what on stderr (a reporter may own
 * stdout). On a hosted runner, where nothing else runs, it also counts what appeared in the real temp folder
 * meanwhile: writers that ask the system and not the environment.
 */
export function releaseRunTemp(dir: string, base: string): void {
	const made = fs.statSync(dir, { throwIfNoEntry: false });
	if (!made) return;
	const left = fs.readdirSync(dir);
	let outcome = "removed";
	try {
		clearRunTemp(dir);
	} catch (error) {
		outcome = `still held (${(error as NodeJS.ErrnoException).code ?? error}), the next run removes it`;
	}
	const hosted = Boolean(process.env.GITHUB_ACTIONS);
	if (left.length === 0 && outcome === "removed" && !hosted) return;
	const kinds = (names: readonly string[]) =>
		groupEntries(names)
			.slice(0, 12)
			.map(([kind, count]) => `${count} ${kind}`)
			.join(", ");
	const lines = [`[run-temp] ${dir} ${outcome}; the run left ${left.length} entries in it: ${kinds(left)}`];
	if (hosted) {
		const outside = fs.readdirSync(base).filter(name => {
			const entry = fs.statSync(path.join(base, name), { throwIfNoEntry: false });
			return entry !== undefined && entry.birthtimeMs >= made.birthtimeMs;
		});
		// By name, not by kind: each one is a writer to look for.
		lines.push(
			`[run-temp] ${outside.length} entries appeared in ${base} during the run: ${outside.slice(0, 40).join(", ")}`,
		);
	}
	// Synchronously: the process is exiting.
	fs.writeSync(2, `${lines.join("\n")}\n`);
}

export interface SweepDeps {
	alive(pid: number): boolean;
	clear(dir: string): void;
}

/**
 * Clears the run folders under `parent` whose runner no longer runs, whichever runner made them. Never a live run's,
 * so never this run's own or the run this one is nested in. Returns the folders cleared.
 */
export function sweepStaleRunTemps(
	parent: string = runTempParent(baseTemp()),
	deps: SweepDeps = { alive: processAlive, clear: clearRunTemp },
): string[] {
	const cleared: string[] = [];
	for (const name of fs.readdirSync(parent)) {
		const owner = runOwner(name);
		if (owner === null || deps.alive(owner)) continue;
		const dir = path.join(parent, name);
		try {
			deps.clear(dir);
			cleared.push(dir);
		} catch {
			// Still held, or another user's: the next run tries again.
		}
	}
	return cleared;
}
