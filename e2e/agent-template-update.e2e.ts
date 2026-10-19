/**
 * Agents › Definitions › "Update to role-based model", against the real system
 * omp (isolated profile, no credentials). Agents installed from a template
 * while templates named a preset custom role (`@debug, @slow, @task`) keep that
 * `model:` line; the page offers, per agent, to replace it with the template's
 * built-in roles after showing the diff. Cancel writes nothing, Update changes
 * exactly that line (comments, key order, body stay), and an agent whose
 * model line the user wrote themselves is offered with a warning, never silently.
 *
 * Set OMP_GUI_AGENT_UPDATE_CAPTURES=<dir> for light/dark × en/ko screenshots.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { serializeAgentMarkdown } from "../src/shared/agent-definition";
import { LEGACY_TEMPLATE_MODELS, replaceModelLine } from "../src/shared/agent-template-migration";
import { AGENT_TEMPLATES, templateDraft } from "../src/shared/agent-templates";
import type { RpcAgentDefinitionInfo } from "../src/shared/rpc-types";
import { exitApp, launchApp, openDestination, variants } from "./harness";

const CAPTURES = process.env.OMP_GUI_AGENT_UPDATE_CAPTURES ?? "";

const TEXT = {
	en: {
		definitions: "Definitions",
		update: "Update to role-based model",
		confirm: "Update model line",
		edited: "You changed this line yourself. Updating replaces your choice.",
		done: "Updated debugger's model line",
	},
	ko: {
		definitions: "정의",
		update: "역할 기반 모델로 업데이트",
		confirm: "모델 줄 업데이트",
		edited: "직접 바꾼 줄이에요. 업데이트하면 선택한 값이 바뀌어요.",
		done: "debugger의 모델 줄을 업데이트했어요",
	},
} as const;

function templateFile(name: string): string {
	const template = AGENT_TEMPLATES.find(entry => entry.name === name);
	if (!template) throw new Error(`no template ${name}`);
	return serializeAgentMarkdown(templateDraft(template));
}

/** A file from a preset-role release: the template as it was, with a hand-written comment in the frontmatter. */
function installedWithPresetRole(name: string): string {
	const legacy = LEGACY_TEMPLATE_MODELS[name];
	if (!legacy) throw new Error(`no legacy model for ${name}`);
	const edit = replaceModelLine(templateFile(name), legacy);
	if (!edit) throw new Error(`no model line in ${name}`);
	return edit.content.replace("---\n", "---\n# mine: keep this comment\n");
}

for (const language of variants(["en", "ko"] as const))
	for (const theme of variants(["light", "dark"] as const))
		test(`a template agent on a removed preset role is offered the built-in role model line (${language} ${theme})`, async () => {
			test.setTimeout(180_000);
			const text = TEXT[language];
			const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-agent-update-")));
			const project = path.join(profile, "project");
			const desktop = path.join(profile, "desktop");
			const agent = path.join(profile, "agent");
			const userAgents = path.join(agent, "agents");
			await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(userAgents, { recursive: true })]);
			const stale = installedWithPresetRole("debugger");
			const edited = replaceModelLine(templateFile("docs-writer"), ["anthropic/claude-sonnet-4-5"])?.content ?? "";
			const current = templateFile("code-reviewer");
			await fs.writeFile(path.join(userAgents, "debugger.md"), stale);
			await fs.writeFile(path.join(userAgents, "docs-writer.md"), edited);
			await fs.writeFile(path.join(userAgents, "code-reviewer.md"), current);
			await fs.writeFile(
				path.join(desktop, "prefs.json"),
				JSON.stringify({
					language,
					themeName: theme,
					firstRunComplete: true,
					launchProfiles: { [project]: { noExtensions: true, noRules: true } },
				}),
			);
			const app = await launchApp({ project, desktop, agent, profile, env: { OMP_GUI_OMP: undefined } });
			const page = await app.firstWindow();
			const errors: string[] = [];
			page.on("pageerror", error => errors.push(error.message));
			const shot = async (name: string) => {
				if (!CAPTURES) return;
				await fs.mkdir(CAPTURES, { recursive: true });
				await page.mouse.move(1, 1);
				await page.screenshot({
					path: path.join(CAPTURES, `${language}-${theme}-${name}.png`),
					scale: "css",
					animations: "disabled",
				});
			};
			try {
				await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
				await expect
					.poll(() => page.evaluate(() => window.omp.sidecar.getStatus()), { timeout: 60_000 })
					.toMatchObject({ status: "ready" });
				const setup = page.getByRole("region", { name: /Set up OMPdesk|OMPdesk 시작하기/ });
				if (await setup.isVisible().catch(() => false)) await setup.getByRole("button").last().click();
				await openDestination(page, "agents");
				await page.getByRole("tab", { name: text.definitions, exact: true }).click();
				await expect(page.getByRole("heading", { name: "debugger", exact: true })).toBeVisible({ timeout: 30_000 });

				// Two offers: the pre-v0.30 file and the one whose line the user wrote; the current template gets none.
				const offers = page.getByRole("button", { name: text.update, exact: true });
				await expect(offers).toHaveCount(2);
				const row = (name: string) => page.locator("li", { has: page.getByRole("heading", { name, exact: true }) });
				await expect(row("code-reviewer").getByRole("button", { name: text.update })).toHaveCount(0);
				await shot("1-list");

				// Opening the diff and cancelling writes nothing.
				await row("debugger").getByRole("button", { name: text.update }).click();
				const dialog = page.getByRole("dialog");
				await expect(dialog).toContainText('model: [ "@slow", "@task" ]');
				await expect(dialog).toContainText('model: [ "@debug", "@slow", "@task" ]');
				await expect(dialog).not.toContainText(text.edited);
				await shot("2-diff");
				await page.keyboard.press("Escape");
				await expect(dialog).toHaveCount(0);
				expect(await fs.readFile(path.join(userAgents, "debugger.md"), "utf8")).toBe(stale);

				// The user-written line carries the warning.
				await row("docs-writer").getByRole("button", { name: text.update }).click();
				await expect(dialog).toContainText("anthropic/claude-sonnet-4-5");
				await expect(dialog).toContainText(text.edited);
				await shot("3-diff-edited");
				await page.keyboard.press("Escape");
				await expect(dialog).toHaveCount(0);
				expect(await fs.readFile(path.join(userAgents, "docs-writer.md"), "utf8")).toBe(edited);

				// Update: exactly the model line changes, and omp discovers the new list.
				await row("debugger").getByRole("button", { name: text.update }).click();
				await dialog.getByRole("button", { name: text.confirm, exact: true }).click();
				await expect(page.getByText(text.done)).toBeVisible();
				const after = await fs.readFile(path.join(userAgents, "debugger.md"), "utf8");
				const staleLines = stale.split("\n");
				const afterLines = after.split("\n");
				expect(afterLines).toHaveLength(staleLines.length);
				const changed = staleLines.flatMap((line, index) => (line === afterLines[index] ? [] : [index]));
				expect(changed).toHaveLength(1);
				expect(afterLines[changed[0] ?? 0]).toBe('model: [ "@slow", "@task" ]');
				expect(after).toContain("# mine: keep this comment");
				await expect
					.poll(async () =>
						page.evaluate(async () => {
							const response = await window.omp.rpc.getAgentDefinitions();
							if (!response.success) return [];
							// The RPC envelope's data is untyped; discovery returns RpcAgentDefinitionInfo[] under `agents`.
							const data = response.data as { agents: RpcAgentDefinitionInfo[] };
							return data.agents.find(entry => entry.name === "debugger")?.model ?? [];
						}),
					)
					.toEqual(["@slow", "@task"]);
				await expect(offers).toHaveCount(1);
				expect(await fs.readFile(path.join(userAgents, "docs-writer.md"), "utf8")).toBe(edited);
				await shot("4-after");
				expect(errors).toEqual([]);
			} finally {
				await exitApp(app);
				await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		});
