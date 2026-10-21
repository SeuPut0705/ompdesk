import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { windowsProcesses } from "./process-tree";

/** The run's own temp folder, set once by the runner (playwright.config.ts) and inherited by its workers and apps. */
export const RUN_TEMP_ENV = "OMPDESK_E2E_RUN_TEMP";
/** The temp folder the run started with, for what outlives a run (a compiled helper's cache, opt-in evidence). */
export const BASE_TEMP_ENV = "OMPDESK_E2E_BASE_TEMP";
const PREFIX = "ompdesk-e2e-";
const OWNER = "owner.json";
/** A folder with no owner file yet may be one a runner is making this moment. */
const UNCLAIMED_GRACE_MS = 60_000;

/**
 * On Windows every e2e run (runner, workers, the apps and fakes they start) gets a temp folder of its own: TEMP and
 * TMP point at `<temp>/ompdesk-e2e-XXXXXX`, so each spec's `mkdtemp` profile, Playwright's own artifact and browser
 * profile folders and whatever the apps write there are one folder, removed with every process still naming it
 * when the run ends (`clearRunTemp`) or, after a runner that died first, by the next run (`sweepStaleRunTemps`). A
 * worker that crashed skipped its specs' `afterEach`, and on one Windows PC 289 profiles and 405 WebKit profiles had
 * piled up in a day. The first call claims the folder for this process; a worker loading the config again inherits
 * it. Elsewhere it changes nothing.
 */
export function claimRunTemp(): string | null {
	if (process.platform !== "win32") return null;
	const claimed = process.env[RUN_TEMP_ENV];
	if (claimed) return claimed;
	const base = os.tmpdir();
	const dir = fs.mkdtempSync(path.join(base, PREFIX));
	fs.writeFileSync(path.join(dir, OWNER), JSON.stringify({ pid: process.pid }));
	process.env[BASE_TEMP_ENV] = base;
	process.env[RUN_TEMP_ENV] = dir;
	process.env.TEMP = dir;
	process.env.TMP = dir;
	return dir;
}

/** The temp folder outside this run's own, for what is kept across runs. */
export const baseTemp = (): string => process.env[BASE_TEMP_ENV] ?? os.tmpdir();

export interface RunTempDeps {
	alive(pid: number): boolean;
	clear(dir: string): void;
	now(): number;
}

const pidAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

/** Ends every process whose command line names `dir` (with what it started), then removes `dir`. */
export function clearRunTemp(dir: string): void {
	if (process.platform === "win32") {
		const needle = dir.toLowerCase();
		for (const entry of windowsProcesses()) {
			if (entry.pid === process.pid || !entry.commandLine?.toLowerCase().includes(needle)) continue;
			spawnSync("taskkill", ["/T", "/F", "/PID", String(entry.pid)], { stdio: "ignore", windowsHide: true });
		}
	}
	// A file a dying process still holds leaves the folder for the next run's sweep.
	fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/**
 * Clears the run folders under `base` whose runner is gone (`owner.json` names a pid no longer alive, or no owner
 * after the grace period). Never this run's own folder, never a live run's. Returns the folders cleared.
 */
export function sweepStaleRunTemps(
	base: string = baseTemp(),
	deps: RunTempDeps = { alive: pidAlive, clear: clearRunTemp, now: Date.now },
): string[] {
	const own = process.env[RUN_TEMP_ENV];
	const cleared: string[] = [];
	for (const name of fs.readdirSync(base)) {
		if (!name.startsWith(PREFIX)) continue;
		const dir = path.join(base, name);
		if (own && path.resolve(dir) === path.resolve(own)) continue;
		let owner: number | null = null;
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, OWNER), "utf8"));
			const pid = parsed && typeof parsed === "object" && "pid" in parsed ? Number(parsed.pid) : 0;
			owner = pid > 0 ? pid : null;
		} catch {
			const made = fs.statSync(dir, { throwIfNoEntry: false });
			if (!made?.isDirectory() || deps.now() - made.mtimeMs < UNCLAIMED_GRACE_MS) continue;
		}
		if (owner !== null && deps.alive(owner)) continue;
		try {
			deps.clear(dir);
			cleared.push(dir);
		} catch {
			// Still held: the next run tries again.
		}
	}
	return cleared;
}
