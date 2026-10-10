/**
 * Agents › Definitions authoring against the real system omp (isolated
 * profile, no credentials): template gallery, editor create / edit /
 * duplicate-to-override / delete, and "Add all". Every file OMPdesk writes is
 * checked on disk and through omp's own discovery (`get_agent_definitions`).
 *
 * Set OMPDESK_SHOTS_DIR to also save light/dark screenshots (English and
 * Korean) of the list, gallery and editor.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron, type Locator, type Page } from "playwright";
import { AGENT_TEMPLATES } from "../src/shared/agent-templates";
import type { RpcAgentDefinitionInfo } from "../src/shared/rpc-types";
import { exitApp } from "./harness";

const SHOTS = process.env.OMPDESK_SHOTS_DIR;

async function shoot(page: Page, name: string, target?: Locator) {
	if (!SHOTS) return;
	await fs.mkdir(SHOTS, { recursive: true });
	// Save toasts would cover the page (and may sit under a dialog overlay); hide them.
	await page
		.locator('[role="status"]:has(button[aria-label]), [role="alert"]:has(button[aria-label])')
		.evaluateAll(cards => {
			for (const card of cards) if (card instanceof HTMLElement) card.style.visibility = "hidden";
		});
	for (const scheme of ["light", "dark"] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
		await page.waitForTimeout(300);
		const file = path.join(SHOTS, `${name}-${scheme}.png`);
		if (target) await target.screenshot({ path: file, animations: "disabled" });
		else await page.screenshot({ path: file, animations: "disabled" });
	}
	await page.emulateMedia({ colorScheme: "light" });
}

async function definitions(page: Page): Promise<RpcAgentDefinitionInfo[]> {
	return page.evaluate(async () => {
		const response = await window.omp.rpc.getAgentDefinitions();
		if (!response.success) throw new Error(response.error);
		return (response.data as { agents: RpcAgentDefinitionInfo[] }).agents;
	});
}

const LEGACY = `---
# Hand-written; OMPdesk must keep this comment.
name: legacy
x-owner: platform-team # unknown key, kept
description: Legacy helper
thinking: low
---

Old instructions.
`;

test("agent editor and template gallery write definitions omp discovers", async () => {
	test.setTimeout(240_000);
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-agent-studio-"));
	const project = path.join(profile, "project");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	// PI_CONFIG_DIR below points omp's user config at this profile: user agents live here.
	const userAgents = path.join(agent, "agents");
	const projectAgents = path.join(project, ".omp", "agents");
	await Promise.all([fs.mkdir(project), fs.mkdir(desktop), fs.mkdir(userAgents, { recursive: true })]);
	await fs.writeFile(path.join(userAgents, "legacy.md"), LEGACY);
	const writePrefs = (language: string) =>
		fs.writeFile(
			path.join(desktop, "prefs.json"),
			JSON.stringify({ language, launchProfiles: { [project]: { noExtensions: true, noRules: true } } }),
		);
	await writePrefs("en");
	const env = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	Reflect.deleteProperty(env, "OMP_GUI_OMP");
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env,
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));

	const openDefinitions = async (definitionsLabel: string) => {
		await page.locator('[data-sidebar-destinations] button[data-destination="agents"]').click();
		await page.getByRole("tab", { name: definitionsLabel, exact: true }).click();
	};
	const discovered = async (name: string) => (await definitions(page)).find(entry => entry.name === name);

	try {
		await page.setViewportSize({ width: 1360, height: 900 });
		await expect
			.poll(() => page.evaluate(() => window.omp.sidecar.getStatus()), { timeout: 60_000 })
			.toMatchObject({ status: "ready" });
		const setup = page.getByRole("region", { name: "Set up OMPdesk", exact: true });
		if (await setup.isVisible().catch(() => false)) {
			await setup.getByRole("button", { name: "Set up later", exact: true }).click();
		}
		await openDefinitions("Definitions");
		await expect(page.getByRole("heading", { name: "legacy", exact: true })).toBeVisible({ timeout: 30_000 });
		expect(await discovered("legacy")).toMatchObject({ source: "user", scope: "user" });
		// The writer must surface stock's field error rather than the removed
		// local coercion/parser's wording, and must not persist an invalid file.
		const invalid = await page.evaluate(() =>
			window.omp.rpc.writeAgentFile({
				scope: "user",
				name: "invalid-field-probe",
				content: "---\nname: invalid-field-probe\ndescription: [not, a, string]\n---\nInstructions.",
			}),
		);
		expect(invalid.success).toBe(false);
		if (!invalid.success) expect(invalid.error).toContain("Failed to parse agent: Invalid agent field:");
		expect(await fs.stat(path.join(userAgents, "invalid-field-probe.md")).catch(() => null)).toBeNull();
		expect(await discovered("scout")).toMatchObject({ source: "bundled" });
		expect((await discovered("scout"))?.scope).toBeUndefined();

		// --- Gallery → Customize → editor prefilled → create (user scope).
		await page.getByRole("button", { name: "Templates", exact: true }).click();
		const gallery = page.getByRole("dialog", { name: "Agent templates" });
		await expect(gallery.getByRole("heading", { name: "Frontend engineer" })).toBeVisible();
		await shoot(page, "gallery-en");
		await gallery
			.getByRole("listitem")
			.filter({ hasText: "Frontend engineer" })
			.getByRole("button", { name: "Customize" })
			.click();
		const editor = page.getByRole("dialog", { name: "New agent" });
		await expect(editor.getByRole("textbox", { name: "Name" })).toHaveValue("frontend");
		await expect(editor.locator(".cm-content")).toContainText("You are a frontend engineer");
		await expect(editor.getByRole("button", { name: "Read-only preset" })).toBeVisible();
		await expect(editor.getByText(path.join(userAgents, "frontend.md"))).toBeVisible();
		await shoot(page, "editor-template-en");
		await editor.getByRole("button", { name: "Create agent" }).click();
		await expect(editor).toHaveCount(0);
		const frontend = await fs.readFile(path.join(userAgents, "frontend.md"), "utf8");
		expect(frontend).toContain("name: frontend");
		expect(frontend).toContain("You are a frontend engineer");
		await expect.poll(() => discovered("frontend")).toMatchObject({ source: "user", scope: "user" });

		// --- New agent in this project: validation, read-only preset, CodeMirror body.
		await page.getByRole("button", { name: "New agent", exact: true }).click();
		const create = page.getByRole("dialog", { name: "New agent" });
		await create.getByRole("tab", { name: "This project" }).click();
		const name = create.getByRole("textbox", { name: "Name" });
		await name.fill("main");
		await expect(create.getByText("'main' and 'sub' are reserved by omp.")).toBeVisible();
		await name.fill("legacy");
		await create.getByRole("tab", { name: "All projects" }).click();
		await expect(create.getByText("An agent with this name already exists in this folder.")).toBeVisible();
		await create.getByRole("tab", { name: "This project" }).click();
		await expect(create.getByText(/Overrides your user agent “legacy” in this project/)).toBeVisible();
		await name.fill("probe");
		await create.getByRole("button", { name: "Create agent" }).click();
		await expect(create.getByText("Enter a description.")).toBeVisible();
		await create.getByRole("textbox", { name: "Description" }).fill("Answers questions about this repository.");
		await create.locator(".cm-content").click();
		await page.keyboard.type("Read the files and answer briefly.");
		await create.getByRole("combobox", { name: "Tools" }).selectOption("custom");
		await create.getByRole("button", { name: "Read-only preset" }).click();
		await expect(create.getByRole("button", { name: "grep", exact: true })).toHaveAttribute("aria-pressed", "true");
		await expect(create.getByRole("button", { name: "edit", exact: true })).toHaveAttribute("aria-pressed", "false");
		await create.getByRole("combobox", { name: "Thinking level" }).selectOption("low");
		await shoot(page, "editor-new-en");
		await create.getByRole("button", { name: "Create agent" }).click();
		await expect(create).toHaveCount(0);
		const probe = await fs.readFile(path.join(projectAgents, "probe.md"), "utf8");
		expect(probe).toContain("tools: [ read, grep, glob, find, lsp, ast_grep, web_search ]");
		expect(probe).toContain("thinking-level: low");
		expect(probe).toContain("Read the files and answer briefly.");
		await expect.poll(() => discovered("probe")).toMatchObject({ source: "project", scope: "project" });
		expect((await discovered("probe"))?.tools).toEqual([
			"read",
			"grep",
			"glob",
			"find",
			"lsp",
			"ast_grep",
			"web_search",
			"yield",
		]);
		await shoot(page, "definitions-en");

		// --- Edit keeps unknown keys, comments and the file's key spelling.
		await page.getByRole("button", { name: "Actions for legacy" }).click();
		await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
		const edit = page.getByRole("dialog", { name: "Edit legacy" });
		await edit.getByRole("textbox", { name: "Description" }).fill("Legacy helper, revised");
		await edit.getByRole("combobox", { name: "Thinking level" }).selectOption("high");
		await edit.getByRole("button", { name: "Save", exact: true }).click();
		await expect(edit).toHaveCount(0);
		const legacy = await fs.readFile(path.join(userAgents, "legacy.md"), "utf8");
		expect(legacy).toContain("# Hand-written; OMPdesk must keep this comment.");
		expect(legacy).toContain("x-owner: platform-team # unknown key, kept");
		expect(legacy).toContain("thinking: high");
		expect(legacy).toContain("description: Legacy helper, revised");
		await expect.poll(async () => (await discovered("legacy"))?.thinkingLevel).toBe("high");

		// --- Duplicate a bundled agent → a user copy that overrides it.
		await page.getByRole("button", { name: "Actions for scout" }).click();
		await page.getByRole("menuitem", { name: "Customize a copy" }).click();
		const copy = page.getByRole("dialog", { name: "New agent" });
		await expect(copy.getByRole("textbox", { name: "Name" })).toHaveValue("scout");
		await expect(copy.getByText(/Replaces the bundled agent “scout”/)).toBeVisible();
		await copy.getByRole("button", { name: "Create agent" }).click();
		await expect(copy).toHaveCount(0);
		await expect.poll(() => discovered("scout")).toMatchObject({ source: "user", scope: "user" });
		const scout = await fs.readFile(path.join(userAgents, "scout.md"), "utf8");
		expect(scout).toContain("read-summarize: false");
		expect(scout).toContain("output:");

		// --- Delete the copy → the bundled scout is back.
		await page.getByRole("button", { name: "Actions for scout" }).click();
		await page.getByRole("menuitem", { name: "Delete" }).click();
		const confirm = page.getByRole("dialog", { name: "Delete scout?" });
		await confirm.getByRole("button", { name: "Delete", exact: true }).click();
		await expect.poll(() => discovered("scout")).toMatchObject({ source: "bundled" });
		await expect(fs.access(path.join(userAgents, "scout.md"))).rejects.toThrow();

		// --- Add all: every other template lands; frontend.md is left alone.
		await page.getByRole("button", { name: "Templates", exact: true }).click();
		await page
			.getByRole("dialog", { name: "Agent templates" })
			.getByRole("button", { name: `Add all (${AGENT_TEMPLATES.length})` })
			.click();
		await expect(page.getByText(`Agents added: ${AGENT_TEMPLATES.length - 1}`)).toBeVisible();
		expect(await fs.readFile(path.join(userAgents, "frontend.md"), "utf8")).toBe(frontend);
		const all = await definitions(page);
		for (const template of AGENT_TEMPLATES) {
			expect(
				all.find(entry => entry.name === template.name),
				template.name,
			).toMatchObject({
				source: "user",
				scope: "user",
			});
		}
		expect(errors).toEqual([]);

		if (SHOTS) {
			await writePrefs("ko");
			await page.reload();
			await expect
				.poll(() => page.evaluate(() => window.omp.sidecar.getStatus()), { timeout: 60_000 })
				.toMatchObject({ status: "ready" });
			await openDefinitions("정의");
			await expect(page.getByRole("heading", { name: "legacy", exact: true })).toBeVisible({ timeout: 30_000 });
			await shoot(page, "definitions-ko");
			await page.getByRole("button", { name: "템플릿", exact: true }).click();
			await expect(page.getByRole("dialog", { name: "에이전트 템플릿" })).toBeVisible();
			await shoot(page, "gallery-ko");
			await page.keyboard.press("Escape");
			await page.getByRole("button", { name: "새 에이전트", exact: true }).click();
			const ko = page.getByRole("dialog", { name: "새 에이전트" });
			await ko.getByRole("textbox", { name: "이름" }).fill("reviewer");
			await shoot(page, "editor-new-ko");
		}
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true });
	}
});
