import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loginBlockId, nodeBlockId, WebBlocks } from "./blocks-store";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "web-blocks-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("WebBlocks", () => {
	it("blocks a node by its stable ID and answers for that node only", () => {
		const blocks = new WebBlocks(dir, () => 42);
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

	it("cannot rule a visitor out when its node is unknown and its login has a blocked node", () => {
		const blocks = new WebBlocks(dir);
		blocks.add({ scope: "node", key: "nPHONE1", name: "s25u", tailscaleLogin: "me@example.com" });
		expect(blocks.check({ nodeId: null, login: "ME@example.com" })).toBe("unidentified");
		expect(blocks.check({ nodeId: null, login: "kim@example.com" })).toBeNull();
		expect(blocks.check({ nodeId: null, login: null })).toBeNull();
	});

	it("blocks every device of a login when there was no node identity, ignoring case", () => {
		const blocks = new WebBlocks(dir);
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

	it("replaces a block of the same key, lifts one, and tells its listeners each time", () => {
		const blocks = new WebBlocks(dir);
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
		expect(changed).toHaveBeenCalledTimes(3);
	});

	it("keeps its blocks in a 0600 file and reads them back", () => {
		const blocks = new WebBlocks(dir, () => 7);
		blocks.add({ scope: "node", key: "n1", name: "s25u", tailscaleLogin: "me@example.com" });
		const file = join(dir, "web-blocked.json");
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ v: 1, blocked: [{ id: "node:n1" }] });
		expect(new WebBlocks(dir).list()).toMatchObject([{ id: "node:n1", name: "s25u", blockedAt: 7 }]);
	});

	it("starts empty from a missing or corrupt file", () => {
		expect(new WebBlocks(dir).list()).toEqual([]);
		const blocks = new WebBlocks(dir);
		blocks.add({ scope: "node", key: "n1", name: "x", tailscaleLogin: null });
		rmSync(join(dir, "web-blocked.json"));
		expect(new WebBlocks(dir).active).toBe(false);
	});
});
