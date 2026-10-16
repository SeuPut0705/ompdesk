import * as fs from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { _electron as electron, type Page } from "playwright";
import { exitApp } from "./harness";
import { realOmpProfile } from "./real-omp";

// Explicit opt-in (OMP_GUI_REAL_WORK=1): spends a few turns on the user's `smol` model in a private disposable
// profile. Real stock omp with the control tools registered through `set_host_tools`:
//  1. "세션 2개 만들어서 각각 시키고 결과 정리": the main agent opens two sessions, hands each a task, waits and
//     summarizes them (the user's exact request).
//  2. A subagent (stock's `task`) has no control tools: host tools live on the RPC session only.
const RESULT_FILE = "/tmp/real-agent-control.json";
const results: Record<string, unknown>[] = [];

test.afterAll(async () => {
	if (results.length > 0) await fs.writeFile(RESULT_FILE, JSON.stringify(results, null, 2));
});

async function launch(prompt: string) {
	const real = await realOmpProfile({ launchProfiles: {} });
	const app = await electron.launch({
		args: [`${process.cwd()}/out/main/index.js`, real.project, `--user-data-dir=${real.desktop}`],
		env: { ...real.env, OMP_GUI_HEADLESS: "1" },
	});
	const page = await app.firstWindow();
	await expect
		.poll(() => page.evaluate(() => window.omp?.sidecar.getStatus()), { timeout: 120_000 })
		.toMatchObject({ status: "ready" });
	const main = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId ?? "";
	const composer = page.locator("textarea").first();
	await composer.fill(prompt);
	await composer.press("Enter");
	return { real, app, page, main };
}

async function lastAnswer(page: Page, tabId: string): Promise<string> {
	const response = await page.evaluate(
		id => window.omp.rpc.commandForTab(id, { type: "get_last_assistant_text" }),
		tabId,
	);
	return (response.data as { text?: string | null } | undefined)?.text ?? "";
}

test("세션 2개 만들어서 각각 시키고 결과 정리", async () => {
	test.skip(process.env.OMP_GUI_REAL_WORK !== "1", "Opt-in model audit");
	test.setTimeout(600_000);
	const { real, app, page, main } = await launch(
		"세션 2개 만들어서 각각 시키고 결과 정리해 줘. 첫 번째 세션에는 '1+1은 얼마인지 한 문장으로 답해'를, 두 번째 세션에는 '프랑스의 수도가 어디인지 한 문장으로 답해'를 시켜. 둘 다 끝나면 두 답을 여기에 한 줄씩 정리해 줘. 파일은 건드리지 마.",
	);
	try {
		// The skill rides in with the tools (the built-in root is a `-e` directory while the switch is on).
		const skills = await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "get_skills" }), main);
		expect(JSON.stringify(skills.data)).toContain('"ompdesk"');
		// Two more tabs: the sessions the agent opened.
		await expect
			.poll(async () => (await page.evaluate(() => window.omp.tabs.list())).length, { timeout: 300_000 })
			.toBeGreaterThanOrEqual(3);
		const tabs = await page.evaluate(() => window.omp.tabs.list());
		const children = tabs.filter(tab => tab.tabId !== main).map(tab => tab.tabId);
		// The main agent finishes its own turn with the summary.
		await expect
			.poll(
				async () =>
					(await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "get_state" }), main)).data as
						| { isStreaming?: boolean }
						| undefined,
				{ timeout: 420_000 },
			)
			.toMatchObject({ isStreaming: false });
		const answers = await Promise.all(children.map(id => lastAnswer(page, id)));
		const summary = await lastAnswer(page, main);
		results.push({ case: "two sessions", children: children.length, answers, summary });
		expect(children.length).toBeGreaterThanOrEqual(2);
		expect(answers.filter(text => text.length > 0).length).toBeGreaterThanOrEqual(2);
		expect(answers.join(" ")).toMatch(/2|둘|이/);
		expect(answers.join(" ")).toMatch(/파리|Paris/i);
		expect(summary).toMatch(/파리|Paris/i);
	} finally {
		await exitApp(app);
		await fs.rm(real.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("a subagent has no control tools", async () => {
	test.skip(process.env.OMP_GUI_REAL_WORK !== "1", "Opt-in model audit");
	test.setTimeout(420_000);
	const { real, app, page, main } = await launch(
		"task 도구로 서브에이전트 하나를 시켜: 'ompdesk_session_open 도구를 호출해 세션을 열어 봐. 그런 도구가 없으면 NO_TOOL 한 단어만 답해.' 나는 ompdesk 도구를 직접 쓰지 말고, 서브에이전트가 뭐라고 답했는지만 한 줄로 알려 줘.",
	);
	try {
		// The turn has started and ended: an answer exists and nothing streams.
		await expect
			.poll(
				async () => {
					const state = (await page.evaluate(id => window.omp.rpc.commandForTab(id, { type: "get_state" }), main))
						.data as { isStreaming?: boolean } | undefined;
					return state?.isStreaming === false && (await lastAnswer(page, main)).length > 0;
				},
				{ timeout: 360_000, intervals: [2_000] },
			)
			.toBe(true);
		const tabs = await page.evaluate(() => window.omp.tabs.list());
		const summary = await lastAnswer(page, main);
		results.push({ case: "subagent", tabs: tabs.length, summary });
		// No session was opened behind the user's back.
		expect(tabs).toHaveLength(1);
		expect(summary.length).toBeGreaterThan(0);
	} finally {
		await exitApp(app);
		await fs.rm(real.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
