import { createWriteStream, existsSync, readdirSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp } from "./harness";
import { realOmpProfile, spentIn } from "./real-omp";

// Opt-in audits on the user's small model: "Restart to update" while work runs. The update path
// is an approved quit (relaunch mode: `requestQuit()`; Squirrel: `before-quit-for-update`, then
// the same teardown), so the test approves the quit the way the update does and relaunches on
// the same userData. What continues after the relaunch is read from the journals and the files
// the work writes.

interface SessionLine {
	type?: string;
	customType?: string;
	message?: { role?: string; stopReason?: string; errorMessage?: string; content?: unknown; customType?: string };
	[key: string]: unknown;
}

interface SessionFile {
	file: string;
	lines: SessionLine[];
}

function sessionFiles(agent: string): SessionFile[] {
	const files: SessionFile[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.name.endsWith(".jsonl")) {
				const lines: SessionLine[] = [];
				for (const line of readFileSync(full, "utf8").split("\n")) {
					if (!line) continue;
					try {
						lines.push(JSON.parse(line) as SessionLine);
					} catch {}
				}
				files.push({ file: full, lines });
			}
		}
	};
	try {
		walk(path.join(agent, "sessions"));
	} catch {
		return [];
	}
	return files;
}

function text(line: SessionLine): string {
	const content = line.message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(block => (typeof block === "object" && block !== null && "text" in block ? String(block.text) : ""))
		.join("");
}

function replied(agent: string, word: string): boolean {
	return sessionFiles(agent).some(file =>
		file.lines.some(
			line => line.message?.role === "assistant" && line.message.stopReason === "stop" && text(line).includes(word),
		),
	);
}

function callsMentioning(agent: string, needle: string): number {
	let count = 0;
	for (const file of sessionFiles(agent))
		for (const line of file.lines)
			if (line.message?.role === "assistant" && JSON.stringify(line.message.content).includes(needle)) count++;
	return count;
}

/** The top-level session (not a subagent's or the advisor's) mentions `word` after the quit's `session_exit`. */
function parentGotAfterExit(agent: string, word: string): boolean {
	const sessions = path.join(agent, "sessions");
	return sessionFiles(agent).some(file => {
		if (path.relative(sessions, file.file).split(path.sep).length !== 2) return false;
		const exit = file.lines.findIndex(line => line.customType === "session_exit");
		return exit >= 0 && file.lines.slice(exit + 1).some(line => JSON.stringify(line).includes(word));
	});
}

async function markers(desktop: string): Promise<Array<{ reason: string }>> {
	try {
		return JSON.parse(await fs.readFile(path.join(desktop, "interrupted-turns.json"), "utf8"));
	} catch {
		return [];
	}
}

function summary(agent: string): string {
	return sessionFiles(agent)
		.map(
			file =>
				`## ${path.relative(path.join(agent, "sessions"), file.file)}\n${file.lines
					.map(line => {
						if (!line.message?.role) return `- ${line.type}${line.customType ? `:${line.customType}` : ""}`;
						const content = line.message.content;
						const calls = Array.isArray(content)
							? content
									.filter(b => typeof b === "object" && b !== null && "type" in b && b.type === "toolCall")
									.map(b => JSON.stringify(b).slice(0, 220))
							: [];
						return `${line.message.role} ${line.message.stopReason ?? ""} ${line.message.errorMessage ?? ""} ${calls.join(" ")} ${text(line).slice(0, 200)}`;
					})
					.join("\n")}`,
		)
		.join("\n\n");
}

/** Launches the app on `desktop`; its main-process output goes to `main.log` beside the test's other outputs. */
async function launch(desktop: string, env: Record<string, string>): Promise<{ app: ElectronApplication; page: Page }> {
	const app = await electron.launch({ args: [path.resolve("out/main/index.js"), `--user-data-dir=${desktop}`], env });
	const log = createWriteStream(test.info().outputPath("main.log"), { flags: "a" });
	log.write(`--- launch ${new Date().toISOString()}\n`);
	app.process().stdout?.pipe(log, { end: false });
	app.process().stderr?.pipe(log, { end: false });
	const page = await app.firstWindow();
	return { app, page };
}

async function ready(page: Page): Promise<void> {
	await expect
		.poll(() => page.evaluate(() => window.omp?.sidecar.getStatus()), { timeout: 90_000 })
		.toMatchObject({ status: "ready" });
}

/** The update's quit: approved the way the update approves it ("Quit anyway" if the dialog shows), then the exit. */
async function restartForUpdate(app: ElectronApplication): Promise<void> {
	const child = app.process();
	const exited = Promise.withResolvers<void>();
	child.once("exit", () => exited.resolve());
	await app.evaluate(({ app, dialog }) => {
		dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as never;
		setImmediate(() => app.quit());
	});
	await exited.promise;
}

async function prefs(desktop: string, project: string): Promise<void> {
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({
			language: "en",
			firstRunComplete: true,
			lastProject: project,
			launchProfiles: { [project]: { noExtensions: true, noSkills: true, noRules: true } },
		}),
	);
}

async function observe(name: string, data: Record<string, unknown>, agent: string): Promise<void> {
	// What the scenario spent so far (stock's `usage` on every assistant message of the agent dir).
	const body = JSON.stringify({ ...data, spent: await spentIn(agent) }, null, 2);
	console.log(`[observe ${name}] ${body}`);
	await test.info().attach(`${name}.json`, { body, contentType: "application/json" });
	await fs.writeFile(test.info().outputPath(`${name}.json`), body);
	await fs.writeFile(test.info().outputPath(`${name}-transcript.txt`), summary(agent));
}

interface Scenario {
	name: string;
	prompt: string;
	/** Starts the work instead of sending `prompt` (e.g. a goal through `set_goal`). */
	start?: (ctx: { page: Page; objective: string; agent: string }) => Promise<void>;
	/** After the relaunch, with the app up: extra state read through the window. */
	inspect?: (page: Page) => Promise<Record<string, unknown>>;
	/** Resolves once the work to cut off is under way in the first app. */
	underway: (ctx: { agent: string; project: string; page: Page; desktop: string }) => Promise<void>;
	/** After the relaunch: what continued (polled until true or the timeout). */
	continued: (ctx: { agent: string; project: string; page: Page }) => boolean | Promise<boolean>;
	extra?: (ctx: { agent: string; project: string }) => Record<string, unknown>;
}

async function run(scenario: Scenario): Promise<void> {
	const { profile, desktop, agent, env, project } = await realOmpProfile();
	await prefs(desktop, project);
	let current: ElectronApplication | undefined;
	try {
		const first = await launch(desktop, env);
		current = first.app;
		await ready(first.page);
		if (scenario.start)
			await scenario.start({ page: first.page, objective: scenario.prompt.replaceAll("$PROJECT", project), agent });
		else {
			const input = first.page.locator(".omp-composer-input").first();
			await input.fill(scenario.prompt.replaceAll("$PROJECT", project));
			await input.press("Enter");
		}
		await scenario.underway({ agent, project, page: first.page, desktop });
		const markersAtQuit = await markers(desktop);
		await first.page.screenshot({ path: test.info().outputPath("before-quit.png") });
		const quitAt = Date.now();
		await restartForUpdate(first.app);
		current = undefined;
		const markersAfterQuit = await markers(desktop);
		// The windows and tabs the relaunch restores (prefs `tabLayouts`).
		const layoutAtQuit: unknown = JSON.parse(await fs.readFile(path.join(desktop, "prefs.json"), "utf8")).tabLayouts;
		const before = sessionFiles(agent).map(file => ({
			file: path.relative(agent, file.file),
			lines: file.lines.length,
		}));

		const second = await launch(desktop, env);
		current = second.app;
		const toastSeen = second.page
			.getByText(/Continuing \d+ interrupted task/)
			.waitFor({ timeout: 120_000 })
			.then(
				() => true,
				() => false,
			);
		let continued = false;
		const deadline = Date.now() + 360_000;
		while (Date.now() < deadline) {
			if (await scenario.continued({ agent, project, page: second.page })) {
				continued = true;
				break;
			}
			await new Promise(resolve => setTimeout(resolve, 2000));
		}
		await second.page.screenshot({ path: test.info().outputPath("after-relaunch.png") });
		await observe(
			scenario.name,
			{
				markersAtQuit,
				markersAfterQuit,
				layoutAtQuit,
				toast: await toastSeen,
				continued,
				secondsAfterQuit: Math.round((Date.now() - quitAt) / 1000),
				markersAtEnd: await markers(desktop),
				sessionFilesAtQuit: before,
				...scenario.extra?.({ agent, project }),
				...(await scenario.inspect?.(second.page).catch(error => ({ inspectError: String(error) }))),
				sessionFilesAtEnd: sessionFiles(agent).map(file => ({
					file: path.relative(agent, file.file),
					lines: file.lines.length,
				})),
			},
			agent,
		);
		expect(continued, `${scenario.name}: what the relaunch should have continued`).toBe(true);
	} finally {
		if (current) await exitApp(current);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
}

const optIn = () => test.skip(process.env.OMP_GUI_REAL_WORK !== "1", "Opt-in model audit");

/** The tabs after the relaunch: a continued first turn runs in the restored tab, not in a second, hidden one. */
async function tabsAfterRelaunch(page: Page): Promise<Record<string, unknown>> {
	const tabs = await page.evaluate(() => window.omp.tabs.list());
	return { tabs: tabs.map(tab => ({ active: tab.active, status: tab.status, sessionPath: tab.sessionPath })) };
}

/** Mid-stream: the list is showing but not finished. */
async function listStreaming({ page }: { page: Page }): Promise<void> {
	await expect
		.poll(() => page.locator(".omp-transcript-content li").count(), { timeout: 180_000, intervals: [100] })
		.toBeGreaterThan(5);
}

const fruits = (word: string) =>
	`Write a numbered list of 300 distinct fruits, one per line, nothing else, and after the list a final line with exactly the word ${word}.`;

test("real omp update restart (a): a streaming reply", async () => {
	optIn();
	test.setTimeout(900_000);
	await run({
		name: "a-streaming",
		prompt: fruits("STREAM-DONE"),
		underway: listStreaming,
		// In the tab the layout restored: no second, hidden tab took the prompt.
		continued: async ({ agent, page }) =>
			replied(agent, "STREAM-DONE") && (await page.evaluate(() => window.omp.tabs.list())).length === 1,
		inspect: tabsAfterRelaunch,
	});
});

test("real omp update restart (a2): a streaming reply in the session's second turn", async () => {
	optIn();
	test.setTimeout(900_000);
	await run({
		name: "a2-streaming-second-turn",
		prompt: fruits("STREAM2-DONE"),
		start: async ({ page, objective, agent }) => {
			const input = page.locator(".omp-composer-input").first();
			await input.fill("Reply with exactly the word FIRST-OK and nothing else.");
			await input.press("Enter");
			await expect.poll(() => replied(agent, "FIRST-OK"), { timeout: 180_000 }).toBe(true);
			await expect
				.poll(async () => (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.status, {
					timeout: 60_000,
				})
				.toBe("ready");
			await input.fill(objective);
			await input.press("Enter");
		},
		underway: listStreaming,
		continued: ({ agent }) => replied(agent, "STREAM2-DONE"),
		inspect: tabsAfterRelaunch,
	});
});

test("real omp update restart (b): a running bash command", async () => {
	optIn();
	test.setTimeout(900_000);
	await run({
		name: "b-bash",
		prompt:
			"Run exactly this bash command in the foreground and wait for it: `sleep 30; date +%s >> $PROJECT/runs.txt`. When it finishes, reply with exactly the word BASH-DONE.",
		underway: async ({ agent }) => {
			await expect.poll(() => callsMentioning(agent, "runs.txt"), { timeout: 180_000 }).toBeGreaterThan(0);
			await new Promise(resolve => setTimeout(resolve, 3000));
		},
		continued: ({ agent }) => replied(agent, "BASH-DONE"),
		extra: ({ project }) => ({
			runs: existsSync(path.join(project, "runs.txt"))
				? readFileSync(path.join(project, "runs.txt"), "utf8").trim().split("\n").length
				: 0,
		}),
	});
});

const SUB_TASK =
	"Run the bash command `sleep 40; echo done >> $PROJECT/sub-done.txt` and wait for it, then yield the word SUB-FINISHED.";

test("real omp update restart (c1): a background subagent after the turn ended", async () => {
	optIn();
	test.setTimeout(900_000);
	await run({
		name: "c1-subagent-background",
		prompt: `Use the task tool to start exactly one subagent in the background (it runs as an async job), with this assignment: ${SUB_TASK} Do not wait for the subagent and do not do the work yourself: right after the task tool returns, end your turn with exactly the word SPAWNED.`,
		underway: async ({ agent }) => {
			await expect.poll(() => replied(agent, "SPAWNED"), { timeout: 240_000 }).toBe(true);
			// The subagent's own transcript has its sleep call.
			await expect
				.poll(
					() => sessionFiles(agent).filter(file => JSON.stringify(file.lines).includes("sub-done.txt")).length,
					{
						timeout: 120_000,
					},
				)
				.toBeGreaterThan(1);
			await new Promise(resolve => setTimeout(resolve, 3000));
		},
		continued: ({ agent }) => parentGotAfterExit(agent, "SUB-FINISHED"),
		extra: ({ project, agent }) => ({
			subDoneLines: existsSync(path.join(project, "sub-done.txt"))
				? readFileSync(path.join(project, "sub-done.txt"), "utf8").trim().split("\n").length
				: 0,
			parentSawResult: parentGotAfterExit(agent, "SUB-FINISHED"),
		}),
	});
});

test("real omp update restart (c2): a subagent the running turn waits for", async () => {
	optIn();
	test.setTimeout(900_000);
	await run({
		name: "c2-subagent-awaited",
		prompt: `Use the task tool to start exactly one subagent with this assignment: ${SUB_TASK} Do not do the work yourself. Wait for the subagent's result (wait on its job if it runs in the background), then reply with exactly the word PARENT-DONE.`,
		underway: async ({ agent }) => {
			await expect
				.poll(
					() => sessionFiles(agent).filter(file => JSON.stringify(file.lines).includes("sub-done.txt")).length,
					{
						timeout: 240_000,
					},
				)
				.toBeGreaterThan(1);
			await new Promise(resolve => setTimeout(resolve, 5000));
		},
		continued: ({ agent }) => replied(agent, "PARENT-DONE"),
		extra: ({ project }) => ({
			subDoneLines: existsSync(path.join(project, "sub-done.txt"))
				? readFileSync(path.join(project, "sub-done.txt"), "utf8").trim().split("\n").length
				: 0,
		}),
	});
});

test("real omp update restart (b2): a background bash job after the turn ended", async () => {
	optIn();
	test.setTimeout(900_000);
	await run({
		name: "b2-bash-background",
		prompt:
			"Start this bash command as a background job (async, do not wait for it): `sleep 40; echo done >> $PROJECT/bg-done.txt`. Right after starting it, end your turn with exactly the word STARTED.",
		underway: async ({ agent }) => {
			await expect.poll(() => replied(agent, "STARTED"), { timeout: 240_000 }).toBe(true);
			await new Promise(resolve => setTimeout(resolve, 3000));
		},
		continued: ({ project }) => existsSync(path.join(project, "bg-done.txt")),
	});
});

test("real omp update restart (d): an open ask card", async () => {
	optIn();
	test.setTimeout(900_000);
	await run({
		name: "d-ask",
		prompt:
			"Use the ask tool once to ask me the question 'Which color?' with exactly two options: red and blue. Do nothing else before I answer. After I answer, reply with exactly COLOR- followed by my answer in capitals.",
		underway: async ({ page, desktop }) => {
			await expect(page.locator(".omp-ask-dock [data-prompt-card]")).toContainText(/Which color/i, {
				timeout: 240_000,
			});
			await expect
				.poll(async () => (await markers(desktop)).map(marker => marker.reason), { timeout: 30_000 })
				.toEqual(["asking"]);
		},
		continued: async ({ page }) => (await page.locator(".omp-ask-dock [data-prompt-card]").count()) > 0,
	});
});

test("real omp update restart (e): an active goal", async () => {
	optIn();
	test.setTimeout(900_000);
	await run({
		name: "e-goal",
		prompt:
			"Append the numbers 1 to 6 to $PROJECT/goal.txt, one bash call per number, each call `sleep 8; echo N >> $PROJECT/goal.txt` with N the number, strictly one call after another. When goal.txt has all six lines, mark the goal complete.",
		start: async ({ page, objective }) => {
			expect((await page.evaluate(() => window.omp.rpc.setSetting("goal.enabled", true))).success).toBe(true);
			const response = await page.evaluate(async goal => {
				const tab = (await window.omp.tabs.list()).find(row => row.active);
				return tab ? window.omp.rpc.commandForTab(tab.tabId, { type: "set_goal", objective: goal } as never) : null;
			}, objective);
			expect(response?.success, JSON.stringify(response)).toBe(true);
		},
		inspect: async page => ({
			goalAfterRelaunch: await page.evaluate(async () => {
				const tab = (await window.omp.tabs.list()).find(row => row.active);
				return tab ? (await window.omp.rpc.commandForTab(tab.tabId, { type: "get_goal" } as never)).data : null;
			}),
		}),
		underway: async ({ project }) => {
			await expect
				.poll(
					() =>
						existsSync(path.join(project, "goal.txt"))
							? readFileSync(path.join(project, "goal.txt"), "utf8")
							: "",
					{
						timeout: 300_000,
					},
				)
				.toMatch(/2/);
		},
		continued: ({ project }) =>
			existsSync(path.join(project, "goal.txt")) &&
			readFileSync(path.join(project, "goal.txt"), "utf8").includes("6"),
		extra: ({ project }) => ({
			goal: existsSync(path.join(project, "goal.txt")) ? readFileSync(path.join(project, "goal.txt"), "utf8") : "",
		}),
	});
});
