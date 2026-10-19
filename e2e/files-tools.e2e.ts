import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp, fixtureOmp, variants } from "./harness";

// Files panel writes and live state on the fake omp: git marks (C39), new file
// and folder (C34), rename (C35), Move to Trash with confirm (C36; main's
// shell.trashItem is swapped for a plain remove so the test never touches the
// user's Trash), drag into the composer as an @mention (C42), and an open file
// that reloads when it changes on disk and says so when it disappears (C18),
// and the viewer's Edit with ⌘S and an outside change while editing (C2).
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
		contentSearch: "Search in files",
		query: "Text to find in files",
		matchCase: "Match case",
		count: "1 matches in 1 files",
		sidePanel: "Side panel",
		edit: "Edit",
		editor: "Contents of notes.md",
		saved: "Saved",
		unsaved: "Unsaved",
		changedOnDisk: "This file changed on disk since you opened it. Your edits are still here.",
		reloadDisk: "Load the disk version",
		discard: "Discard",
		cancel: "Cancel",
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
		contentSearch: "파일 내용 검색",
		query: "파일에서 찾을 텍스트",
		matchCase: "대소문자 구분",
		count: "파일 1개에서 1건",
		sidePanel: "사이드 패널",
		edit: "편집",
		editor: "notes.md 내용",
		saved: "저장됨",
		unsaved: "저장 안 됨",
		changedOnDisk: "파일을 연 뒤에 디스크에서 내용이 바뀌었어요. 편집한 내용은 그대로 있어요.",
		reloadDisk: "디스크 버전 불러오기",
		discard: "버리기",
		cancel: "취소",
	},
} as const;

for (const [language, theme] of variants([
	["en", "light"],
	["ko", "dark"],
] as const)) {
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
		// Content search runs stock pi-natives grep in the stock helper; the fake omp borrows the installed one.
		const bin = await fixtureOmp(profile);
		const natives =
			process.env.OMP_GUI_TEST_NATIVES ||
			path.join(os.homedir(), ".bun/install/global/node_modules/@oh-my-pi/pi-natives");
		await fs.symlink(natives, path.join(path.dirname(bin), "node_modules/@oh-my-pi/pi-natives"), "junction");
		const env = {
			...process.env,
			OMP_GUI_HEADLESS: "1",
			PI_CODING_AGENT_DIR: agent,
			OMP_GUI_OMP: bin,
		};
		Reflect.deleteProperty(env, "ELECTRON_RUN_AS_NODE");
		const app = await electron.launch({
			args: [
				path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"),
				project,
				`--user-data-dir=${desktop}`,
			],
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

			// C46/C47/C48: ⌥⌘F searches file contents through stock grep; Match case narrows it; a hit opens its line.
			await page.keyboard.press("Alt+Meta+f");
			const query = aside.getByRole("searchbox", { name: label.query });
			await expect(query).toBeFocused();
			await query.fill("ONE");
			await expect(aside.locator("[data-content-search-count]")).toHaveText(label.count);
			await expect(aside.locator('[data-content-search-file="src/app.ts"]')).toBeVisible();
			await capture("files-search");
			await aside.getByRole("button", { name: label.matchCase, exact: true }).click();
			await expect(aside.locator("[data-content-search-count]")).toHaveCount(0);
			await aside.getByRole("button", { name: label.matchCase, exact: true }).click();
			await aside.getByRole("button", { name: /export const one/ }).click();
			await expect(aside.locator("[data-viewer-kind]")).toBeVisible();
			await aside.getByRole("button", { name: label.back, exact: true }).click();
			await aside.getByRole("button", { name: label.contentSearch, exact: true }).click();

			// C18: the open file follows the disk, then says when it is gone.
			await row("file:notes.md").click();
			await expect(aside.getByText("Notes", { exact: true }).first()).toBeVisible();
			await fs.writeFile(path.join(project, "notes.md"), "# Changed on disk\n");
			await expect(aside.getByText("Changed on disk")).toBeVisible({ timeout: 10_000 });

			// C2: Edit holds the whole file; ⌘S saves it in place; an outside change while editing keeps the edits.
			await aside.getByRole("button", { name: label.edit, exact: true }).click();
			const editor = aside.getByRole("textbox", { name: label.editor, exact: true });
			await expect(editor).toBeFocused();
			await page.keyboard.press("ControlOrMeta+End");
			await page.keyboard.type("Edited in OMPdesk\n");
			const status = aside.locator("[data-editor-status]");
			await expect(status).toHaveText(label.unsaved);
			await page.keyboard.press("ControlOrMeta+s");
			await expect(status).toHaveText(label.saved);
			expect(await fs.readFile(path.join(project, "notes.md"), "utf8")).toBe(
				"# Changed on disk\nEdited in OMPdesk\n",
			);
			// The header's size follows the save (36 bytes now), not the 18 the file had when it was opened.
			await expect(aside.locator("[data-file-meta]")).toContainText("36 B");
			await capture("files-edit");
			await page.keyboard.type("draft");
			await fs.writeFile(path.join(project, "notes.md"), "# Someone else\n");
			await expect(aside.getByText(label.changedOnDisk)).toBeVisible({ timeout: 10_000 });
			await capture("files-edit-conflict");
			await aside.getByRole("button", { name: label.reloadDisk, exact: true }).click();
			await expect(editor).toContainText("# Someone else");
			await expect(status).toHaveText(label.saved);
			// C2: unsaved edits hold back a switch elsewhere (here ⌥⌘F) until the user answers.
			await editor.click();
			await page.keyboard.type("unsaved");
			await expect(status).toHaveText(label.unsaved);
			await page.keyboard.press("Alt+Meta+f");
			const discard = page.getByRole("dialog");
			await expect(discard).toContainText("notes.md");
			await capture("files-edit-switch");
			await discard.getByRole("button", { name: label.cancel, exact: true }).click();
			await expect(editor).toContainText("unsaved");
			await page.keyboard.press("Alt+Meta+f");
			await page.getByRole("dialog").getByRole("button", { name: label.discard, exact: true }).click();
			await expect(aside.getByRole("searchbox", { name: label.query })).toBeFocused();
			expect(await fs.readFile(path.join(project, "notes.md"), "utf8")).toBe("# Someone else\n");
			await aside.getByRole("button", { name: label.contentSearch, exact: true }).click();
			await row("file:notes.md").click();
			await expect(aside.locator("[data-file-editor]")).toHaveCount(0);
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
