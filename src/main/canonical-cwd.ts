import { realpathSync } from "node:fs";

/**
 * The sidecar reports `process.cwd()`, which is the resolved path (`/private/var/…`
 * for `/var/…`, `/private/tmp` for `/tmp`). Every tab cwd must match it, or one
 * project splits into two sidebar groups and session/cwd lookups miss.
 */
export function canonicalCwd(cwd: string): string {
	try {
		return realpathSync(cwd);
	} catch {
		return cwd;
	}
}
