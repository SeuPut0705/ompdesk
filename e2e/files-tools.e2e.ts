import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp } from "./harness";

// Files panel writes and live state on the fake omp: git marks (C39), new file
// and folder (C34), rename (C35), Move to Trash with confirm (C36; main's
// shell.trashItem is swapped for a plain remove so the test never touches the
// user's Trash), drag into the composer as an @mention (C42), and an open file
// that reloads when it changes on disk and says so when it disappears (C18).
// OMP_GUI_FILES_TOOLS_CAPTURES=<dir> keeps the captures.

const LABELS = {
	en: {
		files: "Files",
		newFile: "New file…",
		newFolder: "New folder…",
		rename: "Rename…",
		trash: "Move to Trash",
		modified: "Modified",
		untracked: "Untracked",
		gone: "This file was deleted or renamed on disk.",
		back: "Back to files",
		sidePanel: "Side panel",
	},
	ko: {
		files: "파일",
		newFile: "새 파일…",
		newFolder: "새 폴더…",
		rename: "이름 바꾸기…",
		trash: "휴지통으로 이동",
		modified: "수정됨",
		untracked: "추적 안 됨",
		gone: "이 파일이 디스크에서 삭제되었거나 이름이 바뀌었어요.",
		back: "파일 목록으로",
		sidePanel: "사이드 패널",
	},
} as const;

for (const [language, theme] of [
	["en", "light"],
	["ko", "dark"],
] as const) {
	test(`Files panel: git marks, create, rename, trash, drag to composer, disk watch (${language}-${theme})`, async () => {
		test.setTimeout(120_000);
		const label = LABELS[language];
		const captures = process.env.OMP_GUI_FILES_TOOLS_CAPTURES;
		const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-files-tools-"));
		const desktop = path.join(profile, "desktop");
		const project = path.join(profile, "project");
		const agent = path.join(profile, "agent");
		await Promise.all([fs.mkdir(desktop), fs.mkdir(path.join(project, "src"), { recursive: true }), fs.mkdir(agent)]);
		await fs.writeFile(path.join(project, "src", "app.ts"), "export const one = 1;\n");
		const git = (...args: string[]) => execFileSync("git", args, { cwd: project, stdio: "ignore" });
		git("init", "-q");
		git("-c", "user.email=e2e@example.com", "-c", "user.name=e2e", "add", ".");
		git("-c", "user.email=e2e@example.com", "-c", "user.name=e2e", "commit", "-qm", "init");
		await fs.writeFile(path.join(project, "src", "app.ts"), "export const one = 2;\n");
		await fs.writeFile(path.join(project, "notes.md"), "# Notes\n");
		await fs.writeFile(
			path.join(desktop, "prefs.json"),
			JSON.stringify({ language, themeName: theme, firstRunComplete: true }),
		);
		const env = {
			...process.env,
			OMP_GUI_HEADLESS: "1",
			PI_CODING_AGENT_DIR: agent,
			OMP_GUI_OMP: await fixtureOmp(profile),
		};
		Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
		const app = await electron.launch({
			args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
			env,
		});
		const page = await app.firstWindow();
		const capture = async (name: string) => {
			if (!captures) return;
			await fs.mkdir(captures, { recursive: true });
			await page.locator("aside[data-docked]").screenshot({
				animations: "disabled",
				path: path.join(captures, `${name}-${language}-${theme}.png`),
			});
		};
		try {
			await page.waitForFunction(() => window.omp?.rpc != null);
			await expect
				.poll(async () => (await page.evaluate(() => window.omp.sidecar.getStatus())).status, { timeout: 60_000 })
				.toBe("ready");
			await app.evaluate(({ shell }) => {
				// This body runs serialized in the app's main process, where only built-ins are reachable.
				const { rm } = process.getBuiltinModule("node:fs/promises");
				shell.trashItem = (target: string) => rm(target, { recursive: true, force: true });
			});
			const aside = page.locator("aside[data-docked]");
			await page.getByRole("button", { name: label.sidePanel, exact: true }).click();
			await expect(aside).toBeVisible();
			await aside.getByRole("button", { name: label.files, exact: true }).click();
			const row = (id: string) => aside.locator(`[data-tree-id="${id}"]`);

			// C39: modified and untracked letters, a dot on the folder above.
			await expect(row("file:notes.md").locator("[data-git-mark]")).toHaveText(/^U/);
			await expect(row("dir:src").locator('[data-git-mark="dir"]')).toHaveCount(1);
			await row("dir:src").click();
			await expect(row("file:src/app.ts").locator('[data-git-mark="M"]')).toHaveAttribute("title", label.modified);
			await capture("files-git");

			// C34: a new file inside the selected folder, named inline.
			await aside.getByRole("button", { name: label.newFile, exact: true }).click();
			const field = aside.locator("[data-files-name-field]");
			await field.fill("made.ts");
			await field.press("Enter");
			await expect(row("file:src/made.ts")).toBeVisible();
			expect(await fs.readFile(path.join(project, "src", "made.ts"), "utf8")).toBe("");
			// A folder from the row menu.
			await row("dir:src").click({ button: "right" });
			await page.getByRole("menuitem", { name: label.newFolder, exact: true }).click();
			await field.fill("lib");
			await field.press("Enter");
			await expect(row("dir:src/lib")).toBeVisible();

			// C35: rename keeps the extension selected out and refuses nothing here.
			await row("file:src/made.ts").click({ button: "right" });
			await page.getByRole("menuitem", { name: label.rename, exact: true }).click();
			await expect(field).toHaveValue("made.ts");
			await capture("files-rename");
			await field.fill("renamed.ts");
			await field.press("Enter");
			await expect(row("file:src/renamed.ts")).toBeVisible();
			await expect(row("file:src/made.ts")).toHaveCount(0);

			// C36: Move to Trash asks first.
			await row("file:src/renamed.ts").click({ button: "right" });
			await page.getByRole("menuitem", { name: label.trash, exact: true }).click();
			const confirm = page.getByRole("dialog");
			await expect(confirm).toContainText("src/renamed.ts");
			await capture("files-trash");
			await confirm.getByRole("button", { name: label.trash, exact: true }).click();
			await expect(row("file:src/renamed.ts")).toHaveCount(0);
			await expect
				.poll(() =>
					fs.stat(path.join(project, "src", "renamed.ts")).then(
						() => true,
						() => false,
					),
				)
				.toBe(false);

			// C42: a row dragged onto the composer becomes an @mention.
			const composer = page.locator("textarea").first();
			await row("file:notes.md").dragTo(composer);
			await expect(composer).toHaveValue("@notes.md ");

			// C18: the open file follows the disk, then says when it is gone.
			await row("file:notes.md").click();
			await expect(aside.getByText("Notes", { exact: true }).first()).toBeVisible();
			await fs.writeFile(path.join(project, "notes.md"), "# Changed on disk\n");
			await expect(aside.getByText("Changed on disk")).toBeVisible({ timeout: 10_000 });
			await fs.rm(path.join(project, "notes.md"));
			await expect(aside.getByText(label.gone)).toBeVisible({ timeout: 10_000 });
			await capture("files-gone");
			await aside.getByRole("button", { name: label.back, exact: true }).click();
		} finally {
			await exitApp(app);
			await fs.rm(profile, { recursive: true, force: true });
		}
	});
}
