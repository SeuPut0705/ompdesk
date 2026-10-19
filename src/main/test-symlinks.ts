import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "vitest";

/**
 * Whether this machine lets an unprivileged process make a file symlink. Windows refuses one (`EPERM`) unless
 * Developer Mode is on or the process is elevated; OMPdesk itself never needs one, only tests that build a
 * symlink on purpose do. Folder links need no privilege: make them as `"junction"`.
 */
export const FILE_SYMLINKS = (() => {
	const dir = mkdtempSync(join(tmpdir(), "ompdesk-symlink-probe-"));
	try {
		writeFileSync(join(dir, "target"), "");
		symlinkSync(join(dir, "target"), join(dir, "link"));
		return true;
	} catch {
		return false;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
})();

/** `it` for a test that makes a file symlink; skipped, with the reason in its name, where the OS refuses one. */
export function itWithFileSymlinks(name: string, fn: () => unknown, timeout?: number): void {
	if (FILE_SYMLINKS) it(name, fn, timeout);
	else it.skip(`${name} (skipped: file symlinks need Windows Developer Mode or elevation)`, fn);
}
