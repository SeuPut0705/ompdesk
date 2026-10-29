/**
 * The file a spawned omp reads memory's address from (recall-state.ts): written once the data dir is known, and left
 * as an earlier launch wrote it while this launch has not found the data dir yet (the first tab starts before
 * memory's setup pass).
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseMemoryEnv } from "../../../resources/gui-bridge/modes/memory-recall-contracts";
import { RecallStateFile } from "./recall-state";

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "recall-state-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const ENV = { url: "http://127.0.0.1:49374", dataDir: "/data" };

describe("RecallStateFile", () => {
	it("writes the address the bridge reads back, owner-only, creating its folder", async () => {
		const file = new RecallStateFile(join(dir, "ai-memory", "recall.json"));
		await file.update(ENV);
		expect(parseMemoryEnv(await readFile(file.path, "utf8"))).toEqual(ENV);
		if (process.platform !== "win32") expect((await stat(file.path)).mode & 0o777).toBe(0o600);
	});

	it("keeps an earlier launch's address while memory is on and the data dir is not known yet", async () => {
		await new RecallStateFile(join(dir, "recall.json")).update(ENV);
		const relaunched = new RecallStateFile(join(dir, "recall.json"));
		await relaunched.update(null);
		expect(parseMemoryEnv(await readFile(relaunched.path, "utf8"))).toEqual(ENV);
	});

	it("ends on the last state when updates come quickly", async () => {
		const file = new RecallStateFile(join(dir, "recall.json"));
		void file.update(ENV);
		void file.update({ ...ENV, url: "http://127.0.0.1:49999" });
		await file.update({ ...ENV, url: "http://127.0.0.1:50000" });
		expect(parseMemoryEnv(await readFile(file.path, "utf8"))?.url).toBe("http://127.0.0.1:50000");
	});
});
