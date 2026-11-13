import type * as Fs from "node:fs";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AtomicSaver, writeFileAtomicDeferred, writeFileAtomicSync } from "./atomic-file";
import { diskFull } from "./disk-full";
import { bindDiskFullNotice } from "./disk-full-notice";
import { disk } from "./test-full-disk";

// vi.mock runs above the imports, so the helper can only be loaded the way the factory loads `node:fs` itself.
vi.mock("node:fs", async original => (await import("./test-full-disk")).withFullDisk(await original<typeof Fs>()));

describe("a write on a full disk", () => {
	let dir: string;
	let file: string;
	const heard: string[][] = [];
	let stop: () => void;
	beforeEach(() => {
		vi.useFakeTimers();
		dir = mkdtempSync(join(tmpdir(), "ompdesk-full-disk-"));
		file = join(dir, "state.json");
		writeFileSync(file, "old");
		heard.length = 0;
		stop = diskFull.onChange(names => heard.push([...names]));
	});
	afterEach(() => {
		stop();
		disk.full = false;
		diskFull.clear(file);
		vi.useRealTimers();
		rmSync(dir, { recursive: true, force: true });
	});

	it("throws nothing into the caller, keeps the old file whole and leaves no temp file", () => {
		disk.full = true;
		expect(() => writeFileAtomicDeferred(file, "new")).not.toThrow();
		expect(readFileSync(file, "utf8")).toBe("old");
		expect(readdirSync(dir)).toEqual(["state.json"]);
	});

	it("is written once the space is back, and tells once, then that it is over", async () => {
		disk.full = true;
		writeFileAtomicDeferred(file, "new");
		await vi.advanceTimersByTimeAsync(0);
		expect(heard).toEqual([["state.json"]]);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(readFileSync(file, "utf8")).toBe("old");
		expect(readdirSync(dir)).toEqual(["state.json"]);
		expect(heard).toEqual([["state.json"]]);

		disk.full = false;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(readFileSync(file, "utf8")).toBe("new");
		expect(readdirSync(dir)).toEqual(["state.json"]);
		expect(heard).toEqual([["state.json"], []]);
	});

	it("never lets an older content land over a newer one that was saved while the disk was full", async () => {
		const saver = new AtomicSaver(file);
		disk.full = true;
		saver.save("first");
		saver.save("second");
		await vi.advanceTimersByTimeAsync(10_000);
		disk.full = false;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(readFileSync(file, "utf8")).toBe("second");
		expect(readdirSync(dir)).toEqual(["state.json"]);
		expect(heard).toEqual([["state.json"], []]);
	});

	it("is called off with its notice when nothing is left to save", async () => {
		disk.full = true;
		const callOff = writeFileAtomicDeferred(file, "new");
		await vi.advanceTimersByTimeAsync(0);
		callOff();
		await vi.advanceTimersByTimeAsync(0);
		expect(heard).toEqual([["state.json"], []]);
		disk.full = false;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(readFileSync(file, "utf8")).toBe("old");
	});

	it("still throws from the blocking variant, which has a caller to tell, and cleans up the same", () => {
		disk.full = true;
		expect(() => writeFileAtomicSync(file, "new")).toThrow(/ENOSPC/);
		expect(readFileSync(file, "utf8")).toBe("old");
		expect(readdirSync(dir)).toEqual(["state.json"]);
	});

	it("keeps one notice for any number of files, and closes it when the last one is saved", async () => {
		const other = join(dir, "other.json");
		const shown: string[] = [];
		let closed = 0;
		const unbind = bindDiskFullNotice(diskFull, {
			show: notice => {
				shown.push(notice.body);
				return { close: () => closed++ };
			},
			text: names => ({ title: "Disk is full", body: names.join(",") }),
		});
		try {
			disk.full = true;
			writeFileAtomicDeferred(file, "new");
			writeFileAtomicDeferred(other, "other");
			await vi.advanceTimersByTimeAsync(0);
			expect(shown).toEqual(["state.json,other.json"]);
			expect(readFileSync(file, "utf8")).toBe("old");
			expect(closed).toBe(0);

			disk.full = false;
			await vi.advanceTimersByTimeAsync(60_000);
			expect(readFileSync(file, "utf8")).toBe("new");
			expect(readFileSync(other, "utf8")).toBe("other");
			expect(shown).toHaveLength(1);
			expect(closed).toBe(1);
		} finally {
			unbind();
			diskFull.clear(other);
		}
	});
});
