import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { holdOpen } from "../test-hold-open";
import { readJson, writeSecureJson } from "./secure-file";

describe("writeSecureJson", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ompdesk-secure-file-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("saves while another process has the record open (Windows refuses a rename over an open file)", async () => {
		const file = join(dir, "remote-peers.json");
		writeSecureJson(file, { peers: [] });
		const reader = await holdOpen(file, 120);
		writeSecureJson(file, { peers: ["phone"] });
		await reader.closed;
		expect(readJson(file)).toEqual({ peers: ["phone"] });
		expect(readdirSync(dir)).toEqual(["remote-peers.json"]);
	});
});
