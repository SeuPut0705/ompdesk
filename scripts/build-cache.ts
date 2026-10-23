/**
 * `bun run build`: electron-vite → out/ plus `scripts/check-main-bundle.ts`,
 * skipped when out/ was built from exactly the current inputs.
 *
 * The inputs are every file that can change out/ (`inputFiles`) and the env
 * vars electron-vite or its plugins read (`buildEnv`); their SHA-256 goes into
 * `out/.build-stamp.json` together with the size and mtime of every file under
 * out/, written only after the build and the bundle check passed. A run rebuilds
 * when out/ or the stamp is missing, the hash differs, any file under out/ was
 * removed, added or rewritten since, or `OMPDESK_FORCE_BUILD=1` is set. CI and
 * packaging start from a fresh checkout without out/, so they always build.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { acquireLock } from "./build-lock";
import { publishSnapshot } from "./out-snapshot";

export const STAMP = path.join("out", ".build-stamp.json");

/** Root-level files electron-vite, Vite, Tailwind or this build read. */
const ROOT_INPUT =
	/^(package\.json|bun\.lockb?|electron\.vite\.config\.[cm]?[jt]s|tsconfig.*\.json|\.gitignore|\.env(\..+)?|postcss\.config\..+|tailwind\.config\..+|\.browserslistrc)$/;
/** The scripts `bun run build` runs, and the script data the main bundle inlines. */
const BUILD_SCRIPTS = [
	"scripts/build-cache.ts",
	"scripts/check-main-bundle.ts",
	"scripts/pwa-plugin.ts",
	"scripts/ws-bundle-probe.config.ts",
	"scripts/ws-bundle-probe.ts",
	// The pinned certificate the shipped ai-memory's requirement names (src/main/ai-memory/binary.ts).
	"scripts/mac-signing.json",
];
/**
 * Bundled or copied trees. Tailwind scans every file under the renderer root
 * (src/renderer, `.gitignore` respected) for class names, tests included, so
 * only test and bench files outside src/renderer are left out: no entry
 * imports them and nothing scans them.
 */
const INPUT_DIRS = ["src", "resources"];
const TEST_FILE = /\.(test|spec|bench)\.[cm]?[jt]sx?$/;
const RENDERER_DIR = `src${path.sep}renderer${path.sep}`;
/** The memory binaries built from native/memory (bun run build:memory): packaged as extraResources, never read by the build. */
const AI_MEMORY_BIN = path.join("resources", "ai-memory-bin");
/**
 * Env electron-vite and its plugins read at build time: Vite's mode and
 * NODE_ENV, the `VITE_`-prefixed vars electron-vite's `loadEnv` exposes to each
 * bundle, NODE_PATH (Tailwind's module resolver) and browserslist.
 */
const BUILD_ENV =
	/^(NODE_ENV|NODE_ENV_ELECTRON_VITE|MODE|NODE_PATH|BROWSERSLIST.*|(MAIN_|PRELOAD_|RENDERER_)?VITE_.+)$/;

function walk(root: string, dir: string, files: string[]): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name === ".DS_Store") continue;
		const rel = path.join(dir, entry.name);
		if (rel === AI_MEMORY_BIN) continue;
		if (entry.isDirectory()) walk(root, rel, files);
		else if (entry.isFile()) files.push(rel);
	}
}

/** Whether a changed path (repository-relative, either separator) is one `inputFiles` hashes: it can change out/. */
export function isBuildInput(file: string): boolean {
	const rel = file.replaceAll("\\", "/");
	if (!rel.includes("/")) return ROOT_INPUT.test(rel);
	if (BUILD_SCRIPTS.includes(rel)) return true;
	if (!INPUT_DIRS.some(dir => rel.startsWith(`${dir}/`))) return false;
	if (rel === "resources/ai-memory-bin" || rel.startsWith("resources/ai-memory-bin/")) return false;
	return !TEST_FILE.test(rel) || rel.startsWith("src/renderer/");
}

/** Every input file under `root`, relative and sorted. */
export function inputFiles(root: string): string[] {
	const files = fs
		.readdirSync(root, { withFileTypes: true })
		.filter(entry => entry.isFile() && ROOT_INPUT.test(entry.name))
		.map(entry => entry.name);
	files.push(...BUILD_SCRIPTS.map(file => path.normalize(file)).filter(file => fs.existsSync(path.join(root, file))));
	for (const dir of INPUT_DIRS) {
		const tree: string[] = [];
		walk(root, dir, tree);
		files.push(...tree.filter(file => !TEST_FILE.test(file) || file.startsWith(RENDERER_DIR)));
	}
	return files.sort();
}

/** The build-relevant subset of `env`, sorted by name. */
export function buildEnv(env: NodeJS.ProcessEnv): Array<[string, string]> {
	return Object.entries(env)
		.filter((entry): entry is [string, string] => BUILD_ENV.test(entry[0]) && entry[1] !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** SHA-256 over every input file's path and bytes and the build env. */
export function inputHash(root: string, env: NodeJS.ProcessEnv): string {
	const hash = createHash("sha256");
	for (const file of inputFiles(root)) {
		const bytes = fs.readFileSync(path.join(root, file));
		// Forward slashes, so a path hashes the same on every OS.
		hash.update(`${file.split(path.sep).join("/")}\0${bytes.length}\0`);
		hash.update(bytes);
	}
	for (const [name, value] of buildEnv(env)) hash.update(`env\0${name}\0${value}\0`);
	return hash.digest("hex");
}

/** Size and mtime of every file under out/ but the stamp; undefined without out/. */
export function outSnapshot(root: string): Record<string, string> | undefined {
	if (!fs.existsSync(path.join(root, "out"))) return undefined;
	const files: string[] = [];
	walk(root, "out", files);
	const snapshot: Record<string, string> = {};
	for (const file of files.sort()) {
		if (file === STAMP) continue;
		const stat = fs.statSync(path.join(root, file));
		snapshot[file.split(path.sep).join("/")] = `${stat.size}:${stat.mtimeMs}`;
	}
	return snapshot;
}

interface Stamp {
	hash: string;
	out: Record<string, string>;
}

/** Why out/ cannot be reused for inputs hashing to `hash`; undefined when it can. */
export function rebuildReason(root: string, hash: string, env: NodeJS.ProcessEnv): string | undefined {
	if (env.OMPDESK_FORCE_BUILD === "1") return "OMPDESK_FORCE_BUILD=1";
	const out = outSnapshot(root);
	if (!out) return "no out/";
	let stamp: Stamp;
	try {
		stamp = JSON.parse(fs.readFileSync(path.join(root, STAMP), "utf8")) as Stamp;
	} catch {
		return "out/ has no build stamp";
	}
	if (stamp.hash !== hash) return "inputs changed since out/ was built";
	for (const [file, signature] of Object.entries(stamp.out)) {
		if (out[file] === undefined) return `${file} was removed`;
		if (out[file] !== signature) return `${file} changed after the build`;
	}
	const added = Object.keys(out).find(file => stamp.out[file] === undefined);
	return added ? `${added} was added after the build` : undefined;
}

/** Record that out/ as it is now was built from inputs hashing to `hash`. */
export function writeStamp(root: string, hash: string): void {
	const stamp: Stamp = { hash, out: outSnapshot(root) ?? {} };
	fs.writeFileSync(path.join(root, STAMP), `${JSON.stringify(stamp, null, "\t")}\n`);
}

if (import.meta.main) {
	const root = path.resolve(import.meta.dirname, "..");
	// Builds never overlap, and out/ is not rewritten while a snapshot is copied from it. CI has its own checkout.
	const local = !process.env.GITHUB_ACTIONS;
	if (local) await acquireLock(["bun", "run", "build"], { kind: "build" });
	const started = performance.now();
	const hash = inputHash(root, process.env);
	const reason = rebuildReason(root, hash, process.env);
	const checked = `${Math.round(performance.now() - started)}ms`;
	if (!reason) {
		console.log(
			`[build] reusing out/: inputs unchanged (${hash.slice(0, 12)}, checked in ${checked}); OMPDESK_FORCE_BUILD=1 rebuilds`,
		);
		if (local) publishSnapshot(root, hash);
		process.exit(0);
	}
	console.log(`[build] building out/: ${reason} (checked in ${checked})`);
	// A build that fails or is interrupted must leave no stamp behind.
	fs.rmSync(path.join(root, STAMP), { force: true });
	for (const command of [
		[process.execPath, "x", "electron-vite", "build"],
		[process.execPath, "scripts/check-main-bundle.ts"],
	]) {
		const [file = "", ...args] = command;
		const result = spawnSync(file, args, { cwd: root, stdio: "inherit" });
		if (result.status !== 0) process.exit(result.status ?? 1);
	}
	writeStamp(root, hash);
	// Playwright runs launch the app from this copy, so the next build never changes one under them.
	if (local) publishSnapshot(root, hash);
}
