/**
 * One-time move of the pre-rename profile. Electron keys userData on the app
 * name, so the profile written before the app became ompdesk sits next to the
 * new one (`LEGACY_USER_DATA_NAME` under Application Support / %APPDATA%). The
 * first ompdesk launch moves it into place before anything (GPU marker,
 * instance lock, prefs, window state) touches userData.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Directory name of the profile written before the rename. */
export const LEGACY_USER_DATA_NAME = "seucode";

export type UserDataMigration = "moved" | "copied" | "skipped";

function isDirectory(directory: string): boolean {
	try {
		return fs.statSync(directory).isDirectory();
	} catch {
		return false;
	}
}

/** Electron creates userData empty before the main script runs, so an empty directory is still fresh. */
function isFresh(directory: string): boolean {
	try {
		return fs.readdirSync(directory).length === 0;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}

/**
 * Move `legacy` to `userData` when `userData` is fresh and `legacy` exists:
 * a rename, or (across volumes or with locked files) a copy staged next to
 * `userData` and renamed into place, so a half-finished copy never looks like a
 * migrated profile. The legacy directory is left alone after a copy. Throws on
 * failure, with `userData` recreated empty so the launch can continue fresh.
 */
export function migrateLegacyUserData(
	userData: string,
	legacy = path.join(path.dirname(userData), LEGACY_USER_DATA_NAME),
): UserDataMigration {
	if (path.resolve(legacy) === path.resolve(userData)) return "skipped";
	if (!isDirectory(legacy) || !isFresh(userData)) return "skipped";
	const staging = `${userData}.migrating`;
	try {
		// rmdir, not rm: it refuses if anything landed in userData since the check.
		fs.rmSync(staging, { recursive: true, force: true });
		if (fs.existsSync(userData)) fs.rmdirSync(userData);
		try {
			fs.renameSync(legacy, userData);
			return "moved";
		} catch {
			fs.cpSync(legacy, staging, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
			fs.renameSync(staging, userData);
			return "copied";
		}
	} catch (error) {
		fs.rmSync(staging, { recursive: true, force: true });
		fs.mkdirSync(userData, { recursive: true });
		throw error;
	}
}
