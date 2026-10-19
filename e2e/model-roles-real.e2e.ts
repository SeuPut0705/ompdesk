import * as fs from "node:fs/promises";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { AGENT_TEMPLATES } from "../src/shared/agent-templates";
import type { ModelRoleEntry, RpcAgentDefinitionInfo } from "../src/shared/rpc-types";
import { exitApp } from "./harness";
import { realOmpProfile } from "./real-omp";

/**
 * The model roles on the real system omp, in a private copy of the user's
 * config and credentials (`e2e/real-omp.ts`). No model is ever called: it only
 * reads stock's resolution through the bridge.
 *
 * - `OMP_GUI_ROLES_REAL=1`: stock's built-in roles, and only those, are listed,
 *   each with an effective answer; every template agent runs on its first
 *   built-in role's model (stock's agent model resolution,
 *   `get_agent_definitions` → `effectiveResolved`); a custom `modelRoles.<id>`
 *   set outside OMPdesk is not listed, yet stock still resolves an agent's
 *   `@id` to it.
 * - `OMP_GUI_ROLES_CAPTURES=<dir>`: Settings › Models & accounts › Model roles
 *   in light/dark × en/ko, wide and narrow.
 */
const REAL = process.env.OMP_GUI_ROLES_REAL === "1";
const CAPTURES = process.env.OMP_GUI_ROLES_CAPTURES ?? "";

const BUILTIN = [
	"default",
	"slow",
	"smol",
	"plan",
	"task",
	"advisor",
	"commit",
	"memory",
	"tiny",
	"vision",
	"image",
	"web",
	"speech",
	"dictation",
	"judge",
];

async function command<T>(page: Page, tabId: string, body: Record<string, unknown>): Promise<T> {
	const response = await page.evaluate(
		([id, payload]) => window.omp.rpc.commandForTab(id as string, payload as never),
		[tabId, body] as const,
	);
	if (!response.success) throw new Error(`${String(body.type)} failed: ${response.error}`);
	return response.data as T;
}

async function launchReal(prefs: Record<string, unknown> = {}) {
	const { profile, project, desktop, agent, env } = await realOmpProfile(prefs);
	const app = await electron.launch({
		args: [
			path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"),
			project,
			`--user-data-dir=${desktop}`,
		],
		env,
	});
	const page = await app.firstWindow();
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(() => page.evaluate(() => window.omp.sidecar.getStatus()), { timeout: 60_000 })
		.toMatchObject({ status: "ready" });
	const tab = (await page.evaluate(() => window.omp.tabs.list())).find(row => row.active);
	if (!tab) throw new Error("No active tab");
	return { app, page, tabId: tab.tabId, profile, agent };
}

const rolesOf = async (page: Page, tabId: string) =>
	Object.fromEntries(
		(await command<{ roles: ModelRoleEntry[] }>(page, tabId, { type: "get_model_roles" })).roles.map(role => [
			role.id,
			role,
		]),
	);

const agentsOf = async (page: Page, tabId: string) =>
	Object.fromEntries(
		(await command<{ agents: RpcAgentDefinitionInfo[] }>(page, tabId, { type: "get_agent_definitions" })).agents.map(
			agent => [agent.name, agent],
		),
	);

test("real omp: only built-in roles are listed and each template agent runs on its first built-in role", async () => {
	test.skip(!REAL, "Opt-in: runs the system omp on a private copy of the user's config");
	test.setTimeout(240_000);
	const { app, page, tabId, agent, profile } = await launchReal();
	try {
		await command(page, tabId, { type: "install_agent_templates", scope: "user" });
		const baseline = await rolesOf(page, tabId);
		const chat = baseline.default?.candidates.filter(model => model.kind === "chat") ?? [];
		const [first, second] = chat.map(model => `${model.provider}/${model.id}`);
		if (!first || !second) throw new Error("The profile needs two usable chat models");
		const set = (role: string, model: string | null) =>
			command(page, tabId, { type: "set_model_role", role, modelId: model });

		for (const id of BUILTIN) expect(baseline[id]?.effective, id).toBeDefined();

		// Every template agent's first role is a built-in: set to A it wins, each role in turn.
		const leads = new Set(AGENT_TEMPLATES.map(template => template.model[0]?.slice(1) ?? ""));
		for (const role of leads) await set(role, second);
		for (const lead of leads) {
			await set(lead, first);
			const agents = await agentsOf(page, tabId);
			for (const template of AGENT_TEMPLATES) {
				const expected = template.model[0] === `@${lead}` ? first : second;
				expect(agents[template.name]?.effectiveResolved, `${template.name} with ${lead} = A`).toBe(expected);
			}
			await set(lead, second);
		}

		// A custom role set outside OMPdesk: not listed, still in config.yml, still resolved by stock for an agent.
		await set("release", first);
		await expect.poll(() => fs.readFile(path.join(agent, "config.yml"), "utf8")).toContain("release:");
		expect((await rolesOf(page, tabId)).release).toBeUndefined();
		await command(page, tabId, {
			type: "write_agent_file",
			scope: "user",
			name: "release-bot",
			content: '---\nname: release-bot\ndescription: Ships it.\nmodel: [ "@release", "@task" ]\n---\n\nShip.\n',
		});
		await expect.poll(async () => (await agentsOf(page, tabId))["release-bot"]?.effectiveResolved).toBe(first);
		await set("release", null);
	} finally {
		await exitApp(app);
		// The profile holds a copy of the user's credentials database.
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

interface TranscriptLine {
	message?: { role?: string; provider?: string; model?: string; stopReason?: string; content?: unknown };
}

async function transcript(file: string): Promise<TranscriptLine[]> {
	const text = await fs.readFile(file, "utf8").catch(() => "");
	return text
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as TranscriptLine);
}

/** The subagent transcripts stock writes next to a session file: `<session>/…/*.jsonl`. */
async function subagentFiles(session: string): Promise<string[]> {
	const dir = session.replace(/\.jsonl$/, "");
	const names = await fs.readdir(dir, { recursive: true }).catch(() => [] as string[]);
	return names.filter(name => name.endsWith(".jsonl")).map(name => path.join(dir, name));
}

// Spends tokens: a real `task` subagent runs once with the task role set and once with it empty,
// and its transcript's model must be what Settings › Model roles shows as `task`'s effective model.
test("real omp: a task subagent runs on the task role's effective model, set and empty", async () => {
	test.skip(!REAL || process.env.OMP_GUI_REAL_WORK !== "1", "Opt-in: spends tokens on a real subagent");
	test.setTimeout(900_000);
	const { app, page, tabId, profile } = await launchReal();
	try {
		const state = await command<{ model?: { provider: string; id: string } }>(page, tabId, { type: "get_state" });
		if (!state.model) throw new Error("No session model");
		const session = `${state.model.provider}/${state.model.id}`;
		const baseline = await rolesOf(page, tabId);
		const chat = baseline.default?.candidates.filter(model => model.kind === "chat") ?? [];
		// A current model the user's account serves: one they assign to another role, the light roles first.
		const configured = [baseline.tiny, baseline.commit, ...Object.values(baseline)].flatMap(role =>
			role?.model ? [role.model.replace(/:[a-z]+$/, "")] : [],
		);
		const chatIds = new Set(chat.map(model => `${model.provider}/${model.id}`));
		const other = configured.find(model => model !== session && chatIds.has(model));
		if (!other) throw new Error("The profile needs a second chat model assigned to some role");

		for (const run of [
			{ role: other, marker: "SUB-SET" },
			{ role: null, marker: "SUB-EMPTY" },
		]) {
			await command(page, tabId, { type: "set_model_role", role: "task", modelId: run.role });
			const effective = (await rolesOf(page, tabId)).task?.effective;
			test.info().annotations.push({ type: `task effective ${run.marker}`, description: JSON.stringify(effective) });
			expect(effective?.model, run.marker).toBeDefined();
			const input = page.locator(".omp-composer-input").first();
			const before = await command<{ sessionId?: string }>(page, tabId, { type: "get_state" });
			// Send, not Enter: Enter while the command menu is open inserts its entry (InputArea) instead of running it.
			await input.fill("/new");
			await page.getByRole("button", { name: "Send", exact: true }).click();
			await expect
				.poll(async () => (await command<{ sessionId?: string }>(page, tabId, { type: "get_state" })).sessionId, {
					timeout: 30_000,
				})
				.not.toBe(before.sessionId);
			const { sessionFile } = await command<{ sessionFile?: string }>(page, tabId, { type: "get_state" });
			if (!sessionFile) throw new Error("No session file");
			await input.fill(
				`Use the task tool exactly once to spawn one subagent of the bundled "task" agent type, without passing any model, with the assignment: "Reply with exactly ${run.marker}." When it has finished, reply with exactly ALL-DONE.`,
			);
			await input.press("Enter");
			await expect
				.poll(
					async () =>
						(await transcript(sessionFile)).some(
							line =>
								line.message?.role === "assistant" &&
								line.message.stopReason === "stop" &&
								JSON.stringify(line.message.content).includes("ALL-DONE"),
						),
					{ timeout: 400_000 },
				)
				.toBe(true);
			const replies: Array<{ model: string; stopReason?: string; text: string }> = [];
			for (const file of await subagentFiles(sessionFile)) {
				for (const line of await transcript(file)) {
					if (line.message?.role === "assistant" && line.message.provider && line.message.model) {
						replies.push({
							model: `${line.message.provider}/${line.message.model}`,
							stopReason: line.message.stopReason,
							text: JSON.stringify(line.message.content).slice(0, 200),
						});
					}
				}
			}
			test.info().annotations.push({ type: `subagent ${run.marker}`, description: JSON.stringify(replies) });
			// The subagent's own answer: stock may consult other models on the way (advisor), never instead.
			const answer = replies.findLast(reply => reply.stopReason === "stop" && reply.text.includes(run.marker));
			expect(answer?.model, run.marker).toBe(effective?.model);
		}
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

for (const language of ["en", "ko"] as const)
	for (const theme of ["light", "dark"] as const)
		test(`model roles captures (${language} ${theme})`, async () => {
			test.skip(!CAPTURES, "OMP_GUI_ROLES_CAPTURES=<dir> captures Settings › Model roles");
			test.setTimeout(180_000);
			const { app, page, profile } = await launchReal({ language, themeName: theme });
			try {
				await fs.mkdir(CAPTURES, { recursive: true });
				for (const [mode, width] of [
					["wide", 1280],
					["narrow", 820],
				] as const) {
					await app.evaluate(
						({ BrowserWindow }, size) =>
							BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height),
						{ width, height: 860 },
					);
					await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
					await page.keyboard.press("Meta+,");
					const settings = page.locator("[data-settings-page]");
					await expect(settings).toBeVisible();
					await settings.locator('[data-settings-section="models"]').click();
					const roles = settings.locator("#settings-models-roles");
					await expect(roles.locator("[data-setting-row]").first()).toBeVisible();
					// Account state and quota arrive a moment after the rows.
					await expect(roles.locator("#model-role-default")).toContainText(
						/Signed in|Not signed in|Provider off|로그인됨|로그인 안 됨|프로바이더 꺼짐/,
						{ timeout: 30_000 },
					);
					const content = settings.locator(".settings-content");
					const { top, height, view } = await content.evaluate(node => {
						const section = document.getElementById("settings-models-roles");
						const box = section?.getBoundingClientRect();
						const host = node.getBoundingClientRect();
						return {
							top: node.scrollTop + (box?.top ?? 0) - host.top,
							height: box?.height ?? 0,
							view: node.clientHeight,
						};
					});
					const pages = Math.min(6, Math.ceil(height / view));
					for (let part = 0; part < pages; part++) {
						await content.evaluate((node, y) => node.scrollTo({ top: y }), top + part * (view - 80));
						await page.mouse.move(1, 1);
						await page.screenshot({
							animations: "disabled",
							path: path.join(CAPTURES, `${language}-${theme}-${mode}-roles-${part + 1}.png`),
							scale: "css",
						});
					}
					await page.keyboard.press("Escape");
				}
			} finally {
				await exitApp(app);
				await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		});
