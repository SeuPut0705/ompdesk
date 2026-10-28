/**
 * Stock's compiled omp in the place of Bun's omp launcher, moved aside so `bun install -g` can link the package's own.
 *
 * Stock's launcher repair (`updateViaManager`) writes its standalone build over `<BUN_INSTALL>/bin/omp` (`omp.exe`
 * on Windows) whenever the new launcher does not answer `--version`. `bun install -g @oh-my-pi/pi-coding-agent` cannot
 * put the launcher back over it: on POSIX it fails `error: failed to link @oh-my-pi/pi-coding-agent: EEXIST` (Bun
 * 1.4.4, measured 29 Oct 2026 on a regular file in the launcher's place), and on Windows it overwrites `omp.exe` but
 * ignores EBUSY while that `omp.exe` runs anywhere (`src/install/bin.rs` `create_windows_shim`), exits 0 and leaves
 * the compiled omp. Renaming is what works on both: Windows lets a running executable be renamed (`bun upgrade` and
 * stock rename their own running exe), only not deleted or overwritten.
 */
import { readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { SetupPlatform } from "../../shared/setup";
import { isCompiledOmp } from "../omp-runtime";

/** What `setAsideCompiledOmp` moved, to put back or drop once the install ended. */
export interface SetAside {
	launcher: string;
	aside: string;
}

const ASIDE_TAG = ".ompdesk-compiled-";

/** Bun's omp launcher under `bunInstall` on `platform`. */
export function bunOmpLauncher(bunInstall: string, platform: SetupPlatform): string {
	return join(bunInstall, "bin", platform === "win32" ? "omp.exe" : "omp");
}

/**
 * Moves a compiled omp at Bun's launcher path aside (`<launcher>.ompdesk-compiled-<time>`) and drops the copies
 * earlier repairs left (best effort: Windows keeps one a process still runs). Null when the launcher is no compiled omp.
 */
export async function setAsideCompiledOmp(
	bunInstall: string,
	platform: SetupPlatform,
	now: number,
): Promise<SetAside | null> {
	const launcher = bunOmpLauncher(bunInstall, platform);
	await dropStaleCopies(launcher);
	if (!isCompiledOmp(launcher, platform === "win32" ? "win32" : "darwin")) return null;
	const aside = `${launcher}${ASIDE_TAG}${now}`;
	try {
		await rename(launcher, aside);
	} catch {
		// Not movable (held without delete sharing): the install runs as before and detection says what it left.
		return null;
	}
	return { launcher, aside };
}

/**
 * After the install: a launcher in place means the package's own, so the compiled copy goes (kept, and removed by a
 * later repair, while Windows still runs it); no launcher means the install failed, and the compiled omp comes back
 * for whatever else runs it.
 */
export async function settleSetAside(moved: SetAside, launcherExists: boolean): Promise<void> {
	if (launcherExists) {
		await rm(moved.aside, { force: true }).catch(() => undefined);
		return;
	}
	await rename(moved.aside, moved.launcher).catch(() => undefined);
}

async function dropStaleCopies(launcher: string): Promise<void> {
	const prefix = `${basename(launcher)}${ASIDE_TAG}`;
	const entries = await readdir(dirname(launcher)).catch(() => [] as string[]);
	await Promise.all(
		entries
			.filter(name => name.startsWith(prefix))
			.map(name => rm(join(dirname(launcher), name), { force: true }).catch(() => undefined)),
	);
}
