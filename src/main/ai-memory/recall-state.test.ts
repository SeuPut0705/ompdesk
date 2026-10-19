/**
 * The file a spawned omp reads memory's address from (recall-state.ts): written while memory is on and its data dir is
 * known, gone once memory is off, and left as an earlier launch wrote it while this launch has not found the data dir
 * yet (the first tab starts before memory's setup pass).
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
const exists = (path: string) =>
	stat(path).then(
		() => true,
		() => false,
	);

describe("RecallStateFile", () => {
	it("writes the address the bridge reads back, owner-only, creating its folder", async () => {
		const file = new RecallStateFile(join(dir, "ai-memory", "recall.json"));
		await file.update(ENV, true);
		expect(parseMemoryEnv(await readFile(file.path, "utf8"))).toEqual(ENV);
		if (process.platform !== "win32") expect((await stat(file.path)).mode & 0o777).toBe(0o600);
	});

	it("removes the file when memory is off", async () => {
		const file = new RecallStateFile(join(dir, "recall.json"));
		await file.update(ENV, true);
		await file.update(null, false);
		expect(await exists(file.path)).toBe(false);
	});

	it("keeps an earlier launch's address while memory is on and the data dir is not known yet", async () => {
		await new RecallStateFile(join(dir, "recall.json")).update(ENV, true);
		const relaunched = new RecallStateFile(join(dir, "recall.json"));
		await relaunched.update(null, true);
		expect(parseMemoryEnv(await readFile(relaunched.path, "utf8"))).toEqual(ENV);
	});

	it("ends on the last state when updates come quickly", async () => {
		const file = new RecallStateFile(join(dir, "recall.json"));
		void file.update(ENV, true);
		void file.update(null, false);
		await file.update({ ...ENV, url: "http://127.0.0.1:50000" }, true);
		expect(parseMemoryEnv(await readFile(file.path, "utf8"))?.url).toBe("http://127.0.0.1:50000");
	});
});
