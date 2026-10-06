import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { LogWatcher } from "./log-watcher";

test("opening logs later replays complete lines once, including split appends", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-log-test-"));
	const file = path.join(directory, "omp.test.log");
	await fs.writeFile(file, "previous run\n");
	const watcher = new LogWatcher(directory);
	const batches: string[] = [];
	watcher.onLines = lines => batches.push(...lines);
	try {
		await watcher.start();
		await fs.appendFile(file, "[info] split");
		await delay(200);
		expect(watcher.getBuffer()).toEqual([]);
		await fs.appendFile(file, " message\n[error] failed\n");
		await expect.poll(() => watcher.getBuffer()).toEqual(["[info] split message", "[error] failed"]);
		await expect.poll(() => batches).toEqual(watcher.getBuffer());
		expect(watcher.getSnapshot()).toEqual({ lines: batches, nextSequence: 2 });
	} finally {
		watcher.stop();
		await fs.rm(directory, { recursive: true, force: true });
	}
});
