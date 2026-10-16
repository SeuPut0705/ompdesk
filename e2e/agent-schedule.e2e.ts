import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { exitApp, launchApp, readRecords } from "./harness";

// Scheduled orchestration and delegation memory of the control tools (src/main/agent-control): the agent's
// `ompdesk_schedule` puts a run on the real Schedules service (behind a confirmation card, never auto-approved,
// listable and cancellable), and `ompdesk_remember` appends one lesson to stock's memory only when the user's memory
// can save (the fake omp's `OMP_GUI_TEST_MEMORY=1`).

let app: ElectronApplication;
let page: Page;
let root: string;
let desktop: string;
let record: string;
let main: string;
let errors: string[];

async function launch(env: Record<string, string> = {}): Promise<void> {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-agent-schedule-")));
	const project = path.join(root, "project");
	desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	record = path.join(root, "rpc.jsonl");
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({ language: "en", firstRunComplete: true, batchNotifications: false }),
	);
	app = await launchApp({
		project,
		desktop,
		agent,
		profile: root,
		env: { OMP_GUI_HEADLESS: "1", OMP_GUI_TEST_RECORD: record, ...env },
	});
	page = await app.firstWindow();
	errors = [];
	page.on("pageerror", error => errors.push(error.message));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
	main = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId ?? "";
}

test.afterEach(async () => {
	if (app) await exitApp(app);
	if (record) await fs.copyFile(record, test.info().outputPath("rpc.jsonl")).catch(() => {});
	if (root) await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	expect(errors).toEqual([]);
});

async function results(): Promise<{ text: string; isError: boolean }[]> {
	return (await readRecords(record))
		.filter(frame => frame.type === "host_tool_result")
		.map(frame => {
			const result = frame.result as { content?: { text?: string }[] } | undefined;
			return { text: result?.content?.[0]?.text ?? "", isError: frame.isError === true };
		});
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
	const before = (await results()).length;
	const response = await page.evaluate(
		([id, line]) => window.omp.rpc.commandForTab(id, { type: "bash", command: line }),
		[main, `fixture:host-tool:${name} ${JSON.stringify(args)}`] as const,
	);
	expect(response).toMatchObject({ success: true });
	await expect.poll(async () => (await results()).length, { timeout: 90_000 }).toBe(before + 1);
	return (await results())[before] as { text: string; isError: boolean };
}

async function savedSchedules(): Promise<
	{ name: string; autoApprove: boolean; enabled: boolean; frequency: unknown }[]
> {
	const text = await fs.readFile(path.join(desktop, "schedules.json"), "utf8").catch(() => "{}");
	return (
		(
			JSON.parse(text) as {
				schedules?: { name: string; autoApprove: boolean; enabled: boolean; frequency: unknown }[];
			}
		).schedules ?? []
	);
}

const card = () => page.locator("[data-prompt-card]").getByText("[OMPdesk]").first();

test("a schedule needs the user's card, is the agent's own, never auto-approves, and can be listed and cancelled", async () => {
	test.setTimeout(150_000);
	await launch();
	const args = { action: "create", name: "nightly audit", prompt: "Audit the repo and report.", every_minutes: 90 };

	const declined = call("ompdesk_schedule", args);
	await expect(card()).toBeVisible({ timeout: 30_000 });
	await page.locator("[data-prompt-card] [data-choice='deny']").click();
	expect((await declined).text).toContain("The user declined the schedule");
	expect(await savedSchedules()).toEqual([]);

	const created = call("ompdesk_schedule", args);
	await expect(card()).toBeVisible({ timeout: 30_000 });
	await page.locator("[data-prompt-card] [data-choice='approve']").click();
	const made = await created;
	expect(made.isError).toBe(false);
	expect(made.text).toContain("Scheduled “[agent] nightly audit” every 90 min");
	await expect.poll(async () => (await savedSchedules()).length).toBe(1);
	expect((await savedSchedules())[0]).toMatchObject({
		name: "[agent] nightly audit",
		autoApprove: false,
		enabled: true,
		frequency: { kind: "interval", minutes: 90 },
	});

	const tooOften = await call("ompdesk_schedule", { ...args, name: "x", every_minutes: 10 });
	expect(tooOften.isError).toBe(true);
	expect(tooOften.text).toContain("at least 30");

	const listed = await call("ompdesk_schedule", { action: "list" });
	expect(listed.text).toContain("[agent] nightly audit");
	expect(listed.text).toContain("[made by an agent: you can cancel it]");
	const id = /^- ([\w-]+) /.exec(listed.text)?.[1] ?? "";
	expect(id).not.toBe("");
	const cancelled = await call("ompdesk_schedule", { action: "cancel", id });
	expect(cancelled.text).toContain("Cancelled");
	await expect.poll(async () => (await savedSchedules()).length).toBe(0);
});

test("a delegation lesson goes to memory after an orchestration, only when memory can save", async () => {
	test.setTimeout(150_000);
	await launch({ OMP_GUI_TEST_MEMORY: "1" });
	const lesson = "Splitting the audit by folder worked; two sessions on one file collided.";
	expect((await call("ompdesk_remember", { lesson })).text).toContain("orchestrated sessions");
	const opened = await call("ompdesk_session_open", { message: "part one" });
	expect(opened.isError).toBe(false);
	const saved = await call("ompdesk_remember", { lesson });
	expect(saved.isError).toBe(false);
	expect(saved.text).toContain("Saved to the user's memory");
	const request = (await readRecords(record)).find(frame => frame.type === "memory_save");
	expect(request?.content).toBe(`OMPdesk delegation lesson: ${lesson}`);
});

test("with memory off nothing is saved", async () => {
	test.setTimeout(150_000);
	await launch();
	await call("ompdesk_session_open", { message: "part one" });
	const result = await call("ompdesk_remember", { lesson: "Split by folder, not by file." });
	expect(result.isError).toBe(false);
	expect(result.text).toContain("memory is off");
	expect((await readRecords(record)).some(frame => frame.type === "memory_save")).toBe(false);
});
