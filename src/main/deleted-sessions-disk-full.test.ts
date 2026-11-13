import type * as Fs from "node:fs";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeletedSessions } from "./deleted-sessions";
import { diskFull } from "./disk-full";
import { SessionKindStore } from "./session-kinds";
import { disk } from "./test-full-disk";

// vi.mock runs above the imports, so the helper can only be loaded the way the factory loads `node:fs` itself.
vi.mock("node:fs", async original => (await import("./test-full-disk")).withFullDisk(await original<typeof Fs>()));

describe("stores that save on every change, on a full disk", () => {
	let dir: string;
	let file: string;
	beforeEach(() => {
		vi.useFakeTimers();
		dir = mkdtempSync(join(tmpdir(), "ompdesk-store-full-"));
		file = join(dir, "state.json");
	});
	afterEach(() => {
		disk.full = false;
		diskFull.clear(file);
		vi.useRealTimers();
		rmSync(dir, { recursive: true, force: true });
	});

	it("keeps a deleted session deleted in memory and saves the tombstone once the space is back", async () => {
		const sessions = new DeletedSessions(file);
		sessions.add("/work/a.jsonl");
		const before = readFileSync(file, "utf8");

		disk.full = true;
		expect(() => sessions.add("/work/b.jsonl")).not.toThrow();
		expect(sessions.has("/work/b.jsonl")).toBe(true);
		expect(readFileSync(file, "utf8")).toBe(before);
		expect(readdirSync(dir)).toEqual(["state.json"]);
		await vi.advanceTimersByTimeAsync(0);
		expect(diskFull.names()).toEqual(["state.json"]);

		disk.full = false;
		await vi.advanceTimersByTimeAsync(60_000);
		const reread = new DeletedSessions(file);
		expect(reread.has("/work/a.jsonl")).toBe(true);
		expect(reread.has("/work/b.jsonl")).toBe(true);
		expect(readdirSync(dir)).toEqual(["state.json"]);
		expect(diskFull.names()).toEqual([]);
	});

	it("keeps a chat session's label in memory and saves it once the space is back", async () => {
		writeFileSync(file, JSON.stringify({ chat: ["old"] }));
		const kinds = new SessionKindStore(file);
		disk.full = true;
		expect(() => kinds.markChat("new")).not.toThrow();
		expect(kinds.isChat("new")).toBe(true);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ chat: ["old"] });
		expect(readdirSync(dir)).toEqual(["state.json"]);

		disk.full = false;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ chat: ["old", "new"] });
		expect(readdirSync(dir)).toEqual(["state.json"]);
	});
});
