/**
 * Vitest setup: a write under the developer's real omp or OMPdesk state fails the test instead of
 * landing on disk. Wired from `vitest.setup.ts`, so every test file in both projects runs behind it.
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
import { userInfo } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";

export const ALLOW_REAL_HOME_ENV = "OMP_GUI_ALLOW_REAL_HOME";

export interface RealHomeGuardState {
	/** Protected folders, normalized and ending in a separator. */
	roots: string[];
	/** Folders inside a protected root that are not state: the agent worktrees the repo itself may live in. */
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

/** Where omp and OMPdesk keep state for the real user, on macOS and Windows alike. */
export function protectedRoots(): string[] {
	const roots = realHomes().flatMap(home => [
		join(home, ".omp"),
		join(home, ".pi"),
		join(home, ".config", "omp"),
		join(home, "Library", "Application Support", "ompdesk"),
		join(home, "AppData", "Roaming", "ompdesk"),
	]);
	if (process.env.APPDATA) roots.push(join(process.env.APPDATA, "ompdesk"));
	return [...new Set(roots.map(normalize))];
}

function exemptRoots(): string[] {
	return [...new Set(realHomes().map(home => normalize(join(home, ".omp", "wt"))))];
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
