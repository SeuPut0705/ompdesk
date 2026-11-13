/**
 * A `node:fs` whose writes can run out of room, for tests of what the app does on a full disk: while `disk.full` is
 * set, `writeFileSync` leaves the part of the file the disk had room for and throws ENOSPC, as a real one does.
 * Used as `vi.mock("node:fs", async original => (await import("./test-full-disk")).withFullDisk(await original()))`.
 */
import type * as Fs from "node:fs";

export const disk = { full: false };

export function withFullDisk(actual: typeof Fs): typeof Fs {
	const writeFileSync = ((...args: Parameters<typeof Fs.writeFileSync>) => {
		if (!disk.full) return actual.writeFileSync(...args);
		actual.writeFileSync(args[0], "partial");
		throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
	}) as typeof Fs.writeFileSync;
	return { ...actual, writeFileSync };
}
