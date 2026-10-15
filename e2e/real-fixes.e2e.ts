import * as fs from "node:fs/promises";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, pressShortcutUntilVisible } from "./harness";
import { realOmpProfile } from "./real-omp";

// Explicit opt-in audit on the user's small model, for the two defects that only
// reproduce with the real omp (a fake omp has no per-turn prompt hooks and prints no
// server address):
//  - the context inspector must list OMPdesk's own per-turn prompt sections (reply
//    language, profile, reply style): stock holds what `before_agent_start` appended only
//    while a turn runs, so `session.systemPrompt` lacks them before the first turn and
//    after any rebuild of the base prompt;
//  - a server that prints a wildcard address (python's http.server: `http://[::]:PORT/`)
//    must be offered in Preview on localhost.
interface InspectEntry {
	id: string;
	category: string;
}

async function command<T>(page: Page, tabId: string, body: Record<string, unknown>): Promise<T> {
	const response = await page.evaluate(
		([id, command]) => window.omp.rpc.commandForTab(id as string, command as never),
		[tabId, body] as const,
	);
	if (!response.success) throw new Error(`${String(body.type)} failed: ${response.error}`);
	return response.data as T;
}

/** Every system prompt entry the inspector lists, as the provider text, joined. */
async function inspectedPrompt(page: Page, tabId: string): Promise<string> {
	const inspected = await command<{ entries: InspectEntry[] }>(page, tabId, {
		type: "get_context_inspect",
		entries: true,
	});
	const texts: string[] = [];
	for (const entry of inspected.entries.filter(row => row.id.startsWith("prompt:"))) {
		const { text } = await command<{ text: string }>(page, tabId, { type: "get_context_entry", entryId: entry.id });
		texts.push(text);
	}
	return texts.join("\n\n");
}

async function turn(page: Page, prompt: string): Promise<void> {
	const input = page.locator("textarea").first();
	await input.fill(prompt);
	await input.press("Enter");
	await expect(page.getByPlaceholder(/Steer omp|Add an instruction/)).toBeVisible({ timeout: 60_000 });
	await expect(page.getByPlaceholder(/Ask omp anything|Ask anything ·/)).toBeVisible({ timeout: 300_000 });
}

test("real omp: inspector shows the per-turn prompt sections; Preview offers a wildcard-address server", async () => {
	test.skip(process.env.OMP_GUI_REAL_WORK !== "1", "Opt-in model audit");
	test.setTimeout(900_000);
	const { profile, project, desktop, env } = await realOmpProfile({
		replyLanguage: "Korean",
		userProfile: { name: "Seu", experience: "beginner" },
		outputStyle: "concise",
	});
	const log = path.join(profile, "server.log");
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env,
	});
	try {
		const page = await app.firstWindow();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
		await expect
			.poll(() => page.evaluate(() => window.omp.sidecar.getStatus()), { timeout: 60_000 })
			.toMatchObject({ status: "ready" });
		const tab = (await page.evaluate(() => window.omp.tabs.list())).find(row => row.active);
		if (!tab) throw new Error("No active tab");

		// Before any turn stock's prompt holds none of them (the hook adds them as a turn starts), yet this
		// is the prompt the next turn sends; after a turn omp keeps its override only until the next rebuild.
		for (const moment of ["before the first turn", "after a turn"]) {
			if (moment === "after a turn") await turn(page, "Reply with exactly the word hello. Do not use any tools.");
			const prompt = () => inspectedPrompt(page, tab.tabId);
			// Polled: the profile and reply style reach the bridge a moment after the session is ready.
			const options = { timeout: 20_000 };
			await expect.soft
				.poll(prompt, { ...options, message: `reply language section ${moment}` })
				.toContain("<reply-language>");
			await expect.soft
				.poll(prompt, { ...options, message: `profile section ${moment}` })
				.toContain("<user-profile>");
			await expect.soft
				.poll(prompt, { ...options, message: `reply style section ${moment}` })
				.toContain("<output-style>");
			const text = await prompt();
			expect
				.soft(text.match(/<reply-language>/g)?.length ?? 0, `reply language listed once ${moment}`)
				.toBeLessThan(2);
			await fs.writeFile(path.join(profile, `inspected-prompt-${moment.replaceAll(" ", "-")}.txt`), text);
		}

		await turn(
			page,
			`Run exactly this one bash command and nothing else: python3 -u -m http.server 4795 > ${log} 2>&1 & sleep 3; cat ${log}; kill %1`,
		);
		expect(await fs.readFile(log, "utf8")).toMatch(/Serving HTTP on (::|0\.0\.0\.0) port 4795/);
		const aside = page.locator("aside[data-docked]");
		await pressShortcutUntilVisible(page, "ControlOrMeta+j", aside);
		await aside.getByRole("button", { name: "Preview", exact: true }).click();
		await expect(page.getByRole("textbox", { name: "Preview URL" })).toHaveValue("http://localhost:4795/");
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
