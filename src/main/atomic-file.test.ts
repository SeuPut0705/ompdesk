import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileAtomic, writeFileAtomicDeferred, writeFileAtomicSync } from "./atomic-file";
import { holdOpen } from "./test-hold-open";
// Windows refuses to rename over a file another handle has open. Elsewhere nothing is refused: the waiting cases hold
// there too, the one that needs a refused rename runs on Windows only.
// Windows refuses to rename over a file another handle has open. Elsewhere nothing is refused, and these hold too.
describe("atomic file writes", () => {
	let dir: string;
	let file: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ompdesk-atomic-"));
		file = join(dir, "state.json");
		writeFileSync(file, "old");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("the blocking variant waits out a reader in another process and leaves no temp file", async () => {
		const reader = await holdOpen(file, 120);
		writeFileAtomicSync(file, "new", { mode: 0o600 });
		await reader.closed;
		expect(readFileSync(file, "utf8")).toBe("new");
		expect(readdirSync(dir)).toEqual(["state.json"]);
	});

	it("the blocking variant throws what is not a held file and removes its temp file", () => {
		expect(() => writeFileAtomicSync(join(dir, "state.json", "inside.json"), "x")).toThrow();
		expect(readdirSync(dir)).toEqual(["state.json"]);
	});

	it("the async variant waits out a reader without blocking and leaves no temp file", async () => {
		const reader = openSync(file, "r");
		const done = writeFileAtomic(file, "new");
		// Real I/O and a real reader: the release has to land between two of the write's attempts, which no fake clock orders.
		setTimeout(() => closeSync(reader), 100);
		await done;
		expect(readFileSync(file, "utf8")).toBe("new");
		expect(readdirSync(dir)).toEqual(["state.json"]);
	});

	it("the async variant drops a write its caller no longer wants before the rename", async () => {
		await writeFileAtomic(file, "stale", { commitIf: () => false });
		expect(readFileSync(file, "utf8")).toBe("old");
		expect(readdirSync(dir)).toEqual(["state.json"]);
	});

	// Only Windows refuses the rename while the reader holds the file; elsewhere the first attempt already commits
	// (main's ci.yml on macOS and Linux read "stale").
	it.skipIf(process.platform !== "win32")(
		"the async variant drops a write its caller no longer wants, even while a reader holds the file",
		async () => {
			const reader = openSync(file, "r");
			let wanted = true;
			const done = writeFileAtomic(file, "stale", { commitIf: () => wanted });
			setTimeout(() => {
				wanted = false;
				closeSync(reader);
			}, 60);
			await done;
			expect(readFileSync(file, "utf8")).toBe("old");
			expect(readdirSync(dir)).toEqual(["state.json"]);
		},
	);

	it("the deferred variant writes at once when nothing holds the file", () => {
		writeFileAtomicDeferred(file, "new");
		expect(readFileSync(file, "utf8")).toBe("new");
	});

	it("the deferred variant keeps trying while a reader holds on and writes once it lets go", async () => {
		vi.useFakeTimers();
		try {
			const reader = openSync(file, "r");
			writeFileAtomicDeferred(file, "new");
			closeSync(reader);
			await vi.advanceTimersByTimeAsync(5_000);
			expect(readFileSync(file, "utf8")).toBe("new");
			expect(readdirSync(dir)).toEqual(["state.json"]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("the deferred variant reports a write that never went through and cleans up; a call-off leaves the file alone", async () => {
		vi.useFakeTimers();
		try {
			const reader = openSync(file, "r");
			try {
				const failures: unknown[] = [];
				writeFileAtomicDeferred(file, "new", {}, error => failures.push(error));
				await vi.advanceTimersByTimeAsync(60_000);
				// A platform that lets the rename through has nothing to retry.
				if (readFileSync(file, "utf8") === "old") {
					expect(failures).toHaveLength(1);
					expect(readdirSync(dir)).toEqual(["state.json"]);
				}
				writeFileSync(file, "old");
				const cancel = writeFileAtomicDeferred(file, "dropped");
				cancel();
				await vi.advanceTimersByTimeAsync(60_000);
				expect(readdirSync(dir)).toEqual(["state.json"]);
			} finally {
				closeSync(reader);
			}
		} finally {
			vi.useRealTimers();
		}
	});
});
