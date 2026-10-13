import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type ElectronApplication, _electron as electron } from "playwright";
import { exitApp, fixtureOmp, pressShortcutUntilVisible } from "./harness";

// Opt-in visual audit of the app shell (OMP_GUI_SHELL_AUDIT=<dir>): every
// sidebar, titlebar, composer popover, palette, dialog, toast, split and
// narrow-window state, captured per language and theme on the fake omp, plus
// the first run on the real omp with an empty agent dir. Each capture also
// records horizontal overflow and clipped text so a review starts from facts.

const directory = process.env.OMP_GUI_SHELL_AUDIT;
test.describe.configure({ mode: "parallel" });
test.skip(!directory, "set OMP_GUI_SHELL_AUDIT=<dir> to capture the shell audit");

type Language = "en" | "ko";
type Theme = "light" | "dark";

interface Finding {
	shot: string;
	kind: string;
	detail: string;
}

/** Stored sessions in two projects, one pinned-length title and one long one. */
async function seedSessions(agent: string, project: string, other: string): Promise<void> {
	const dir = path.join(agent, "sessions", "fixture");
	await fs.mkdir(dir, { recursive: true });
	const rows: [string, string, string, number][] = [
		["s-auth", project, "Refactor the authentication flow", 1],
		["s-long", project, "Investigate why the release workflow sometimes stalls on the Windows packaging step", 3],
		["s-ko", project, "사이드바 필터와 세션 이름 바꾸기 점검", 26],
		["s-docs", other, "Update README screenshots", 50],
		["s-old", other, "Old exploration", 24 * 9],
	];
	for (const [id, cwd, title, hoursAgo] of rows) {
		const time = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
		const lines = [
			{ type: "title", v: 1, title, updatedAt: time },
			{ type: "session", version: 3, id, timestamp: time, cwd },
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

async function launch(
	language: Language,
	theme: Theme,
	options: { real?: boolean } = {},
): Promise<{ app: ElectronApplication; page: Page; profile: string; project: string }> {
	const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-shell-audit-")));
	const project = path.join(profile, "project");
	const other = path.join(profile, "website");
	const desktop = path.join(profile, "desktop");
	const agent = path.join(profile, "agent");
	await Promise.all([project, other, desktop, agent].map(dir => fs.mkdir(dir)));
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({
			language,
			themeName: theme,
			firstRunComplete: true,
			...(options.real ? { launchProfiles: { [project]: { noRules: true, noLsp: true } } } : {}),
		}),
	);
	if (!options.real) await seedSessions(agent, project, other);
	const env: Record<string, string | undefined> = {
		...process.env,
		PI_CODING_AGENT_DIR: agent,
		PI_CONFIG_DIR: path.relative(os.homedir(), profile),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_TEST_SESSION_FILES: "1",
	};
	if (options.real) Reflect.deleteProperty(env, "OMP_GUI_OMP");
	else env.OMP_GUI_OMP = await fixtureOmp(profile);
	Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
	});
	const page = await app.firstWindow();
	await resize(app, 1440, 900);
	await page.waitForFunction(() => window.omp?.rpc != null);
	await expect
		.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 90_000 })
		.toBe("ready");
	return { app, page, profile, project };
}

async function resize(app: ElectronApplication, width: number, height: number): Promise<void> {
	await app.evaluate(
		({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height),
		{ width, height },
	);
}

/** Text clipped without an ellipsis and controls overflowing their window. */
async function inspect(page: Page, shot: string): Promise<Finding[]> {
	const found = await page.evaluate(() => {
		const out: { kind: string; detail: string }[] = [];
		const describe = (element: Element) => {
			const label = element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 60) ?? "";
			return `${element.tagName.toLowerCase()}${element.className && typeof element.className === "string" ? `.${element.className.split(" ").slice(0, 3).join(".")}` : ""} "${label}"`;
		};
		if (document.documentElement.scrollWidth > innerWidth + 1)
			out.push({ kind: "page-overflow", detail: `${document.documentElement.scrollWidth} > ${innerWidth}` });
		for (const element of document.querySelectorAll("button, [role=menuitem], [role=option], a, h1, h2, h3, label")) {
			const box = element.getBoundingClientRect();
			if (box.width === 0 || box.height === 0) continue;
			const style = getComputedStyle(element);
			if (style.visibility === "hidden") continue;
			if (box.right > innerWidth + 1 || box.left < -1)
				out.push({
					kind: "offscreen",
					detail: `${describe(element)} x=${Math.round(box.left)}..${Math.round(box.right)}`,
				});
			const overflowing = element.scrollWidth > element.clientWidth + 1 && element.clientWidth > 0;
			if (overflowing && style.textOverflow !== "ellipsis" && style.overflowX === "hidden")
				out.push({ kind: "clipped", detail: describe(element) });
		}
		return out;
	});
	return found.map(entry => ({ shot, ...entry }));
}

function capturer(page: Page, prefix: string, findings: Finding[]) {
	let index = 0;
	return async (name: string) => {
		if (!directory) return;
		index += 1;
		const shot = `${prefix}-${String(index).padStart(2, "0")}-${name}`;
		await page.screenshot({ path: path.join(directory, `${shot}.png`), scale: "css", animations: "disabled" });
		findings.push(...(await inspect(page, shot)));
	};
}

const COPY = {
	en: { send: "Send", rename: "Rename session", delete: "Delete", pin: "Pin to top", splitRight: "Split right" },
	ko: { send: "보내기", rename: "세션 이름 변경", delete: "삭제", pin: "맨 위에 고정", splitRight: "오른쪽으로 분할" },
} as const;
for (const language of ["en", "ko"] as const)
	for (const theme of ["light", "dark"] as const)
		test(`shell audit ${language} ${theme}`, async () => {
			test.setTimeout(300_000);
			const { app, page, profile, project } = await launch(language, theme);
			const findings: Finding[] = [];
			const errors: string[] = [];
			page.on("pageerror", error => errors.push(error.message));
			const shoot = capturer(page, `${language}-${theme}`, findings);
			const composer = page.locator("textarea").first();
			try {
				const first = (await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.active)?.tabId;
				if (!first) throw new Error("No active tab");
				await page.evaluate(
					id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:title:Audit the app shell" }),
					first,
				);
				await expect(page.getByRole("complementary").getByText("Audit the app shell")).toBeVisible();
				await page.waitForTimeout(400);
				await shoot("main");

				// Composer: a long draft, then each toolbar popover.
				await composer.fill(
					`${"A long draft that wraps over several lines to check the composer growth and the toolbar. ".repeat(4)}`,
				);
				await shoot("composer-long-draft");
				await composer.fill("");
				const toolbar = page.getByRole("toolbar").first();
				const triggers = toolbar.locator("button[aria-haspopup], button[data-model-chip]");
				const count = await triggers.count();
				for (let i = 0; i < count; i++) {
					const trigger = triggers.nth(i);
					if (!(await trigger.isVisible()) || (await trigger.isDisabled())) continue;
					await trigger.click();
					await page.waitForTimeout(250);
					await shoot(`composer-popover-${i}`);
					await page.keyboard.press("Escape");
					await page.waitForTimeout(150);
				}
				await composer.fill("/");
				await page.waitForTimeout(250);
				await shoot("completion-slash");
				await composer.fill("@");
				await page.waitForTimeout(250);
				await shoot("completion-at");
				await composer.fill("");
				await composer.press("Escape");
				await composer.focus();
				await page.keyboard.press("Control+r");
				await page.waitForTimeout(250);
				await shoot("history-search");
				await page.keyboard.press("Escape");

				// Palette: list, filter with no match.
				const palette = page.getByRole("dialog");
				await pressShortcutUntilVisible(page, "ControlOrMeta+k", palette);
				await page.waitForTimeout(200);
				await shoot("palette");
				await page.keyboard.type("zzqx nothing matches");
				await page.waitForTimeout(150);
				await shoot("palette-empty");
				await page.keyboard.press("Escape");
				await expect(palette).toHaveCount(0);

				// Sidebar rows: hover, context menu, inline rename, delete confirm.
				const stored = page.locator("[data-session-path]").filter({ hasText: "Refactor the authentication" });
				await stored.first().hover();
				await shoot("sidebar-hover");
				await stored.first().click({ button: "right" });
				await page.waitForTimeout(200);
				await shoot("sidebar-menu");
				await page.getByRole("menuitem", { name: COPY[language].rename }).click();
				await page.waitForTimeout(150);
				await shoot("sidebar-rename");
				await page.keyboard.press("Escape");
				await stored.first().click({ button: "right" });
				await page.getByRole("menuitem", { name: COPY[language].pin }).click();
				await page.waitForTimeout(250);
				await shoot("sidebar-pinned");
				await stored.first().click({ button: "right" });
				await page.getByRole("menuitem", { name: COPY[language].delete }).click();
				await page.waitForTimeout(250);
				await shoot("delete-confirm");
				await page.keyboard.press("Escape");

				// Subagents under the session row.
				await page.evaluate(
					id => window.omp.rpc.commandForTab(id, { type: "bash", command: "fixture:subagents" }),
					first,
				);
				await page.waitForTimeout(500);
				await shoot("sidebar-subagents");

				// Toast: the theme picker confirms a pick.
				await composer.fill("/theme");
				await page.getByRole("button", { name: COPY[language].send, exact: true }).first().click();
				await page.waitForTimeout(300);
				await shoot("theme-dialog");
				const picker = page.getByRole("dialog");
				await picker.locator('button[aria-pressed="true"]').first().click();
				await page.waitForTimeout(300);
				await shoot("toast");

				// Narrow windows.
				for (const width of [900, 720, 560]) {
					await resize(app, width, 760);
					await page.waitForTimeout(400);
					await shoot(`narrow-${width}`);
				}
				await resize(app, 1440, 900);

				// Split 2 and 4 panes.
				const spawn = async (title: string) => {
					const spawned = await page.evaluate(cwd => window.omp.tabs.spawn({ cwd, kind: "agent" }), project);
					if (!spawned?.tabId) throw new Error("expected a background tab");
					const id = spawned.tabId;
					await expect
						.poll(
							async () =>
								(await page.evaluate(() => window.omp.tabs.list())).find(tab => tab.tabId === id)?.status,
						)
						.toBe("ready");
					await page.evaluate(
						({ id, title }) =>
							window.omp.rpc.commandForTab(id, { type: "bash", command: `fixture:title:${title}` }),
						{ id, title },
					);
					return page.locator("[data-session-path]").filter({ hasText: title });
				};
				const second = await spawn("Second pane with a fairly long session title");
				await second.click({ button: "right" });
				await page.getByRole("menuitem", { name: COPY[language].splitRight }).click();
				await expect(page.locator(".omp-session-pane")).toHaveCount(2);
				await page.waitForTimeout(400);
				await shoot("split-2");
				for (const title of ["Third pane", "Fourth pane"]) {
					await (await spawn(title)).click({ button: "right" });
					const items = page.getByRole("menuitem").filter({ hasText: /split|분할/i });
					await items.nth((await items.count()) > 1 ? 1 : 0).click();
				}
				await page.waitForTimeout(500);
				await shoot("split-4");
				await resize(app, 1000, 760);
				await page.waitForTimeout(400);
				await shoot("split-4-narrow");
				await resize(app, 1440, 900);
			} finally {
				if (directory)
					await fs.writeFile(
						path.join(directory, `${language}-${theme}-findings.json`),
						JSON.stringify({ findings, errors }, null, 2),
					);
				await exitApp(app);
				await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		});

for (const [language, theme] of [
	["en", "light"],
	["ko", "dark"],
] as const)
	test(`first run audit ${language} ${theme}`, async () => {
		test.setTimeout(180_000);
		const { app, page, profile } = await launch(language, theme, { real: true });
		const findings: Finding[] = [];
		const shoot = capturer(page, `firstrun-${language}-${theme}`, findings);
		try {
			const setup = page.locator("section[aria-label], [role=region]").first();
			await expect(setup).toBeVisible({ timeout: 60_000 });
			await page.waitForTimeout(500);
			await shoot("setup");
			await resize(app, 640, 760);
			await page.waitForTimeout(400);
			await shoot("setup-narrow");
		} finally {
			if (directory)
				await fs.writeFile(
					path.join(directory, `firstrun-${language}-${theme}-findings.json`),
					JSON.stringify({ findings }, null, 2),
				);
			await exitApp(app);
			await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		}
	});
