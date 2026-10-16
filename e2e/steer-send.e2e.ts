/**
 * A message sent while a turn runs is a steer (stock `steer`), whichever way it is sent:
 * plain Enter, the Send button, and the platform's send chord (⌘↵ on macOS, Ctrl+Enter on
 * Windows, the chord the expanded composer advertises). Only the follow-up chord (⌃↵ on
 * macOS, Alt+Enter on Windows) queues a `follow_up` for after the turn. On Windows,
 * Ctrl+Enter used to read as the follow-up chord, so a Windows user's "추가 지시" waited
 * in the follow-up lane until the turn ended.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { exitApp, launchApp } from "./harness";

const WINDOWS = process.platform === "win32";
const SEND_CHORD = WINDOWS ? "Control+Enter" : "Meta+Enter";
const FOLLOW_UP_CHORD = WINDOWS ? "Alt+Enter" : "Control+Enter";

async function frames(file: string): Promise<Array<{ type: string; message?: unknown }>> {
	const text = await fs.readFile(file, "utf8").catch(() => "");
	return text
		.split("\n")
		.filter(Boolean)
		.map((line): unknown => JSON.parse(line))
		.filter(
			(frame): frame is { type: string; message?: unknown } =>
				typeof frame === "object" && frame !== null && "type" in frame && typeof frame.type === "string",
		)
		.filter(frame => frame.type === "steer" || frame.type === "follow_up");
}

async function lanes(page: Page): Promise<{ steering: string[]; followUp: string[] }> {
	return page.evaluate(async () => {
		const response = await window.omp.rpc.getQueue();
		const data = response.data as { steering: { text: string }[]; followUp: { text: string }[] };
		return { steering: data.steering.map(item => item.text), followUp: data.followUp.map(item => item.text) };
	});
}

test("@smoke a message sent while a turn runs steers it from Enter, the Send button and the send chord; only the follow-up chord queues", async () => {
	test.setTimeout(90_000);
	const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-steer-send-")));
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	const project = path.join(profile, "project");
	const record = path.join(profile, "commands.jsonl");
	await Promise.all([fs.mkdir(desktop), fs.mkdir(agent), fs.mkdir(project)]);
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	const app = await launchApp({
		project,
		desktop,
		agent,
		profile,
		env: {
			OMP_GUI_TEST_RECORD: record,
		},
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	try {
		await page.waitForFunction(() => window.omp?.rpc != null);
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
			.toBe("ready");
		const input = page.locator("textarea").first();
		await input.fill("fixture running");
		await input.press("Enter");
		await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
		// The send-mode chip reads Steer: nothing has switched it to follow-ups.
		await expect(page.locator("[data-send-mode]")).toHaveAttribute("data-send-mode", "steer");

		/** The stock command the fake omp received for `message`. */
		const sentAs = async (message: string, type: "steer" | "follow_up") => {
			await expect(input).toHaveValue("");
			await expect
				.poll(async () => (await frames(record)).find(frame => frame.message === message)?.type)
				.toBe(type);
		};

		await input.fill("steer by enter");
		await input.press("Enter");
		await sentAs("steer by enter", "steer");

		await input.fill("steer by button");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await sentAs("steer by button", "steer");

		await input.fill("steer by chord");
		await input.press(SEND_CHORD);
		await sentAs("steer by chord", "steer");

		// Every steer waits in stock's steering lane for the loop's next step; none is a follow-up.
		expect(await lanes(page)).toEqual({
			steering: ["steer by enter", "steer by button", "steer by chord"],
			followUp: [],
		});

		await input.fill("later by chord");
		await input.press(FOLLOW_UP_CHORD);
		await sentAs("later by chord", "follow_up");
		expect((await lanes(page)).followUp).toEqual(["later by chord"]);
		expect(errors).toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
