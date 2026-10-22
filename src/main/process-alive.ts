/**
 * Whether process `pid` runs: signal 0 tests for it and sends nothing; EPERM is a live process of another user.
 * Shared by main (`test-launcher-exit.ts`) and the build lock (`scripts/lock-slots.ts`). The Vitest orphan guard
 * keeps its own copy: its test runs it in plain Node, which cannot import an extensionless TypeScript module.
 */
export function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
