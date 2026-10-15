import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { createServer } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { exitApp, fixtureOmp } from "./harness";
import { capturer, type Finding, resize } from "./shell-capture";

// Opt-in audit of the sidebar and right-panel views through interaction flows that cross
// features (OMP_GUI_PANELS_CYCLE=<dir>), on the fake omp, in light/dark × en/ko and at
// three window shapes (wide, narrow, a true 2×2 split): a file edited and saved while the
// Changes panel and the file tabs change under it, a 600-commit history beside a split, a
// preview page that logs hundreds of errors, archiving and moving sessions that sit in a
// split, the sidebar's pinned shortcuts, usage bars and subagent rows. Each capture records
// overflow, clipping and popup findings next to it; a step that fails is recorded as a
// finding and the flow goes on, so one run shows everything that is broken.

const directory = process.env.OMP_GUI_PANELS_CYCLE;
test.describe.configure({ mode: "parallel" });
test.skip(!directory, "set OMP_GUI_PANELS_CYCLE=<dir> to capture the panel cycle flows");

type Language = "en" | "ko";
type Theme = "light" | "dark";

const RUNS: readonly (readonly [Language, Theme])[] = [
	["en", "light"],
	["en", "dark"],
	["ko", "light"],
	["ko", "dark"],
];

const WIDE = [1440, 900] as const;
const NARROW = [820, 860] as const;

const TEXT = {
	en: {
		changes: "Changes",
		files: "Files",
		preview: "Preview",
		edit: "Edit",
		discard: "Discard",
		cancel: "Cancel",
		unsaved: "Unsaved",
		saved: "Saved",
		archive: "Archive",
		restore: "Restore",
		move: "Move to project…",
		options: "Page options",
		sidePanel: "Side panel",
		commitSearch: "Search commits",
	},
	ko: {
		changes: "변경 사항",
		files: "파일",
		preview: "미리보기",
		edit: "편집",
		discard: "버리기",
		cancel: "취소",
		unsaved: "저장 안 됨",
		saved: "저장됨",
		archive: "보관",
		restore: "복원",
		move: "프로젝트로 이동…",
		options: "페이지 옵션",
		sidePanel: "사이드 패널",
		commitSearch: "커밋 검색",
	},
} as const;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

interface Launched {
	app: ElectronApplication;
	page: Page;
	root: string;
	project: string;
	errors: string[];
}

interface LaunchOptions {
	language: Language;
	theme: Theme;
	/** Prepare the project folder (git init, files) before the app starts. */
	seed?: (project: string, root: string) => Promise<void>;
	prefs?: Record<string, unknown>;
	env?: Record<string, string>;
	natives?: boolean;
}

async function launch(options: LaunchOptions): Promise<Launched> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-panels-cycle-")));
	const project = path.join(root, "project");
	const desktop = path.join(root, "desktop");
	const agent = path.join(root, "agent");
	await Promise.all([project, desktop, agent].map(dir => fs.mkdir(dir, { recursive: true })));
	await options.seed?.(project, root);
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({
			language: options.language,
			themeName: options.theme,
			firstRunComplete: true,
			...options.prefs,
		}),
	);
	const bin = await fixtureOmp(root);
	if (options.natives) {
		const natives =
			process.env.OMP_GUI_TEST_NATIVES ||
			path.join(os.homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-natives");
		const link = path.join(path.dirname(bin), "node_modules/@oh-my-pi/pi-natives");
		if (!(await fs.lstat(link).catch(() => null))) await fs.symlink(natives, link, "dir");
	}
	const env: Record<string, string | undefined> = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), root),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_OMP: bin,
		OMP_GUI_REMOTE_PORT: "0",
		OMP_GUI_TEST_SESSION_FILES: "1",
		...options.env,
	};
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
	});
	const page = await app.firstWindow();
	const errors: string[] = [];
	page.on("pageerror", error => errors.push(error.message));
	await resize(app, WIDE[0], WIDE[1]);
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 90_000 })
		.toBe("ready");
	return { app, page, root, project: await fs.realpath(project), errors };
}

interface Flow extends Launched {
	shoot: (name: string) => Promise<void>;
	notes: string[];
	findings: Finding[];
	/** Run one step; a failure is a finding and the flow continues. */
	step: (name: string, body: () => Promise<void>) => Promise<void>;
}

async function flow(name: string, options: LaunchOptions, body: (flow: Flow) => Promise<void>): Promise<void> {
	const launched = await launch(options);
	const findings: Finding[] = [];
	const notes: string[] = [];
	const prefix = `${name}-${options.language}-${options.theme}`;
	const shoot = capturer(launched.page, directory, prefix, findings);
	const step = async (label: string, run: () => Promise<void>) => {
		try {
			await run();
		} catch (error) {
			const detail = error instanceof Error ? error.message.split("\n").slice(0, 6).join(" | ") : String(error);
			findings.push({ shot: label, kind: "step-failed", detail });
			await shoot(`failed-${label.replace(/\W+/g, "-")}`).catch(() => undefined);
		}
	};
	try {
		await body({ ...launched, shoot, notes, findings, step });
	} finally {
		if (directory)
			await fs.writeFile(
				path.join(directory, `${prefix}-findings.json`),
				JSON.stringify({ findings, notes, errors: launched.errors }, null, 2),
			);
		await exitApp(launched.app);
		await fs.rm(launched.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
}

const tabList = (page: Page) => page.evaluate(() => window.omp.tabs.list());
const rowOf = (page: Page, title: string) => page.locator(".omp-sidebar-session-row", { hasText: title });

async function makeSession(page: Page, tabId: string, title: string): Promise<void> {
	await page.evaluate(([id, message]) => window.omp.rpc.commandForTab(id, { type: "prompt", message }), [
		tabId,
		`Work on ${title}`,
	] as const);
	await expect
		.poll(async () => {
			const tab = (await tabList(page)).find(entry => entry.tabId === tabId);
			return tab?.status === "ready" ? (tab.sessionPath ?? "") : "";
		})
		.toMatch(/\.jsonl$/);
	await page.evaluate(([id, command]) => window.omp.rpc.commandForTab(id, { type: "bash", command }), [
		tabId,
		`fixture:title:${title}`,
	] as const);
	await expect(rowOf(page, title)).toBeVisible();
}

async function openSession(page: Page, title?: string): Promise<string> {
	const before = (await tabList(page)).map(tab => tab.tabId);
	await page.keyboard.press("ControlOrMeta+t");
	await expect.poll(async () => (await tabList(page)).length).toBe(before.length + 1);
	const created = (await tabList(page)).find(tab => !before.includes(tab.tabId));
	if (!created) throw new Error("No new tab");
	await expect.poll(async () => (await tabList(page)).find(tab => tab.tabId === created.tabId)?.status).toBe("ready");
	await expect.poll(async () => (await tabList(page)).find(tab => tab.active)?.tabId).toBe(created.tabId);
	if (title) await makeSession(page, created.tabId, title);
	return created.tabId;
}

async function firstSession(page: Page, title: string): Promise<string> {
	const active = (await tabList(page)).find(tab => tab.active);
	if (!active) throw new Error("No active tab");
	await makeSession(page, active.tabId, title);
	return active.tabId;
}

async function dragOnto(page: Page, title: string, target: Locator, fx: number, fy: number, placement: string) {
	const rowBox = await rowOf(page, title).boundingBox();
	const pane = await target.boundingBox();
	if (!rowBox || !pane) throw new Error("expected drag boxes");
	await page.mouse.move(rowBox.x + rowBox.width / 2, rowBox.y + rowBox.height / 2);
	await page.mouse.down();
	await page.mouse.move(rowBox.x + rowBox.width / 2 + 20, rowBox.y + rowBox.height / 2, { steps: 4 });
	await page.mouse.move(pane.x + pane.width * fx + 2, pane.y + pane.height * fy, { steps: 12 });
	await page.mouse.move(pane.x + pane.width * fx, pane.y + pane.height * fy, { steps: 2 });
	await expect(page.locator("[data-split-ghost]")).toHaveAttribute("data-split-ghost", placement);
	await page.mouse.up();
}

/** Four sessions, Alpha first. `panes` 2 leaves Delta | Alpha on screen, 4 builds the grid. */
async function buildSplit(page: Page, panes: 2 | 4): Promise<void> {
	await firstSession(page, "Alpha");
	await openSession(page, "Beta");
	await openSession(page, "Gamma");
	await openSession(page, "Delta");
	await dragOnto(page, "Alpha", page.locator(".omp-split-workspace"), 0.92, 0.5, "right");
	await expect(page.locator(".omp-session-pane")).toHaveCount(2);
	if (panes === 2) return;
	await dragOnto(page, "Beta", page.locator("[data-split]").first(), 0.5, 0.92, "bottom");
	await expect(page.locator(".omp-session-pane")).toHaveCount(3);
	await dragOnto(page, "Gamma", page.locator("[data-split]").nth(2), 0.5, 0.92, "bottom");
	await expect(page.locator(".omp-session-pane")).toHaveCount(4);
}

/** The side panel on one view: docked when wide, a sheet in a narrow window. */
async function openView(page: Page, label: string): Promise<Locator> {
	const button = page.locator(".omp-panel-topbar:visible").getByRole("button", { name: label, exact: true }).first();
	await expect(async () => {
		if (!(await button.isVisible())) await page.keyboard.press("ControlOrMeta+j");
		await expect(button).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 30_000 });
	await button.click();
	return page
		.locator("aside[data-docked]:visible, [role=dialog]:visible")
		.filter({ has: page.locator(".omp-panel-topbar") })
		.first();
}

async function setSize(app: ElectronApplication, page: Page, size: readonly [number, number]): Promise<void> {
	await resize(app, size[0], size[1]);
	await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(size[0]);
	await page.waitForTimeout(250);
}

/** A repository of `count` commits written in one `git fast-import`, with long and Korean subjects. */
async function seedHistory(project: string, count: number): Promise<void> {
	git(project, "init", "-q", "-b", "main");
	git(project, "config", "user.email", "cycle@example.com");
	git(project, "config", "user.name", "Cycle");
	git(project, "config", "commit.gpgsign", "false");
	const base = Math.floor(Date.now() / 1000) - count * 3600;
	const chunks: string[] = [];
	for (let index = 0; index < count; index++) {
		const subject =
			index % 41 === 7
				? `feat(sidebar): keep the archived group, the pinned shortcuts and the usage bars readable when the session title is very long (${index})`
				: index % 29 === 3
					? `fix(패널): 파일 탭을 바꿔도 변경 사항 목록이 따라가도록 해요 (${index})`
					: `chore: step ${index}`;
		const files: [string, string][] = [
			["a.ts", `export const a = ${index};\n`],
			["b.ts", `export const b = ${index};\n`],
			["c.md", `# Notes ${index}\n`],
		];
		const body = [
			`commit refs/heads/main`,
			`committer Cycle <cycle@example.com> ${base + index * 3600} +0000`,
			`data ${Buffer.byteLength(subject)}`,
			subject,
			...files.flatMap(([name, content]) => [
				`M 100644 inline ${name}`,
				`data ${Buffer.byteLength(content)}`,
				content,
			]),
			"",
		];
		chunks.push(body.join("\n"));
	}
	execFileSync("git", ["fast-import", "--quiet"], { cwd: project, input: chunks.join("\n") });
	git(project, "reset", "-q", "--hard", "main");
}

const WORDS = ["auth", "release", "sidebar", "docs", "billing", "search", "upload", "cache"];

/** `count` stored sessions over the given projects, newest first; s-001 is a fork of s-000, a few titles are long. */
async function seedStored(agent: string, projects: string[], count: number): Promise<void> {
	const dir = path.join(agent, "sessions", "fixture");
	await fs.mkdir(dir, { recursive: true });
	for (let index = 0; index < count; index++) {
		const forkOf = index === 1 ? path.join(dir, "s-000.jsonl") : undefined;
		const titleIndex = forkOf ? 0 : index;
		const word = WORDS[titleIndex % WORDS.length];
		const title =
			titleIndex % 5 === 4
				? `Investigate why the ${word} workflow sometimes stalls on the Windows packaging step (${titleIndex})`
				: `Session ${String(titleIndex).padStart(3, "0")} · ${word}`;
		const time = new Date(Date.now() - (index * 37 + 3) * 60_000).toISOString();
		const id = `s-${String(index).padStart(3, "0")}`;
		const lines = [
			{ type: "title", v: 1, title, updatedAt: time },
			{
				type: "session",
				version: 3,
				id,
				timestamp: time,
				cwd: projects[index % projects.length],
				...(forkOf ? { parentSession: forkOf } : {}),
			},
			{
				type: "message",
				id: "entry-1",
				parentId: null,
				timestamp: time,
				message: { role: "user", content: title, timestamp: Date.parse(time) },
			},
			{
				type: "message",
				id: "entry-2",
				parentId: "entry-1",
				timestamp: time,
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Done." }],
					timestamp: Date.parse(time) + 1,
					stopReason: "stop",
				},
			},
		];
		const file = path.join(dir, `${id}.jsonl`);
		await fs.writeFile(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
		const stamp = new Date(time);
		await fs.utimes(file, stamp, stamp);
	}
}

for (const [language, theme] of RUNS) {
	const t = TEXT[language];

	test(`files edit, changes and history beside a split ${language}-${theme}`, async () => {
		test.setTimeout(420_000);
		await flow(
			"files-changes",
			{
				language,
				theme,
				seed: async project => {
					await seedHistory(project, 600);
					await fs.writeFile(path.join(project, "a.ts"), "export const a = 'edited on disk';\n");
					await fs.writeFile(path.join(project, "notes.txt"), "a new file\n");
				},
			},
			async ({ page, app, shoot, notes, step, project, errors }) => {
				await buildSplit(page, 2);
				await shoot("split-before-panel");
				let panel = await openView(page, t.files);

				await step("edit-then-switch-view", async () => {
					await panel.locator('[data-tree-id="file:a.ts"]').click();
					await panel.getByRole("button", { name: t.edit, exact: true }).click();
					const editor = panel
						.locator("[data-file-editor] [contenteditable], [data-file-editor] textarea")
						.first();
					await expect(editor).toBeVisible();
					await page.keyboard.press("ControlOrMeta+End");
					await page.keyboard.type("// typed in the panel\n");
					await expect(panel.locator("[data-editor-status]")).toHaveText(t.unsaved);
					await shoot("file-dirty");
					// Another panel view must not silently drop the unsaved edit.
					await page
						.locator(".omp-panel-topbar:visible")
						.getByRole("button", { name: t.changes, exact: true })
						.click();
					const dialog = page.getByRole("dialog");
					await expect(dialog).toBeVisible({ timeout: 3_000 });
					await shoot("file-dirty-leave-asks");
					await dialog.getByRole("button", { name: t.cancel, exact: true }).click();
					await expect(panel.locator("[data-editor-status]")).toHaveText(t.unsaved);
					await panel.locator("[data-file-editor] [contenteditable], [data-file-editor] textarea").first().click();
					await page.keyboard.press("ControlOrMeta+s");
					await expect(panel.locator("[data-editor-status]")).toHaveText(t.saved);
				});

				await step("changes-follow-the-save", async () => {
					await page
						.locator(".omp-panel-topbar:visible")
						.getByRole("button", { name: t.changes, exact: true })
						.click();
					panel = page
						.locator("aside[data-docked]:visible, [role=dialog]:visible")
						.filter({ has: page.locator(".omp-panel-topbar") })
						.first();
					await expect(panel.locator('button[title="a.ts"]')).toBeVisible({ timeout: 15_000 });
					await expect(panel.getByText("notes.txt", { exact: true })).toBeVisible();
					await shoot("changes-after-save");
					// A file changed outside shows up without reopening the panel.
					await fs.writeFile(path.join(project, "b.ts"), "export const b = 'outside';\n");
					await expect(panel.locator('button[title="b.ts"]')).toBeVisible({ timeout: 20_000 });
					await shoot("changes-after-outside-write");
				});

				await step("file-tabs-with-changes", async () => {
					const topbar = page.locator(".omp-panel-topbar:visible");
					const editor = panel
						.locator("[data-file-editor] [contenteditable], [data-file-editor] textarea")
						.first();
					const status = panel.locator("[data-editor-status]");
					await topbar.getByRole("button", { name: t.files, exact: true }).click();
					await panel.getByRole("button", { name: /^(Back to files|파일 목록으로)$/ }).click();
					await panel.locator('[data-tree-id="file:b.ts"]').click();
					await panel.getByRole("button", { name: t.edit, exact: true }).click();
					await editor.click();
					await page.keyboard.press("ControlOrMeta+End");
					await page.keyboard.type("// second file\n");
					await page.keyboard.press("ControlOrMeta+s");
					await expect(status).toHaveText(t.saved);
					const tabs = panel.locator("[data-file-tabs] [data-file-tab]");
					await expect(tabs).toHaveCount(2);
					await shoot("file-tabs");
					// A dirty file holds back a tab switch until the user answers.
					await page.keyboard.type("// unsaved\n");
					await tabs.first().locator("button").first().click();
					const dialog = page.getByRole("dialog");
					await expect(dialog).toBeVisible({ timeout: 3_000 });
					await shoot("file-tab-switch-asks");
					await dialog.getByRole("button", { name: t.cancel, exact: true }).click();
					// A click into another session's pane must not drop the edit either.
					await page.locator(".omp-session-pane").first().locator("textarea").first().click();
					await page.waitForTimeout(400);
					const kept = await panel.locator("[data-editor-status]").count();
					notes.push(`editor still there after a click into another pane: ${kept}`);
					await shoot("pane-click-with-dirty-file");
					if (kept === 0) throw new Error("a click into another pane dropped the unsaved edit");
					await editor.click();
					await page.keyboard.press("ControlOrMeta+s");
					await expect.poll(() => fs.readFile(path.join(project, "b.ts"), "utf8")).toContain("// unsaved");
					// The edits ended while another session has the focus: the file view closes like on any switch.
					await expect(panel.locator('[data-tree-id="file:a.ts"]')).toBeVisible({ timeout: 5_000 });
					await shoot("file-view-closed-after-save");
				});

				await step("history", async () => {
					await page
						.locator(".omp-panel-topbar:visible")
						.getByRole("button", { name: t.changes, exact: true })
						.click();
					await panel.locator("select").first().selectOption("commits");
					const history = panel.locator("[data-commit-history]");
					await expect(history).toContainText("chore: step", { timeout: 20_000 });
					await shoot("history-wide");
					const rows = history.getByRole("button");
					notes.push(`history buttons rendered: ${await rows.count()}`);
					await history.evaluate(element => {
						const scroller = [element, ...element.querySelectorAll("*")].find(
							node =>
								node.scrollHeight > node.clientHeight + 40 && getComputedStyle(node).overflowY !== "visible",
						);
						scroller?.scrollTo({ top: scroller.scrollHeight });
					});
					await page.waitForTimeout(500);
					await shoot("history-scrolled-end");
					const more = history.getByRole("button", { name: /^(Show older commits|더 오래된 커밋 보기)$/ });
					notes.push(`show older present: ${await more.count()}`);
					const search = history.getByRole("searchbox").or(history.locator("input").first()).first();
					await search.fill(language === "ko" ? "파일 탭" : "very long");
					await page.waitForTimeout(600);
					await shoot("history-search");
					await search.fill("");
				});

				await step("history-narrow", async () => {
					await setSize(app, page, NARROW);
					panel = await openView(page, t.changes);
					await shoot("history-narrow");
					await page.keyboard.press("Escape");
				});

				await step("history-2x2", async () => {
					await setSize(app, page, WIDE);
					await dragOnto(page, "Beta", page.locator("[data-split]").first(), 0.5, 0.92, "bottom");
					await dragOnto(page, "Gamma", page.locator("[data-split]").nth(2), 0.5, 0.92, "bottom");
					await expect(page.locator(".omp-session-pane")).toHaveCount(4);
					panel = await openView(page, t.changes);
					await shoot("history-2x2");
					await setSize(app, page, NARROW);
					await shoot("2x2-narrow");
					await setSize(app, page, WIDE);
				});
				expect(errors).toEqual([]);
			},
		);
	});

	test(`preview console with many errors beside a split ${language}-${theme}`, async () => {
		test.setTimeout(240_000);
		const server = createServer((request, response) => {
			response.writeHead(200, { "Content-Type": "text/html" });
			if (request.url === "/second") {
				response.end(
					"<!doctype html><title>Second page with a rather long title for the tab strip</title><h1>Second</h1>",
				);
				return;
			}
			response.end(
				"<!doctype html><title>Console storm</title><h1>Console storm</h1><script>" +
					"for (let i = 0; i < 400; i++) console.error('Failed request ' + i + ': ' + 'x'.repeat(i % 7 === 0 ? 900 : 40) + ' https://example.invalid/api/v1/resource/' + i);" +
					"console.warn('A very long unbroken token ' + 'y'.repeat(300));" +
					"</script>",
			);
		});
		const listening = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", () => listening.resolve());
		await listening.promise;
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No fixture server address");
		const host = `127.0.0.1:${address.port}`;
		try {
			await flow("preview-console", { language, theme }, async ({ page, app, shoot, notes, step, errors }) => {
				await buildSplit(page, 2);
				const panel = await openView(page, t.preview);
				const address = panel.locator("form input[inputmode=url]");
				await step("load", async () => {
					await address.fill(host);
					await address.press("Enter");
					await expect(page.locator("[data-preview-status]")).toHaveText("Console storm", { timeout: 20_000 });
					await shoot("preview-loaded");
				});
				await step("problems-list", async () => {
					const badge = panel.locator("[data-preview-problems]");
					await expect(badge).toBeVisible({ timeout: 15_000 });
					await expect.poll(async () => (await badge.innerText()).trim()).toMatch(/^\d+\+?$/);
					notes.push(
						`problems badge: ${(await badge.innerText()).trim()} label: ${await badge.getAttribute("aria-label")}`,
					);
					await badge.click();
					const list = page.locator("[data-preview-problem-list] li");
					notes.push(`problem rows: ${await list.count()}`);
					notes.push(`first row: ${(await list.first().innerText()).slice(0, 80)}`);
					await shoot("preview-problems");
					await page.keyboard.press("Escape");
				});
				await step("tabs-and-frames", async () => {
					await panel.getByRole("button", { name: t.options, exact: true }).click();
					await shoot("preview-options");
					await page.keyboard.press("Escape");
					await panel.getByRole("button", { name: t.options, exact: true }).click();
					await page.getByRole("menuitem", { name: /^(New tab|새 탭)$/ }).click();
					await address.fill(`${host}/second`);
					await address.press("Enter");
					await expect(page.locator("[data-preview-status]")).toContainText("Second page", { timeout: 20_000 });
					await shoot("preview-two-tabs");
				});
				await step("narrow", async () => {
					await setSize(app, page, NARROW);
					await openView(page, t.preview);
					await shoot("preview-narrow");
					await page.keyboard.press("Escape");
					await setSize(app, page, WIDE);
				});
				expect(errors).toEqual([]);
			});
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test(`sidebar archive, move, pins, usage and subagents with a split ${language}-${theme}`, async () => {
		test.setTimeout(420_000);
		await flow(
			"sidebar",
			{
				language,
				theme,
				prefs: { sidebar: { railPins: ["terminal", "diff", "files", "usage"] } },
				env: { OMP_GUI_TEST_LOGIN: "1", OMP_GUI_TEST_MODELS: "1", OMP_GUI_TEST_USAGE_DRIFT: "1" },
				seed: async (project, root) => {
					const others = ["website", "api-server"].map(name => path.join(root, name));
					await Promise.all(others.map(dir => fs.mkdir(dir, { recursive: true })));
					await seedStored(path.join(root, "agent"), [project, ...others], 14);
				},
			},
			async ({ page, app, shoot, notes, step, errors }) => {
				await buildSplit(page, 2);
				await shoot("sidebar-split");
				const menu = page.getByRole("menu");

				await step("live-row-menu", async () => {
					await rowOf(page, "Alpha").click({ button: "right" });
					await expect(menu).toBeVisible();
					const archiveItem = menu.getByRole("menuitem", { name: t.archive, exact: true });
					notes.push(`archive on a split member: ${await archiveItem.count()} item(s)`);
					await shoot("menu-split-member");
					await page.keyboard.press("Escape");
				});

				await step("close-then-archive-and-restore", async () => {
					await rowOf(page, "Alpha").click({ button: "right" });
					await menu.getByRole("menuitem", { name: /^(Close session|세션 닫기)$/ }).click();
					await expect(page.locator(".omp-session-pane")).toHaveCount(1);
					await shoot("split-after-close");
					await rowOf(page, "Alpha").click({ button: "right" });
					await menu.getByRole("menuitem", { name: t.archive, exact: true }).click();
					await expect(page.getByRole("button", { name: /^(Archived|보관함)/ }).first()).toBeVisible();
					await shoot("archived-group-collapsed");
					await page
						.getByRole("button", { name: /^(Archived|보관함)/ })
						.first()
						.click();
					await shoot("archived-group-open");
					await page.keyboard.press("Escape");
				});

				await step("move-to-project", async () => {
					const target = page
						.locator(".omp-sidebar-session-row[data-session-path]", { hasText: "Session 003" })
						.first();
					await target.scrollIntoViewIfNeeded();
					await target.click({ button: "right" });
					await menu.getByRole("menuitem", { name: t.move, exact: true }).click();
					await shoot("move-menu");
					await page.getByRole("menu").last().getByRole("menuitem").first().click();
					await shoot("moved");
				});

				await step("fork-badge", async () => {
					const fork = page.locator("[data-sidebar-fork]");
					notes.push(`fork badges: ${await fork.count()}`);
					await shoot("fork-badge");
				});

				await step("subagent-rows", async () => {
					const active = (await tabList(page)).find(tab => tab.active);
					if (!active) throw new Error("no active tab");
					await page.evaluate(
						id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:subagents" }),
						active.tabId,
					);
					await page.locator("[data-sidebar-subagents-toggle]").first().click();
					const rows = page.locator("[data-sidebar-subagent]");
					await expect(rows.first()).toBeVisible({ timeout: 15_000 });
					notes.push(`subagent rows: ${await rows.count()}`);
					await shoot("subagent-rows");
					await rows.first().click({ button: "right" });
					await shoot("subagent-menu");
					await page.getByRole("menuitem", { name: /^(Open in side panel|사이드 패널에서 열기)$/ }).click();
					await expect(page.locator("aside[data-docked]")).toBeVisible();
					await shoot("subagent-panel");
				});

				await step("pins-and-usage", async () => {
					const pins = page.locator("[data-rail-pin]");
					notes.push(`rail pins: ${await pins.count()}`);
					await shoot("pins");
					await page.locator('[data-rail-pin="usage"]').click();
					await page.waitForTimeout(500);
					await shoot("usage-page");
					await page.keyboard.press("Escape");
				});

				await step("narrow", async () => {
					await setSize(app, page, NARROW);
					await shoot("sidebar-narrow");
					await setSize(app, page, WIDE);
				});

				await step("2x2", async () => {
					await openSession(page);
					await openSession(page);
					await shoot("sidebar-2x2-attempt");
				});
				expect(errors).toEqual([]);
			},
		);
	});

	test(`panel views and pages in a 2x2 split and narrow ${language}-${theme}`, async () => {
		test.setTimeout(420_000);
		await flow(
			"views",
			{
				language,
				theme,
				natives: true,
				env: { OMP_GUI_TEST_LOGIN: "1", OMP_GUI_TEST_MODELS: "1" },
				seed: async (project, root) => {
					git(project, "init", "-q", "-b", "main");
					await fs.writeFile(path.join(project, "plan.md"), "# Delivery plan\n\n- [x] Inspect\n- [ ] Ship\n");
					await fs.writeFile(path.join(root, "unused"), "");
				},
			},
			async ({ page, app, shoot, step, notes, errors }) => {
				await buildSplit(page, 4);
				await shoot("grid");
				for (const [name, size] of [
					["wide", WIDE],
					["narrow", NARROW],
				] as const) {
					await step(`views-${name}`, async () => {
						await setSize(app, page, size);
						const panel = await openView(page, t.files);
						for (const label of [t.files, t.changes, t.preview]) {
							await page
								.locator(".omp-panel-topbar:visible")
								.getByRole("button", { name: label, exact: true })
								.click();
							await page.waitForTimeout(300);
							await shoot(`${name}-${label}`);
						}
						const topbar = page.locator(".omp-panel-topbar:visible");
						await topbar.getByRole("button").first().click();
						await page.waitForTimeout(800);
						await shoot(`${name}-terminal`);
						const options = panel.getByRole("button", { name: /View options|보기 옵션/ });
						const items = page.getByRole("menuitemcheckbox");
						await options.click();
						const count = await items.count();
						await page.keyboard.press("Escape");
						notes.push(`${name}: ${count} extra views`);
						for (let index = 0; index < count; index++) {
							await options.click();
							await items.nth(index).click();
							await page.waitForTimeout(350);
							await shoot(`${name}-view-${index}`);
						}
						if (name === "narrow") await page.keyboard.press("Escape");
					});
				}
				await step("pages", async () => {
					await setSize(app, page, WIDE);
					for (const destination of ["insights", "agents"] as const) {
						await page.locator(`[data-sidebar-destinations] button[data-destination="${destination}"]`).click();
						await page.waitForTimeout(700);
						const tabs = page.locator(`section[data-destination="${destination}"]`).getByRole("tab");
						for (let index = 0; index < (await tabs.count()); index++) {
							await tabs.nth(index).click();
							await page.waitForTimeout(500);
							await shoot(`${destination}-${index}-wide`);
						}
						await setSize(app, page, NARROW);
						await shoot(`${destination}-narrow`);
						await setSize(app, page, WIDE);
						await page.keyboard.press("Escape");
					}
					await page.keyboard.press("ControlOrMeta+Comma");
					const settings = page.locator("[data-settings-page]");
					await expect(settings).toBeVisible();
					await settings.locator('[data-settings-section="schedules"]').click();
					await page.waitForTimeout(400);
					await shoot("schedules-wide");
					await setSize(app, page, NARROW);
					await shoot("schedules-narrow");
					await setSize(app, page, WIDE);
					await page.keyboard.press("Escape");
				});
				expect(errors).toEqual([]);
			},
		);
	});

	test(`preview devices and visuals, terminal shells, jobs, plan and schedules ${language}-${theme}`, async () => {
		test.setTimeout(420_000);
		const server = createServer((_request, response) => {
			response.writeHead(200, { "Content-Type": "text/html" });
			response.end(
				"<!doctype html><title>Device page</title><meta name=viewport content='width=device-width'><h1>Device page</h1>",
			);
		});
		const listening = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", () => listening.resolve());
		await listening.promise;
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No fixture server address");
		const host = `127.0.0.1:${address.port}`;
		try {
			await flow(
				"tools",
				{
					language,
					theme,
					natives: true,
					env: { OMP_GUI_TEST_LOGIN: "1", OMP_GUI_TEST_MODELS: "1" },
					seed: async project => {
						git(project, "init", "-q", "-b", "main");
						await fs.writeFile(path.join(project, "plan.md"), "# Delivery plan\n\n- [x] Inspect\n- [ ] Ship\n");
					},
				},
				async ({ page, app, shoot, step, errors }) => {
					await buildSplit(page, 4);
					for (const [name, size] of [
						["wide", WIDE],
						["narrow", NARROW],
					] as const) {
						await setSize(app, page, size);
						await step(`preview-devices-${name}`, async () => {
							const panel = await openView(page, t.preview);
							const addressBar = panel.locator("form input[inputmode=url]");
							await addressBar.fill(host);
							await addressBar.press("Enter");
							await expect(page.locator("[data-preview-status]")).toHaveText("Device page", { timeout: 20_000 });
							await panel.getByRole("button", { name: t.options, exact: true }).click();
							await page.getByRole("menuitemcheckbox", { name: /390/ }).click();
							await shoot(`${name}-preview-phone`);
							await panel.getByRole("button", { name: t.options, exact: true }).click();
							await page.getByRole("menuitem", { name: /^(All visuals…|모든 시각화…)$/ }).click();
							await shoot(`${name}-preview-all-visuals`);
							await page.keyboard.press("Escape");
						});
						await step(`terminal-menu-${name}`, async () => {
							await openView(page, t.files);
							await page.locator(".omp-panel-topbar:visible").getByRole("button").first().click();
							await page.waitForTimeout(800);
							await page.getByRole("button", { name: /another shell|다른 셸/ }).click();
							await shoot(`${name}-terminal-shell-menu`);
							await page.keyboard.press("Escape");
						});
						await step(`plan-and-jobs-${name}`, async () => {
							const panel = await openView(page, t.files);
							const options = panel.getByRole("button", { name: /View options|보기 옵션/ });
							const items = page.getByRole("menuitemcheckbox");
							for (const index of [0, 1]) {
								await options.click();
								await items.nth(index).click();
								await page.waitForTimeout(400);
								await shoot(`${name}-view-${index}`);
							}
						});
						if (name === "narrow") await page.keyboard.press("Escape");
					}
					await step("schedule-form", async () => {
						await setSize(app, page, WIDE);
						await page.keyboard.press("ControlOrMeta+Comma");
						const settings = page.locator("[data-settings-page]");
						await expect(settings).toBeVisible();
						await settings.locator('[data-settings-section="schedules"]').click();
						await settings.locator("[data-schedule-new]").first().click();
						const dialog = page.getByRole("dialog");
						await expect(dialog.locator("[data-schedule-form]")).toBeVisible();
						await shoot("schedule-form-wide");
						await setSize(app, page, NARROW);
						await shoot("schedule-form-narrow");
						await dialog.getByRole("button", { name: /^(Create|만들기)$/ }).click();
						await shoot("schedule-form-empty-submit");
						await page.keyboard.press("Escape");
					});
					expect(errors).toEqual([]);
				},
			);
		} finally {
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});
}
