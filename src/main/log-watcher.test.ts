import { readdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { LogWatcher } from "./log-watcher";

/** Open file descriptors of this process (macOS and Linux). */
const openFds = (): number => readdirSync("/dev/fd").length;
/** fs.watch handles alive in this process, on every platform. */
const watchers = (): number => process.getActiveResourcesInfo().filter(kind => kind === "FSEventWrap").length;
const hasDevFd = process.platform !== "win32";

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

// The installed app held 1,131 of its 1,325 descriptors on ~/.omp/logs: one per omp log since the logs dir began,
// because every omp.*.log got its own fs.watch (a kqueue descriptor on macOS, a directory handle on Windows).
test("holds no descriptor per log file and still tails the live ones", { timeout: 20_000 }, async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-log-fds-"));
	const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
	for (let i = 0; i < 300; i++) {
		const file = path.join(directory, `omp.2026-10-16.${10_000 + i}.log`);
		await fs.writeFile(file, `old run ${i}\n`);
		await fs.utimes(file, old, old);
	}
	const live = [1, 2, 3].map(i => path.join(directory, `omp.2026-10-20.${90_000 + i}.log`));
	for (const file of live) await fs.writeFile(file, "started\n");
	const fdsBefore = hasDevFd ? openFds() : 0;
	const watchersBefore = watchers();
	const watcher = new LogWatcher(directory);
	try {
		await watcher.start();
		expect(watchers() - watchersBefore).toBeLessThanOrEqual(1);
		if (hasDevFd) expect(openFds() - fdsBefore).toBeLessThanOrEqual(4);
		for (const [i, file] of live.entries()) await fs.appendFile(file, `live ${i}\n`);
		await expect
			.poll(() => [...watcher.getBuffer()].sort(), { timeout: 10_000 })
			.toEqual(["live 0", "live 1", "live 2"]);
		expect(watchers() - watchersBefore).toBeLessThanOrEqual(1);
		if (hasDevFd) expect(openFds() - fdsBefore).toBeLessThanOrEqual(4);
	} finally {
		watcher.stop();
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("a long run does not grow per new omp and keeps every line a new omp writes", { timeout: 30_000 }, async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-log-grow-"));
	const watcher = new LogWatcher(directory);
	try {
		await watcher.start();
		const fdsBefore = hasDevFd ? openFds() : 0;
		const watchersBefore = watchers();
		const expected: string[] = [];
		for (let i = 0; i < 40; i++) {
			const file = path.join(directory, `omp.2026-10-20.${20_000 + i}.log`);
			// A new omp's first line lands with the file itself, before any watcher can see it.
			await fs.writeFile(file, `omp ${i} boot\n`);
			await fs.appendFile(file, `omp ${i} done\n`);
			expected.push(`omp ${i} boot`, `omp ${i} done`);
			await expect.poll(() => watcher.getBuffer().length, { timeout: 10_000 }).toBe(expected.length);
		}
		expect([...watcher.getBuffer()].sort()).toEqual([...expected].sort());
		expect(watchers()).toBe(watchersBefore);
		if (hasDevFd) expect(openFds() - fdsBefore).toBeLessThanOrEqual(2);
	} finally {
		watcher.stop();
		await fs.rm(directory, { recursive: true, force: true });
	}
});
