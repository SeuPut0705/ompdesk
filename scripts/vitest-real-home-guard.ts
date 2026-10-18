/**
 * Vitest setup: a write anywhere under the developer's real home fails the test instead of landing
 * on disk, except inside this checkout and the OS temp folder. Wired from `vitest.setup.ts`, so every
 * test file in both projects runs behind it.
 *
 * Why: the app's writers resolve `~` at write time, so a unit test that reaches one without a temp
 * HOME edits the real `~/.omp` (auth, config, sessions) of whoever runs `check:changed` — often an
 * agent on the maintainer's own machine. The idea (and the `os.userInfo().homedir` trick) is Orca's
 * `vitest-real-agent-home-write-guard.ts` (MIT), reimplemented for OMPdesk's paths.
 *
 * The real home comes from `os.userInfo().homedir`, which a test that fakes `HOME` / `USERPROFILE`
 * cannot move. Child processes a test spawns are outside the guard. A write the code under test
 * swallows is still recorded, and the test fails in `afterEach` with the writer's stack.
 * `OMP_GUI_ALLOW_REAL_HOME=1` switches the guard off for a suite that points a real omp at its
 * real home on purpose.
 */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";

export const ALLOW_REAL_HOME_ENV = "OMP_GUI_ALLOW_REAL_HOME";

export interface RealHomeGuardState {
	/** Protected folders, normalized and ending in a separator. */
	roots: string[];
	/** Folders inside a protected root a test may write: this checkout and the OS temp folder. */
	exempt: string[];
	/** Stacks of the writes refused since the last `afterEach`. */
	violations: string[];
}

declare global {
	// Once per process: wrapping again per test file would stack wrappers on wrappers.
	var ompdeskRealHomeWriteGuard: RealHomeGuardState | undefined;
}

const foldCase = process.platform === "darwin" || process.platform === "win32";

function normalize(path: string): string {
	const resolved = resolve(path);
	return (foldCase ? resolved.toLowerCase() : resolved) + sep;
}

function realHomes(): string[] {
	const homes: string[] = [];
	try {
		homes.push(userInfo().homedir);
	} catch {
		// No passwd entry (some containers): HOME is all there is.
	}
	for (const home of [process.env.HOME, process.env.USERPROFILE]) if (home) homes.push(home);
	return homes;
}

/** The real home, whole: `~/.omp`, `~/.ssh`, `~/Documents` and OMPdesk's userData alike. */
export function protectedRoots(): string[] {
	const roots = [...realHomes()];
	if (process.env.APPDATA) roots.push(join(process.env.APPDATA, "ompdesk"));
	return [...new Set(roots.map(normalize))];
}

/**
 * This checkout only (never every `~/.omp/wt` worktree), and the temp folder (under the home on Windows) as named and
 * as its real path: a Windows runner's TEMP is the 8.3 short `C:\Users\RUNNER~1\…`, while a test's `realpath` of a
 * `mkdtemp` folder gives the long `C:\Users\runneradmin\…`.
 */
export function exemptRoots(): string[] {
	const checkout = dirname(dirname(fileURLToPath(import.meta.url)));
	const temp = tmpdir();
	return [...new Set([checkout, temp, fs.realpathSync.native(temp)].map(normalize))];
}

function targetPath(target: unknown): string | null {
	if (typeof target === "string") return target.startsWith("file:") ? fileURLToPath(target) : target;
	if (target instanceof URL) return fileURLToPath(target);
	if (Buffer.isBuffer(target)) return target.toString();
	return null;
}

export function assertOutsideRealHome(state: RealHomeGuardState, operation: string, target: unknown): void {
	if (process.env[ALLOW_REAL_HOME_ENV] === "1") return;
	const path = targetPath(target);
	if (path === null) return;
	const normalized = normalize(path);
	const root = state.roots.find(candidate => normalized.startsWith(candidate));
	if (!root || state.exempt.some(candidate => normalized.startsWith(candidate))) return;
	const error = new Error(
		`[vitest real-home guard] ${operation}(${path}) would write the real home state under ${root}; give the test a temp HOME (${ALLOW_REAL_HOME_ENV}=1 opts a real-omp suite out)`,
	);
	// The stack: the writer that swallowed this is what the failing test has to fix.
	state.violations.push(error.stack?.split("\n").slice(0, 12).join("\n") ?? error.message);
	throw error;
}

const WRITE_OPEN_FLAGS = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT;

function opensForWrite(flags: unknown): boolean {
	if (typeof flags === "number") return (flags & WRITE_OPEN_FLAGS) !== 0;
	return typeof flags === "string" && /[wa+]/.test(flags);
}

/** Argument positions each mutating call writes to; `open` counts only when its flags write. */
const GUARDED_TARGETS: Record<string, readonly number[]> = {
	writeFile: [0],
	appendFile: [0],
	mkdir: [0],
	mkdtemp: [0],
	rename: [0, 1],
	copyFile: [1],
	cp: [1],
	symlink: [1],
	link: [1],
	rm: [0],
	rmdir: [0],
	unlink: [0],
	truncate: [0],
	open: [0],
};

function guard(
	state: RealHomeGuardState,
	api: typeof fs | typeof fs.promises,
	name: string,
	positions: readonly number[],
	label: string,
): void {
	const descriptor = Object.getOwnPropertyDescriptor(api, name);
	const found: unknown = descriptor?.value;
	if (!descriptor || typeof found !== "function") return;
	const original: (this: unknown, ...args: unknown[]) => unknown = found as (
		this: unknown,
		...args: unknown[]
	) => unknown;
	const isOpen = name === "open" || name === "openSync";
	function guarded(this: unknown, ...args: unknown[]): unknown {
		try {
			if (!isOpen || opensForWrite(args[1] ?? "r")) {
				for (const position of positions) assertOutsideRealHome(state, label, args[position]);
			}
		} catch (error) {
			// A promise API rejects; the callback and sync forms throw.
			if (api === fs.promises) return Promise.reject(error);
			throw error;
		}
		return Reflect.apply(original, this, args);
	}
	Object.defineProperty(api, name, { ...descriptor, value: guarded });
}

function install(): RealHomeGuardState {
	const state: RealHomeGuardState = { roots: protectedRoots(), exempt: exemptRoots(), violations: [] };
	for (const [name, positions] of Object.entries(GUARDED_TARGETS)) {
		guard(state, fs, name, positions, `fs.${name}`);
		guard(state, fs, `${name}Sync`, positions, `fs.${name}Sync`);
		guard(state, fs.promises, name, positions, `fs.promises.${name}`);
	}
	guard(state, fs, "createWriteStream", [0], "fs.createWriteStream");
	// Named ESM imports of node:fs keep the originals until the builtin exports are synced.
	syncBuiltinESMExports();
	return state;
}

globalThis.ompdeskRealHomeWriteGuard ??= install();
export const realHomeGuardState: RealHomeGuardState = globalThis.ompdeskRealHomeWriteGuard;

/** Refused writes since the last call; the test that provokes one on purpose takes them so `afterEach` stays quiet. */
export function takeRealHomeViolations(): string[] {
	return realHomeGuardState.violations.splice(0);
}

afterEach(() => {
	const violations = takeRealHomeViolations();
	if (violations.length > 0) {
		throw new Error(`A test tried to write the real home (swallowed or not):\n${violations.join("\n\n")}`);
	}
});
