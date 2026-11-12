import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { exitApp, launchApp } from "./harness";

// What a session's omp started ends when its tab closes, also a process whose parent is gone, and nobody else's does;
// when memory is short one log line says which sessions hold it (src/main/session-processes.ts, memory-record.ts). The
// rules are tested in session-processes.test.ts and memory-record.test.ts on real processes through the real core;
// this spec runs the app's own wiring on the fake omp: the tag in the omp's environment, the close, the log.

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

interface LogLine {
	source: string;
	message: string;
	details?: Record<string, unknown>;
}

test("a closed session's detached process ends with it, another session's stays, and a short spell names who holds memory", async () => {
	test.setTimeout(120_000);
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-session-processes-"));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	const memory = path.join(profile, "memory.json");
	const setMemory = (availableGb: number) =>
		fs.writeFile(memory, JSON.stringify({ totalGb: 16, availableGb, pressure: "normal" }));
	await setMemory(8);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	const app = await launchApp({
		project,
		desktop,
		agent,
		profile,
		env: { OMP_GUI_TEST_SESSION_FILES: "1", OMP_GUI_TEST_MEMORY: memory, OMP_GUI_TEST_MEMORY_MS: "200" },
	});
	const started: number[] = [];
	try {
		const page = await app.firstWindow();
		await page.waitForFunction(() => window.omp?.rpc != null);
		const status = async (id: string) =>
			(await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === id)?.status;
		const lines = async (): Promise<LogLine[]> =>
			(await fs.readFile(path.join(desktop, "logs", "gui-runtime.jsonl"), "utf8").catch(() => ""))
				.split("\n")
				.filter(Boolean)
				.map(line => JSON.parse(line) as LogLine);
		/** A background tab whose omp left a detached process running; resolves with that process's pid. */
		const tabWithLeftover = async (name: string) => {
			const tabId =
				(await page.evaluate(cwd => window.omp.tabs.spawn({ cwd, kind: "agent" }), project))?.tabId ?? "";
			await expect.poll(() => status(tabId)).toBe("ready");
			const pidFile = path.join(profile, `${name}.pid`);
			await page.evaluate(
				([id, message]) => window.omp.rpc.commandForTab(id ?? "", { type: "prompt", message: message ?? "" }),
				[tabId, `fixture detached child:${pidFile}`],
			);
			// The fake omp writes the pid once the process is started and ends the turn.
			await expect.poll(() => fs.readFile(pidFile, "utf8").catch(() => ""), { timeout: 30_000 }).toMatch(/^\d+$/);
			await expect.poll(() => status(tabId)).toBe("ready");
			const pid = Number(await fs.readFile(pidFile, "utf8"));
			started.push(pid);
			return { tabId, pid };
		};
		const closing = await tabWithLeftover("closing");
		const staying = await tabWithLeftover("staying");
		expect([alive(closing.pid), alive(staying.pid)]).toEqual([true, true]);

		// Short: one line names the sessions that hold memory, each with its folder.
		await setMemory(1.5);
		await expect
			.poll(async () => (await lines()).some(line => line.source === "memory" && line.message === "memory short"), {
				timeout: 30_000,
			})
			.toBe(true);
		const short = (await lines()).find(line => line.source === "memory" && line.message === "memory short");
		const sessions = JSON.parse(String(short?.details?.sessions)) as Array<{ folder?: string; processes: number }>;
		// Each of the two tabs: its omp and the process the omp left.
		const here = sessions.filter(entry => entry.folder !== undefined && path.basename(entry.folder) === "project");
		expect(here.filter(entry => entry.processes >= 2).length).toBeGreaterThanOrEqual(2);
		expect(JSON.parse(String(short?.details?.top))).toHaveLength(8);
		await setMemory(8);

		// Closed: what it started is gone; the other session's process is not touched.
		expect(await page.evaluate(id => window.omp.tabs.close(id), closing.tabId)).toBe(true);
		await expect.poll(() => alive(closing.pid), { timeout: 30_000 }).toBe(false);
		expect(alive(staying.pid)).toBe(true);
		await expect
			.poll(
				async () => (await lines()).filter(line => line.source === "session-processes").map(line => line.message),
				{ timeout: 15_000 },
			)
			.toEqual(["ended"]);
		const ended = (await lines()).find(line => line.source === "session-processes");
		expect(ended?.details).toMatchObject({ reason: "closed", session: expect.stringMatching(/\.jsonl$/) });
		expect(Number(ended?.details?.processes)).toBeGreaterThanOrEqual(1);
	} finally {
		await exitApp(app);
		for (const pid of started) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
