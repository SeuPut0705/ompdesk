import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { ElectronApplication } from "playwright";
import { controlToolCaller, exitApp, launchApp, openedSessions, untilAnswered } from "./harness";

// New agent work waits while this computer's memory is in danger (src/main/memory-admission.ts; the owner's rule of
// 2 Nov 2026, after one call opened 8 sessions on a 16 GB Mac that then grew to 29.9 GB). The test launch reads its
// memory from OMP_GUI_TEST_MEMORY, a file this spec rewrites, every OMP_GUI_TEST_MEMORY_MS. The policy itself (the
// prediction, pressure, order, parents and children, Start now) is unit-tested in memory-admission.test.ts; this spec
// runs the real wiring: control tools, the fake omp's turns, the tab status every view reads, the runtime log.

let app: ElectronApplication;
let page: Page;
let profile: string;
let record: string;
let memory: string;
let desktop: string;
let errors: string[];

const setMemory = (availableGb: number, pressure: "normal" | "warn" | "critical" = "normal") =>
	fs.writeFile(memory, JSON.stringify({ totalGb: 16, availableGb, pressure }));

test.beforeEach(async () => {
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-memory-"));
	const project = path.join(profile, "project");
	desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	record = path.join(profile, "rpc.jsonl");
	memory = path.join(profile, "memory.json");
	// 3 GB free of 16: less than one expected session (2.5 GB) above the 2.4 GB kept free.
	await setMemory(3);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	app = await launchApp({
		project,
		desktop,
		agent,
		profile,
		env: {
			OMP_GUI_HEADLESS: "1",
			OMP_GUI_TEST_RECORD: record,
			OMP_GUI_TEST_MEMORY: memory,
			OMP_GUI_TEST_MEMORY_MS: "200",
		},
	});
	page = await app.firstWindow();
	errors = [];
	page.on("pageerror", error => errors.push(error.message));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
});

test.afterEach(async () => {
	if (app) await exitApp(app);
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	expect(errors).toEqual([]);
});

/** Each tab's place in the line, or 0 when it does not wait. */
async function positions(ids: readonly string[]): Promise<number[]> {
	const tabs = await page.evaluate(() => window.omp.tabs.list());
	return ids.map(id => tabs.find(tab => tab.tabId === id)?.memoryWait?.position ?? 0);
}

async function runtimeLog(): Promise<Array<{ source?: string; message?: string }>> {
	const text = await fs.readFile(path.join(desktop, "logs", "gui-runtime.jsonl"), "utf8").catch(() => "");
	return text
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as { source?: string; message?: string });
}

test("a burst of 8 agent sessions waits for memory in order and starts by itself as memory frees; the person's prompt never waits", async () => {
	test.setTimeout(180_000);
	const call = await controlToolCaller(page, record);
	const main = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId ?? "";
	const open = await call("ompdesk_session_open", {
		sessions: Array.from({ length: 8 }, (_, i) => ({ message: `Task ${i + 1}` })),
	});
	expect(open.isError, open.text).toBe(false);
	const ids = openedSessions(open.text);
	expect(ids).toHaveLength(8);
	// The agent is told each one waits and starts by itself, so it sends nothing again.
	expect(
		open.text.match(/waiting for memory: 3 GB free of 16 GB \(pressure normal\); #\d in line; it starts by itself/g),
	).toHaveLength(8);
	await expect.poll(async () => [...(await positions(ids))].sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

	// The person's own prompt runs at once, whatever memory says.
	const own = await page.evaluate(
		id => window.omp.rpc.commandForTab(id, { type: "prompt", message: "my own question" }),
		main,
	);
	expect(own).toMatchObject({ success: true });
	expect((own as { data?: { memoryWait?: unknown } }).data?.memoryWait).toBeUndefined();
	await untilAnswered(page, main);
	expect(await positions(ids)).not.toContain(0);

	// Memory frees: every waiting session starts by itself and answers its own brief.
	await setMemory(13);
	await expect.poll(async () => positions(ids), { timeout: 60_000 }).toEqual(Array(8).fill(0));
	for (const id of ids) await untilAnswered(page, id);
	const lines = await runtimeLog();
	expect(lines.filter(line => line.source === "memory" && line.message === "memory hold")).toHaveLength(8);
	expect(
		lines.filter(line => line.source === "memory" && line.message === "memory release").length,
	).toBeGreaterThanOrEqual(8);
});

test("pressure warn holds a start and normal releases it", async () => {
	test.setTimeout(120_000);
	await setMemory(12, "warn");
	const call = await controlToolCaller(page, record);
	const open = await call("ompdesk_session_open", { message: "Under pressure" });
	const [id] = openedSessions(open.text);
	expect(open.text).toContain("waiting for memory: 12 GB free of 16 GB (pressure warn); #1 in line");
	await expect.poll(async () => positions([id as string])).toEqual([1]);
	await setMemory(12, "normal");
	await untilAnswered(page, id as string);
});

test("a parent waiting on its held child with ompdesk_session_result gets its answer under tight memory", async () => {
	test.setTimeout(120_000);
	const call = await controlToolCaller(page, record);
	const open = await call("ompdesk_session_open", { message: "Child work" });
	const [id] = openedSessions(open.text);
	expect(open.text).toContain("waiting for memory");
	// Memory stays at 3 GB: only the parent's wait lets the child start.
	const result = await call("ompdesk_session_result", { session: id, wait: true, timeout_seconds: 60 });
	expect(result.isError, result.text).toBe(false);
	expect(result.text).toContain("Local fixture reply");
	expect(result.text).not.toContain("Still running");
});

test("Start now on the waiting row starts that session at once", async () => {
	test.setTimeout(120_000);
	const call = await controlToolCaller(page, record);
	const open = await call("ompdesk_session_open", { message: "Owner wants it now", show: "focus" });
	const [id] = openedSessions(open.text);
	const row = page.getByText(/Waiting for memory/).first();
	await expect(row).toBeVisible({ timeout: 30_000 });
	await expect(page.getByText(/3 GB free of 16 GB/).first()).toBeVisible();
	await page.getByRole("button", { name: "Start now" }).click();
	await untilAnswered(page, id as string);
	expect((await runtimeLog()).some(line => line.message === "memory start now")).toBe(true);
});
