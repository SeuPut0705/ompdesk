import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { AGENT_DESKTOP_TOOL_PREFIX } from "../resources/gui-bridge/modes/computer-use-contracts";
import { exitApp } from "./harness";
import { realOmpProfile } from "./real-omp";

/**
 * Opt-in (`OMP_GUI_REAL_AGENT_DESKTOP=1`, macOS, network, a small-model request): OMPdesk on an isolated copy of the
 * user's real omp profile. The first launch has no agent-desktop, so its session falls back to the built-in prelude and
 * says so; machine setup's Retry then installs agent-desktop through the managed path; the relaunched session drives
 * TextEdit with agent-desktop's tools in the background: the pointer and the frontmost app stay where they were.
 * `OMP_GUI_AGENT_DESKTOP_SHOTS=<dir>` keeps the captures.
 */

/** The pointer position and the frontmost app, read through AppKit (JXA; reads only, needs no permission). */
function desktopFocus(): string {
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

async function ask(page: Page, prompt: string, timeout: number): Promise<void> {
	const input = page.locator("textarea").first();
	await input.fill(prompt);
	await input.press("Enter");
	await expect(page.getByPlaceholder(/Add an instruction/)).toBeVisible({ timeout: 60_000 });
	await expect(page.getByPlaceholder(/Ask anything ·/)).toBeVisible({ timeout });
}

async function shot(page: Page, name: string): Promise<void> {
	const dir = process.env.OMP_GUI_AGENT_DESKTOP_SHOTS;
	const file = dir ? path.join(dir, name) : test.info().outputPath(name);
	await page.screenshot({ path: file });
	await test.info().attach(name, { path: file, contentType: "image/png" });
}

test("a session falls back visibly without agent-desktop, then drives TextEdit with it in the background", async () => {
	test.skip(process.env.OMP_GUI_REAL_AGENT_DESKTOP !== "1" || process.platform !== "darwin", "Opt-in, macOS");
	test.setTimeout(900_000);
	const real = await realOmpProfile();
	const dir = process.env.OMP_GUI_AGENT_DESKTOP_SHOTS;
	if (dir) await fs.mkdir(dir, { recursive: true });
	let { app, page } = await launch(real.project, real.desktop, real.env);
	try {
		await ask(page, "Reply with the single word OK.", 180_000);
		await expect(page.locator("[data-computer-use-note]")).toBeVisible();
		await shot(page, "1-fallback-note.png");

		await page.evaluate(() => window.omp.setup.retry("agent-desktop"));
		await expect
			.poll(
				async () =>
					(await page.evaluate(() => window.omp.setup.getState())).items.find(item => item.id === "agent-desktop")
						?.phase,
				{ timeout: 180_000, intervals: [500, 1000] },
			)
			.toBe("present");
		await exitApp(app);

		({ app, page } = await launch(real.project, real.desktop, real.env));
		const stamp = `agent-desktop smoke ${Date.now()}`;
		const before = desktopFocus();
		await ask(
			page,
			[
				"Use only the agent-desktop desktop_* tools for the desktop (no bash, no eval).",
				"Launch TextEdit without activating it, open a new blank document through its File menu (menubar surface),",
				`type exactly this line into the new document's text area: ${stamp}`,
				"then read that text area's value back with desktop_get and reply with the value verbatim.",
			].join(" "),
			600_000,
		);
		const after = desktopFocus();
		await shot(page, "2-agent-desktop-turn.png");
		const state = await page.evaluate(() => window.omp.rpc.getState());
		const sessionFile = (state.data as { sessionFile?: string } | undefined)?.sessionFile ?? "";
		const journal = await fs.readFile(sessionFile, "utf8");
		expect(journal).toContain(AGENT_DESKTOP_TOOL_PREFIX);
		expect(journal).toContain(stamp);
		expect(journal).not.toContain('"name":"eval"');
		expect(after).toBe(before);
		await test.info().attach("focus", { body: `before ${before}\nafter  ${after}`, contentType: "text/plain" });
		await test.info().attach("session.jsonl", { body: journal, contentType: "application/x-ndjson" });
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
			? path.join(dir, "3-work-card-expanded.png")
			: test.info().outputPath("3-work-card-expanded.png");
		await card.screenshot({ path: expanded });
	} finally {
		await exitApp(app);
		await fs.rm(real.profile, { recursive: true, force: true });
	}
});
