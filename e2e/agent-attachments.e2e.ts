import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import type { ElectronApplication, Page } from "playwright";
import { exitApp, launchApp, readRecords, untilAnswered } from "./harness";

// Attachments of the control tools (native/ompdesk/crates/core/src/agentctl/service/attach.rs): a session sends another the picture the
// person pasted into it ({image: 1}) and a text file ({path}). The picture reaches the target's stock `prompt` as an
// inline image; the file lands in this computer's upload folder and the message names its path. The fake omp reads
// both where the caller runs (`agent_control.attachment`) and records every command it receives.

let app: ElectronApplication;
let page: Page;
let profile: string;
let project: string;
let record: string;
let errors: string[];
let main: string;

// A 1x1 PNG.
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);
const NOTES = "the notes the other session reads\n";

test.beforeEach(async () => {
	profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-agent-attach-"));
	project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(agent)]);
	record = path.join(profile, "rpc.jsonl");
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	await fs.writeFile(path.join(project, "notes.txt"), NOTES);
	app = await launchApp({
		project,
		desktop,
		agent,
		profile,
		env: { OMP_GUI_HEADLESS: "1", OMP_GUI_TEST_RECORD: record },
	});
	page = await app.firstWindow();
	errors = [];
	page.on("pageerror", error => errors.push(error.message));
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status).toBe("ready");
	main = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId ?? "";
	expect(main).not.toBe("");
});

test.afterEach(async () => {
	if (app) await exitApp(app);
	if (record) await fs.copyFile(record, test.info().outputPath("rpc.jsonl")).catch(() => {});
	if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	expect(errors).toEqual([]);
});

async function results(): Promise<{ text: string; isError: boolean }[]> {
	const frames = await readRecords(record);
	return frames
		.filter(frame => frame.type === "host_tool_result" && frame.recordedBy !== undefined)
		.map(frame => {
			const result = frame.result as { content?: { text?: string }[] } | undefined;
			return { text: result?.content?.[0]?.text ?? "", isError: frame.isError === true };
		});
}

/** The main agent calls a control tool; resolves with the result text the agent gets back. */
async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
	const before = (await results()).length;
	const response = await page.evaluate(
		([id, command]) => window.omp.rpc.commandForTab(id, { type: "bash", command }),
		[main, `fixture:host-tool:${name} ${JSON.stringify(args)}`] as const,
	);
	expect(response).toMatchObject({ success: true });
	await expect.poll(async () => (await results()).length, { timeout: 90_000 }).toBe(before + 1);
	return (await results())[before] as { text: string; isError: boolean };
}

test("a session sends another the picture the person pasted and a text file; the target's prompt has the image and the file's path", async () => {
	test.setTimeout(150_000);
	// The person pastes a screenshot into the main session: a prompt with an image block.
	const pasted = await page.evaluate(
		([id, data]) =>
			window.omp.rpc.commandForTab(id, {
				type: "prompt",
				message: "Here is the screenshot",
				images: [{ type: "image", data, mimeType: "image/png" }],
			}),
		[main, PNG.toString("base64")] as const,
	);
	expect(pasted).toMatchObject({ success: true });
	await expect(page.getByText("Local fixture reply").first()).toBeVisible({ timeout: 30_000 });

	const opened = await call("ompdesk_session_open", { message: "Wait for a message", show: "background" });
	expect(opened.isError).toBe(false);
	const child = /Opened session (\w+)/.exec(opened.text)?.[1] ?? "";
	expect(child).not.toBe("");
	await untilAnswered(page, child);

	const sent = await call("ompdesk_session_send", {
		session: child,
		message: "Look at the screenshot and read the notes",
		attachments: [{ image: 1 }, { path: "notes.txt" }],
	});
	expect(sent.isError, sent.text).toBe(false);
	expect(sent.text).toContain("attached: 2 (1 image inline, 1 file at ");
	await untilAnswered(page, child, { after: "Look at the screenshot and read the notes" });

	const prompt = (await readRecords(record)).findLast(
		frame => frame.type === "prompt" && String(frame.message).includes("Look at the screenshot and read the notes"),
	) as { message: string; images?: { type: string; data: string; mimeType: string }[] } | undefined;
	expect(prompt?.images).toEqual([{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }]);
	const landed = /Attached: (.+notes\.txt)/.exec(prompt?.message ?? "")?.[1] ?? "";
	expect(landed).not.toBe("");
	// The file is on this computer, where the target's omp reads it by that path.
	expect(await fs.readFile(landed, "utf8")).toBe(NOTES);
	expect(sent.text).toContain(landed);

	// A file that is missing refuses the whole send: nothing reaches the session.
	const before = (await readRecords(record)).filter(frame => frame.type === "prompt").length;
	const refused = await call("ompdesk_session_send", {
		session: child,
		message: "This never arrives",
		attachments: [{ path: "notes.txt" }, { path: "missing.pdf" }],
	});
	expect(refused.isError).toBe(true);
	expect(refused.text).toContain("attachment 2 (missing.pdf) could not be read");
	expect((await readRecords(record)).filter(frame => frame.type === "prompt")).toHaveLength(before);
});
