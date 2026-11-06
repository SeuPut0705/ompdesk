import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { AGENT_DESKTOP_TOOL_PREFIX } from "../resources/gui-bridge/modes/computer-use-contracts";
import { managedAgentDesktopDir, managedToolsDir } from "../src/main/setup/paths";
import { exitApp, pressShortcutUntilVisible } from "./harness";
import { realOmpProfile } from "./real-omp";

/**
 * Opt-in (`OMP_GUI_REAL_AGENT_DESKTOP=1`, macOS or Windows, network, a small-model request): OMPdesk on an isolated
 * copy of the user's real omp profile, with an empty managed tools dir, as on a first launch. The session runs on the
 * agent-desktop the app ships (`bun run build:agent-desktop` unpacks it into resources/agent-desktop-bin, the dev
 * run's bundle): Settings names its version, nothing is downloaded into the managed tools dir, no fallback note
 * appears, and the session drives the platform's text editor with agent-desktop's tools only. macOS: TextEdit in the
 * background (the pointer and the frontmost app stay where they were). Windows: Notepad, whose text is then read back
 * through UI Automation, outside the session; Notepad's XAML text area takes keys only from the system input queue,
 * so the foreground is not asserted there. Windows keeps the managed tools dir under `%LOCALAPPDATA%`, which the run
 * points into the profile, so the user's own tools dir is never touched. `OMP_GUI_AGENT_DESKTOP_SHOTS=<dir>` keeps the
 * captures.
 */

const WIN = process.platform === "win32";

/** The pointer position and the frontmost app; reads only, needs no permission. */
function desktopFocus(): string {
	if (WIN) {
		return powershell(
			[
				"Add-Type -AssemblyName System.Windows.Forms",
				'Add-Type -Namespace Focus -Name User32 -MemberDefinition \'[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr window, out uint pid);\'',
				"$pid0 = 0; [void][Focus.User32]::GetWindowThreadProcessId([Focus.User32]::GetForegroundWindow(), [ref]$pid0)",
				"$p = [System.Windows.Forms.Cursor]::Position",
				"'' + $p.X + ',' + $p.Y + ' ' + (Get-Process -Id $pid0).ProcessName",
			].join("\n"),
		);
	}
	return execFileSync(
		"osascript",
		[
			"-l",
			"JavaScript",
			"-e",
			'ObjC.import("AppKit"); const p = $.NSEvent.mouseLocation; Math.round(p.x) + "," + Math.round(p.y) + " " + $.NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier.js',
		],
		{ encoding: "utf8" },
	).trim();
}

function powershell(script: string): string {
	return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
		encoding: "utf8",
	}).trim();
}

/** The text of every open Notepad document, through UI Automation (Windows 11 Notepad: a `Document` with TextPattern). */
function notepadText(): string {
	return powershell(
		[
			"Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes",
			"$A = [System.Windows.Automation.AutomationElement]",
			"$byClass = New-Object System.Windows.Automation.PropertyCondition($A::ClassNameProperty, 'Notepad')",
			"$byDoc = New-Object System.Windows.Automation.PropertyCondition($A::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)",
			"foreach ($w in $A::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $byClass)) {",
			"  foreach ($d in $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $byDoc)) {",
			"    $d.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern).DocumentRange.GetText(-1)",
			"  }",
			"}",
		].join("\n"),
	);
}

function notepadPids(): Set<number> {
	const out = powershell("@(Get-Process notepad -ErrorAction SilentlyContinue).Id; exit 0");
	return new Set(out.split(/\s+/).filter(Boolean).map(Number));
}

async function launch(project: string, desktop: string, env: Record<string, string>) {
	const app = await electron.launch({
		args: [
			path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"),
			project,
			`--user-data-dir=${desktop}`,
		],
		env,
	});
	const page = await app.firstWindow();
	await expect
		.poll(() => page.evaluate(() => window.omp.sidecar.getStatus()), { timeout: 60_000 })
		.toMatchObject({ status: "ready" });
	return { app, page };
}

async function send(page: Page, prompt: string): Promise<void> {
	const input = page.locator("textarea").first();
	await input.fill(prompt);
	await input.press("Enter");
	await expect(page.getByPlaceholder(/Add an instruction/)).toBeVisible({ timeout: 60_000 });
}

async function ask(page: Page, prompt: string, timeout: number): Promise<void> {
	await send(page, prompt);
	await expect(page.getByPlaceholder(/Ask anything ·/)).toBeVisible({ timeout });
}

async function shot(page: Page, name: string): Promise<void> {
	const dir = process.env.OMP_GUI_AGENT_DESKTOP_SHOTS;
	const file = dir ? path.join(dir, name) : test.info().outputPath(name);
	await page.screenshot({ path: file });
	await test.info().attach(name, { path: file, contentType: "image/png" });
}

test("a first launch drives the text editor with the agent-desktop the app ships, downloading nothing", async () => {
	test.skip(
		process.env.OMP_GUI_REAL_AGENT_DESKTOP !== "1" || (process.platform !== "darwin" && !WIN),
		"Opt-in, macOS or Windows",
	);
	const bundle = path.resolve("resources/agent-desktop-bin", `${process.platform}-${process.arch}`);
	test.skip(
		!existsSync(path.join(bundle, "agent-desktop.build.json")),
		"No bundled agent-desktop: run `bun run build:agent-desktop`",
	);
	test.setTimeout(900_000);
	const real = await realOmpProfile();
	const env = WIN ? { ...real.env, LOCALAPPDATA: path.join(real.profile, "local") } : real.env;
	const tools = managedToolsDir(WIN ? "win32" : "darwin", env, os.homedir(), real.desktop);
	const dir = process.env.OMP_GUI_AGENT_DESKTOP_SHOTS;
	if (dir) await fs.mkdir(dir, { recursive: true });
	const notepadsBefore = WIN ? notepadPids() : new Set<number>();
	const { app, page } = await launch(real.project, real.desktop, env);
	try {
		await expect
			.poll(
				async () =>
					(await page.evaluate(() => window.omp.setup.getState())).items.find(item => item.id === "agent-desktop")
						?.phase,
				{ timeout: 120_000, intervals: [500, 1000] },
			)
			.toBe("present");
		const settings = page.locator("[data-settings-page]");
		await pressShortcutUntilVisible(page, "ControlOrMeta+Comma", settings);
		await settings.locator('[data-settings-section="agent"]').click();
		const installed = settings.locator("[data-computer-use-installed]");
		await expect(installed).toContainText(/agent-desktop \d+\.\d+\.\d+ is installed/);
		await installed.scrollIntoViewIfNeeded();
		await shot(page, "1-settings-version.png");
		await page.keyboard.press("Escape");

		const stamp = `agent-desktop smoke ${Date.now()}`;
		const before = desktopFocus();
		const steps = WIN
			? [
					"Use only the agent-desktop desktop_* tools for the desktop (no bash, no eval).",
					"Launch Notepad, then type exactly this line into its text area:",
					`${stamp}`,
					"then read that text area's value back with desktop_get and reply with the value verbatim.",
				]
			: [
					"Use only the agent-desktop desktop_* tools for the desktop (no bash, no eval).",
					"Launch TextEdit without activating it, open a new blank document through its File menu (menubar surface),",
					`type exactly this line into the new document's text area: ${stamp}`,
					"then read that text area's value back with desktop_get and reply with the value verbatim.",
				];
		await ask(page, steps.join(" "), 600_000);
		const after = desktopFocus();
		await shot(page, "3-agent-desktop-turn.png");
		const state = await page.evaluate(() => window.omp.rpc.getState());
		const sessionFile = (state.data as { sessionFile?: string } | undefined)?.sessionFile ?? "";
		const journal = await fs.readFile(sessionFile, "utf8");
		await test.info().attach("focus", { body: `before ${before}\nafter  ${after}`, contentType: "text/plain" });
		const journalFile = test.info().outputPath("session.jsonl");
		await fs.writeFile(journalFile, journal);
		await test.info().attach("session.jsonl", { path: journalFile, contentType: "application/x-ndjson" });
		// A long turn can be compacted on the small model: its cards then sit behind "Show N earlier messages".
		const earlier = page.getByRole("button", { name: /Show \d+ earlier messages/ });
		while (await earlier.isVisible()) await earlier.click();
		// A turn that did its work has no failed card (advisor notes and narration can split it into several; a card the
		// session's todo list names reads that list's title, "Tasks", instead of "Work complete"), and the heads say what
		// it did on the desktop, never a tool's docs as files.
		const cards = page.locator(".omp-execution-group");
		await expect(cards.first()).toBeVisible();
		await expect(cards.filter({ hasText: "Work failed" })).toHaveCount(0);
		const heads = (await page.locator(".omp-execution-group-summary").allTextContents()).join(" | ");
		await test.info().attach("card heads", { body: heads, contentType: "text/plain" });
		expect(heads).toContain("desktop step");
		expect(heads).not.toMatch(/Read \d+ file/);
		expect(journal).toContain(AGENT_DESKTOP_TOOL_PREFIX);
		expect(journal).toContain(stamp);
		expect(journal).not.toContain('"name":"eval"');
		// The bundled copy ran: no fallback note in the transcript, nothing installed into the managed tools dir.
		await expect(page.locator("[data-computer-use-note]")).toHaveCount(0);
		expect(journal).not.toContain("ompdesk-computer-use");
		expect(existsSync(managedAgentDesktopDir(tools))).toBe(false);
		if (WIN) expect(notepadText()).toContain(stamp);
		else expect(after).toBe(before);
		// The work card opened, with its first snapshot's tree unfolded: what the renderer makes of agent-desktop's calls.
		const card = page.locator(".omp-execution-group").last();
		await card.locator(".omp-execution-group-header").first().click();
		const snapshot = card.locator(".omp-tool-card").filter({ hasText: /snapshot/i });
		if ((await snapshot.count()) > 0) await snapshot.first().locator("button[aria-expanded]").first().click();
		const opened = await card.boundingBox();
		await app.evaluate(
			({ BrowserWindow }, height) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, height),
			Math.ceil((opened?.height ?? 0) + 260),
		);
		await card.scrollIntoViewIfNeeded();
		const expanded = dir
			? path.join(dir, "4-work-card-expanded.png")
			: test.info().outputPath("4-work-card-expanded.png");
		await card.screenshot({ path: expanded });
	} finally {
		await exitApp(app);
		// Only the Notepad this run opened; one the person had open stays.
		if (WIN) for (const pid of notepadPids()) if (!notepadsBefore.has(pid)) process.kill(pid);
		// The Notepad the session started had the project folder as its working directory until it ended.
		await fs.rm(real.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
	}
});
