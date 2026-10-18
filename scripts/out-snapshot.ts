/**
 * Immutable copies of `out/` for Playwright. A build rewrites `out/` in place, which would change the
 * app under a run that is half way through; so every build publishes `out-<first 12 of the input hash>/`
 * (a copy-on-write clone on APFS, 17 MB) and a Playwright run launches the app from that directory
 * (`OMP_GUI_E2E_OUT`, pinned once by `playwright.config.ts`). A later build writes `out/` and its own
 * snapshot and never touches one a run is using.
 *
 * A snapshot sits next to `out/`, not under /tmp, because the bundles resolve `node_modules` and
 * `../../resources` from their own location.
 *
 * Runs keep their snapshot alive by touching `<snapshot>/.used` (the lock wrapper's heartbeat, or the
 * config's own timer); a snapshot unused for `IDLE_MS` is deleted by the next publish.
 *
 *   bun scripts/out-snapshot.ts publish    (what `pinSnapshot` runs under the build lock)
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const IDLE_MS = 30 * 60_000;
const TOUCH_MS = 60_000;
const SNAPSHOT = /^out-[0-9a-f]{12}$/;

/** The input hash `bun run build` stamped on `out/`; undefined while there is no finished build. */
export function stampHash(root: string): string | undefined {
	try {
		const stamp = JSON.parse(fs.readFileSync(path.join(root, "out", ".build-stamp.json"), "utf8")) as {
			hash?: string;
		};
		return typeof stamp.hash === "string" && stamp.hash.length >= 12 ? stamp.hash : undefined;
	} catch {
		return undefined;
	}
}

/** Tell `pruneSnapshots` that a run is still using `dir`. */
export function touchSnapshot(dir: string): void {
	const used = path.join(dir, ".used");
	const now = new Date();
	try {
		fs.utimesSync(used, now, now);
	} catch {
		fs.writeFileSync(used, "");
	}
}

/** Delete snapshots other than `keep` that no run touched for `idleMs`, and abandoned half copies. */
export function pruneSnapshots(root: string, keep: string, idleMs = IDLE_MS): void {
	for (const name of fs.readdirSync(root)) {
		if (path.join(root, name) === keep || !(SNAPSHOT.test(name) || /^out-[0-9a-f]{12}\.tmp-/.test(name))) continue;
		const dir = path.join(root, name);
		const touched =
			fs.statSync(path.join(dir, ".used"), { throwIfNoEntry: false }) ?? fs.statSync(dir, { throwIfNoEntry: false });
		if (touched && Date.now() - touched.mtimeMs > idleMs) fs.rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Make sure `out-<hash>/` holds the current `out/`. Call it only while `out/` cannot change (the build
 * lock). Returns its path, or undefined without a finished build.
 */
export function publishSnapshot(root: string, hash = stampHash(root)): string | undefined {
	if (!hash) return undefined;
	const dest = path.join(root, `out-${hash.slice(0, 12)}`);
	if (!fs.existsSync(dest)) {
		const temp = `${dest}.tmp-${process.pid}`;
		fs.rmSync(temp, { recursive: true, force: true });
		fs.cpSync(path.join(root, "out"), temp, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
		try {
			fs.renameSync(temp, dest);
		} catch {
			// Another publisher won the rename; its copy is the same bytes.
			fs.rmSync(temp, { recursive: true, force: true });
		}
	}
	touchSnapshot(dest);
	pruneSnapshots(root, dest);
	return dest;
}

/**
 * The directory a Playwright run launches the app from, fixed for the whole run: `OMP_GUI_E2E_OUT` when
 * set, else the snapshot of the current `out/` (published first, under the build lock, when the build
 * was not by `bun run build`). Undefined when there is no finished build; specs then use `out/`.
 * Synchronous: a Playwright config cannot await.
 */
export function pinSnapshot(root: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (env.OMP_GUI_E2E_OUT) return env.OMP_GUI_E2E_OUT;
	const hash = stampHash(root);
	let dir: string | undefined = hash ? path.join(root, `out-${hash.slice(0, 12)}`) : undefined;
	if (dir && fs.existsSync(dir)) touchSnapshot(dir);
	else {
		// No snapshot yet: the build was not `bun run build`, or one is running now (it removes the stamp
		// until it is done). The build lock waits for it, then publishes what `out/` holds.
		spawnSync(
			"bun",
			[
				path.join(import.meta.dirname, "build-lock.ts"),
				"--kind",
				"build",
				"bun",
				path.join(import.meta.dirname, "out-snapshot.ts"),
				"publish",
			],
			{ cwd: root, stdio: "inherit" },
		);
		const published = stampHash(root);
		dir = published ? path.join(root, `out-${published.slice(0, 12)}`) : undefined;
		if (dir && !fs.existsSync(dir)) dir = undefined;
	}
	if (dir) {
		const pinned = dir;
		// A long run keeps its snapshot out of `pruneSnapshots`.
		setInterval(() => touchSnapshot(pinned), TOUCH_MS).unref();
	}
	return dir;
}

if (import.meta.main) {
	const root = path.resolve(import.meta.dirname, "..");
	if (process.argv[2] !== "publish") {
		console.error("usage: bun scripts/out-snapshot.ts publish");
		process.exit(2);
	}
	const dest = publishSnapshot(root);
	if (!dest) {
		console.error("[out-snapshot] out/ has no build stamp; run `bun run build` first");
		process.exit(1);
	}
	console.log(`[out-snapshot] ${path.relative(root, dest)}`);
}
