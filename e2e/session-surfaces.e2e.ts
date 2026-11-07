/**
 * Every surface that says what a session is doing says the same thing as its sidebar row: the title bar's status
 * pill, the window title's mark, the split pane's header and the Work tree's root (the owner's report, 8 Nov 2026,
 * after the sidebar's state bugs came back eight times because each surface derived the run state on its own). All of
 * them read the session's one summary (`shared/session-summary.ts`) by the one rule (`lib/session-run.ts`). Two
 * tabs split side by side on the fake omp; tab A is the focused pane. `OMP_GUI_SURFACES=<dir>` writes a capture per
 * state.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { captureTo, cssString, exitApp, launchApp } from "./harness";

const CAPTURES = process.env.OMP_GUI_SURFACES;

type Run = "running" | "waiting" | "failed" | "idle";

interface SurfaceRuns {
	row: Run;
	titleBar: Run;
	windowTitle: Run;
	paneHeader: Run;
	workTree: Run | "absent";
	/** Subagents at work: the row's family chip, and the Work tree's running rows under the root. */
	rowAgents: number;
	treeAgents: number;
}

/** What each surface says of `sessionPath` (in tab `tabId`), in one vocabulary. */
function readSurfaces(page: Page, sessionPath: string, tabId: string): Promise<SurfaceRuns> {
	return page.evaluate(
		([file, id]) => {
			const row = [...document.querySelectorAll(".omp-session-sidebar [data-session-path]")].find(
				element =>
					element.getAttribute("data-session-path") === file &&
					!element.hasAttribute("data-sidebar-opened-session"),
			);
			const signal = row?.getAttribute("data-signal");
			const tone = document.querySelector(".omp-titlebar-status")?.getAttribute("data-tone");
			const mark = document.title.slice(0, 1);
			const header = document.querySelector(`.omp-session-pane[data-tab-id="${id}"] header`);
			const failedMark = header?.querySelector("[data-pane-failed], svg[class*='circle-x'], svg[class*='x-circle']");
			const root = document.querySelector(`[data-work-tree-row="tab:${id}"]`);
			const state = root?.getAttribute("data-state");
			return {
				row:
					signal === "running"
						? "running"
						: signal === "waiting"
							? "waiting"
							: signal === "error"
								? "failed"
								: "idle",
				titleBar:
					tone === "busy" ? "running" : tone === "attention" ? "waiting" : tone === "error" ? "failed" : "idle",
				windowTitle: mark === "●" ? "running" : mark === "!" ? "waiting" : "idle",
				paneHeader: header?.querySelector('.omp-live-text[data-working="waiting"]')
					? "waiting"
					: header?.getAttribute("data-pane-running") === "true"
						? "running"
						: failedMark
							? "failed"
							: "idle",
				workTree: !root
					? "absent"
					: state === "running" || state === "waiting" || state === "failed"
						? state
						: "idle",
				rowAgents: Number(row?.querySelector("[data-family-running]")?.getAttribute("data-family-running") ?? 0),
				treeAgents: [...document.querySelectorAll(`[data-work-tree-row^="agent:${id}:"]`)].filter(
					element => element.getAttribute("data-state") === "running",
				).length,
			} as const;
		},
		[sessionPath, tabId] as const,
	);
}

test("the title bar, the window title, the pane header and the Work tree say what the sidebar row says", async () => {
	test.setTimeout(240_000);
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-surfaces-"));
	const [project, desktop, agent] = ["project", "desktop", "agent"].map(name => path.join(profile, name)) as [
		string,
		string,
		string,
	];
	await Promise.all([project, desktop, agent].map(dir => fs.mkdir(dir)));
	await fs.writeFile(path.join(desktop, "prefs.json"), JSON.stringify({ language: "en", firstRunComplete: true }));
	const app = await launchApp({ project, desktop, agent, profile });
	try {
		const page = await app.firstWindow();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1280, 860));
		await page.waitForFunction(() => window.omp?.rpc != null);
		const tabs = () => page.evaluate(() => window.omp.tabs.list());
		const run = (tabId: string, body: { type: "prompt"; message: string } | { type: "bash"; command: string }) =>
			page.evaluate(([id, command]) => window.omp.rpc.commandForTab(id, command), [tabId, body] as const);
		const statusOf = async (tabId: string) => (await tabs()).find(tab => tab.tabId === tabId)?.status;
		/** A titled session with one answered turn; its row's key (`tab:<id>` while the fake omp writes no file). */
		const seed = async (tabId: string, title: string) => {
			await expect.poll(() => statusOf(tabId), { timeout: 60_000 }).toBe("ready");
			await run(tabId, { type: "bash", command: `fixture:title:${title}` });
			await run(tabId, { type: "prompt", message: "hello" });
			await expect
				.poll(async () => (await tabs()).find(tab => tab.tabId === tabId)?.lastRun?.reply, { timeout: 30_000 })
				.toBe("Local fixture reply");
			return (await tabs()).find(tab => tab.tabId === tabId)?.sessionPath || `tab:${tabId}`;
		};

		const tabA = (await tabs()).find(tab => tab.active)?.tabId ?? "";
		const pathA = await seed(tabA, "Surfaces A");
		const before = (await tabs()).map(tab => tab.tabId);
		await page.keyboard.press("ControlOrMeta+t");
		await expect.poll(async () => (await tabs()).length).toBe(before.length + 1);
		const tabB = (await tabs()).find(tab => !before.includes(tab.tabId))?.tabId ?? "";
		await seed(tabB, "Surfaces B");
		const beforeC = (await tabs()).map(tab => tab.tabId);
		await page.keyboard.press("ControlOrMeta+t");
		await expect.poll(async () => (await tabs()).length).toBe(beforeC.length + 1);
		const tabC = (await tabs()).find(tab => !beforeC.includes(tab.tabId))?.tabId ?? "";
		await seed(tabC, "Surfaces C");

		// A beside the tab in front; A focused, so the title bar and the window title speak of A. The tab left out of
		// the split is shown by no pane: only main's summary and this window's tab events speak of it.
		const rowA = page.locator(`.omp-session-sidebar .omp-sidebar-session-row[data-session-path=${cssString(pathA)}]`);
		await rowA.click({ button: "right" });
		await page.getByRole("menuitem", { name: "Split right" }).click();
		await expect(page.locator(`.omp-session-pane[data-tab-id="${tabA}"] header`)).toBeVisible();
		await page.locator(`.omp-session-pane[data-tab-id="${tabA}"] header`).click();
		await expect.poll(async () => (await tabs()).find(tab => tab.active)?.tabId).toBe(tabA);
		const hidden = (await page.locator(`.omp-session-pane[data-tab-id="${tabB}"]`).count()) === 0 ? tabB : tabC;
		const hiddenPath = (await tabs()).find(tab => tab.tabId === hidden)?.sessionPath || `tab:${hidden}`;

		await page.keyboard.press("ControlOrMeta+k");
		await page.keyboard.type("Work tree");
		await page
			.getByRole("option", { name: /Work tree/ })
			.first()
			.click();
		await expect(page.locator("[data-work-tree]")).toBeVisible();

		const failures: string[] = [];
		const agree = async (state: string, want: Run, workTree: Run | "absent" | "any" = "any") => {
			let last: SurfaceRuns | undefined;
			const wanted = (runs: SurfaceRuns) =>
				runs.row === want &&
				runs.titleBar === want &&
				runs.windowTitle === want &&
				runs.paneHeader === want &&
				(workTree === "any" || runs.workTree === workTree);
			try {
				await expect
					.poll(
						async () => {
							last = await readSurfaces(page, pathA, tabA);
							return wanted(last);
						},
						{ timeout: 15_000 },
					)
					.toBe(true);
			} catch {
				failures.push(`${state}: want ${want} everywhere (work tree ${workTree}), got ${JSON.stringify(last)}`);
			}
			await captureTo(CAPTURES, page, state);
		};

		await agree("1-idle", "idle");

		await run(tabA, { type: "prompt", message: "fixture running" });
		await agree("2-running", "running");

		// Subagents start and finish: the family stays listed in the Work tree (its finished fold).
		await run(tabA, { type: "bash", command: "fixture:subagents" });
		await agree("3-subagents-running", "running", "running");
		for (const id of ["sa-explore", "sa-nested"])
			await run(tabA, { type: "bash", command: `fixture:subagents:finish:${id}` });
		await run(tabA, { type: "bash", command: "fixture:finish" });
		await agree("4-finished", "idle", "idle");

		await run(tabA, { type: "prompt", message: "fixture approval" });
		await agree("5-waiting-approval", "waiting", "waiting");
		// The Work tree is a sheet over the pane: it steps aside while the person answers, then comes back.
		await page.keyboard.press("Escape");
		await expect(page.locator("[data-work-tree]")).toHaveCount(0);
		await page.getByRole("button", { name: "Deny" }).first().click();
		await page.keyboard.press("ControlOrMeta+k");
		await page.keyboard.type("Work tree");
		await page
			.getByRole("option", { name: /Work tree/ })
			.first()
			.click();
		await expect(page.locator("[data-work-tree]")).toBeVisible();
		await agree("6-answered", "idle", "idle");

		// A turn that ends in an error: the session's omp is up and idle (its transcript says what failed), so no surface
		// calls the session failed; before, the Work tree read the turn's ending on its own and marked the root failed.
		await run(tabA, { type: "prompt", message: "fixture usage limit" });
		await expect
			.poll(async () => (await tabs()).find(tab => tab.tabId === tabA)?.lastRun?.stopReason, { timeout: 30_000 })
			.toBe("error");
		await agree("7-turn-error", "idle", "idle");

		// A tab no pane shows: its row, and its subagents at work in the row's chip and the Work tree. The tree lists a
		// family only while it has something under the root; where it does, the root says what the row says.
		const agreeHidden = async (state: string, want: Run, agents: number) => {
			let last: SurfaceRuns | undefined;
			try {
				await expect
					.poll(
						async () => {
							last = await readSurfaces(page, hiddenPath, hidden);
							return (
								last.row === want &&
								(last.workTree === want || (agents === 0 && last.workTree === "absent")) &&
								last.rowAgents === agents &&
								last.treeAgents === agents
							);
						},
						{ timeout: 15_000 },
					)
					.toBe(true);
			} catch {
				failures.push(
					`${state}: want ${want} with ${agents} subagents in row and tree, got ${JSON.stringify(last)}`,
				);
			}
			await captureTo(CAPTURES, page, state);
		};
		await run(hidden, { type: "prompt", message: "fixture running" });
		await run(hidden, { type: "bash", command: "fixture:subagents" });
		await agreeHidden("8-hidden-subagents", "running", 2);
		await run(hidden, { type: "bash", command: "fixture:subagents:finish:sa-explore" });
		await agreeHidden("9-hidden-one-finished", "running", 1);
		await run(hidden, { type: "bash", command: "fixture:subagents:finish:sa-nested" });
		await run(hidden, { type: "bash", command: "fixture:finish" });
		await agreeHidden("10-hidden-finished", "idle", 0);
		await run(hidden, { type: "prompt", message: "fixture approval" });
		await agreeHidden("11-hidden-waiting", "waiting", 0);

		expect(failures, "surfaces that disagree with the sidebar row").toEqual([]);
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});
