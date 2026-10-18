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

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

for (const language of ["en", "ko"] as const) {
	test(`a picture sent as a steer shows in the tray, and a picture-only steer reads in the interface language (${language})`, async () => {
		test.setTimeout(90_000);
		const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-steer-image-")));
		const desktop = path.join(profile, "desktop");
		const agent = path.join(profile, "agent");
		const project = path.join(profile, "project");
		await Promise.all([fs.mkdir(desktop), fs.mkdir(agent), fs.mkdir(project)]);
		await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language, firstRunComplete: true }));
		const app = await launchApp({ project, desktop, agent, profile });
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
			await expect(page.locator("[data-send-mode]")).toHaveAttribute("data-send-mode", "steer");

			const rows = page.locator(".omp-composer-queue li");
			const paste = async (caption: string, rowsAfter: number) => {
				await input.focus();
				await page.evaluate(
					([png, text]) => {
						const field = document.querySelector<HTMLTextAreaElement>("textarea[data-composer-input]");
						const data = new DataTransfer();
						data.items.add(
							new File([Uint8Array.from(atob(png), c => c.charCodeAt(0))], "p.png", { type: "image/png" }),
						);
						if (text) data.setData("text/plain", text);
						field?.dispatchEvent(
							new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
						);
					},
					[PNG, caption] as const,
				);
				await input.press("Enter");
				// The next send waits for this one to reach the queue (a send in flight ignores Enter).
				await expect(rows).toHaveCount(rowsAfter);
			};

			await paste("look at this picture", 1);
			await paste("", 2);
			const counts = language === "en" ? "1 image" : "이미지 1개";
			const wordOnly = language === "en" ? "[Image]" : "[이미지]";
			// The stock queue lane carries text only; the tray still says a picture went with each steer.
			await expect(rows.nth(0)).toContainText("look at this picture");
			await expect(rows.nth(0).locator("[data-queue-images]")).toHaveText(counts);
			await expect(rows.nth(1)).toContainText(wordOnly);
			await expect(rows.nth(1).locator("[data-queue-images]")).toHaveText(counts);
			expect(errors).toEqual([]);
		} finally {
			await exitApp(app);
			await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});
}
