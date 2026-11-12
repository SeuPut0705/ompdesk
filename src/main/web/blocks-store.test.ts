import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loginBlockId, nodeBlockId, WebBlocks } from "./blocks-store";

// The blocks are the core's (crates/core/src/web/store.rs): these cases run against the real process.
let dir: string;
const opened: WebBlocks[] = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "web-blocks-"));
});
afterEach(async () => {
	// Every write is on disk before the folder goes, or the core's writer would make it again.
	for (const blocks of opened.splice(0)) {
		await blocks.flush();
		blocks.close();
	}
	rmSync(dir, { recursive: true, force: true });
});

const store = async (now?: () => number, folder = dir): Promise<WebBlocks> => {
	const blocks = new WebBlocks(folder, now);
	opened.push(blocks);
	await blocks.ready();
	return blocks;
};

describe("WebBlocks", () => {
	it("blocks a node by its stable ID and answers for that node only", async () => {
		const blocks = await store(() => 42);
		const added = blocks.add({ scope: "node", key: "nPHONE1", name: "s25u", tailscaleLogin: "Me@Example.com" });
		expect(added).toEqual({
			id: nodeBlockId("nPHONE1"),
			scope: "node",
			name: "s25u",
			tailscaleLogin: "Me@Example.com",
			blockedAt: 42,
		});
		expect(blocks.active).toBe(true);
		expect(blocks.check({ nodeId: "nPHONE1", login: "me@example.com" })).toEqual(added);
		// Another node of the same login is not blocked.
		expect(blocks.check({ nodeId: "nTABLET", login: "me@example.com" })).toBeNull();
		expect(blocks.check({ nodeId: "nPHONE1", login: null })).toEqual(added);
	});

	it("cannot rule a visitor out when its node is unknown and its login has a blocked node", async () => {
		const blocks = await store();
		blocks.add({ scope: "node", key: "nPHONE1", name: "s25u", tailscaleLogin: "me@example.com" });
		expect(blocks.check({ nodeId: null, login: "ME@example.com" })).toBe("unidentified");
		expect(blocks.check({ nodeId: null, login: "kim@example.com" })).toBeNull();
		expect(blocks.check({ nodeId: null, login: null })).toBeNull();
	});

	it("blocks every device of a login when there was no node identity, ignoring case", async () => {
		const blocks = await store();
		const added = blocks.add({
			scope: "login",
			key: "Me@Example.com",
			name: "s25u",
			tailscaleLogin: "Me@Example.com",
		});
		expect(added.id).toBe(loginBlockId("me@example.com"));
		expect(blocks.check({ nodeId: "nANY", login: "me@example.com" })).toMatchObject({ scope: "login" });
		expect(blocks.check({ nodeId: null, login: "ME@EXAMPLE.COM" })).toMatchObject({ scope: "login" });
		expect(blocks.check({ nodeId: "nANY", login: "kim@example.com" })).toBeNull();
	});

	it("replaces a block of the same key, lifts one, and tells its listeners each time", async () => {
		const blocks = await store();
		const changed = vi.fn();
		blocks.onChanged(changed);
		blocks.add({ scope: "node", key: "n1", name: "old", tailscaleLogin: null });
		blocks.add({ scope: "node", key: "n1", name: "new", tailscaleLogin: null });
		expect(blocks.list()).toMatchObject([{ id: "node:n1", name: "new" }]);
		expect(blocks.remove("node:missing")).toBe(false);
		expect(blocks.remove("node:n1")).toBe(true);
		expect(blocks.list()).toEqual([]);
		expect(blocks.active).toBe(false);
		expect(blocks.check({ nodeId: "n1", login: null })).toBeNull();
		await blocks.flush();
		expect(changed).toHaveBeenCalledTimes(3);
		expect(blocks.list(), "the core's answers to those changes left the copy as it was").toEqual([]);
	});

	it("keeps its blocks in a 0600 file and reads them back", async () => {
		const blocks = await store(() => 7);
		blocks.add({ scope: "node", key: "n1", name: "s25u", tailscaleLogin: "me@example.com" });
		await blocks.flush();
		const file = join(dir, "web-blocked.json");
		if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ v: 1, blocked: [{ id: "node:n1" }] });
		// A folder holding that file, opened by the core for the first time.
		const other = mkdtempSync(join(tmpdir(), "web-blocks-"));
		try {
			copyFileSync(file, join(other, "web-blocked.json"));
			const reread = await store(undefined, other);
			expect(reread.list()).toMatchObject([{ id: "node:n1", name: "s25u", blockedAt: 7 }]);
			await reread.flush();
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});

	it("starts empty from a missing or corrupt file", async () => {
		expect((await store()).list()).toEqual([]);
		const corrupt = mkdtempSync(join(tmpdir(), "web-blocks-"));
		try {
			writeFileSync(join(corrupt, "web-blocked.json"), "not json");
			const blocks = await store(undefined, corrupt);
			expect(blocks.active).toBe(false);
			expect(blocks.list()).toEqual([]);
		} finally {
			rmSync(corrupt, { recursive: true, force: true });
		}
	});
});
