import { realpathSync } from "node:fs";

/**
 * The sidecar reports `process.cwd()`, which is the resolved path (`/private/var/…`
 * for `/var/…`, `/private/tmp` for `/tmp`). Every tab cwd must match it, or one
 * project splits into two sidebar groups and session/cwd lookups miss. Windows
 * keeps the spelling it was given (no symlinked system dirs; resolving there
 * could swap drive-relative or 8.3 spellings instead).
 */
export function canonicalCwd(cwd: string): string {
	if (process.platform === "win32") return cwd;
	try {
		return realpathSync(cwd);
	} catch {
		return cwd;
	}
}
