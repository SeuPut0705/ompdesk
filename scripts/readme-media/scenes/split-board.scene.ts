/**
 * Split view + work board: one running session alone (its work board docks in the margin: subagents, todos), then
 * two more sessions dragged onto the workspace make a split of three panes, each its own session.
 */
import { expect, test } from "@playwright/test";
import { exitApp } from "../../../e2e/harness";
import { cleanup, fixture, flow, launch, makeProfile, Recorder, tabs } from "../lib";
import { dragOnto, finishedSession, startTurn } from "../sessions";

test("split view and work board", async () => {
	const profile = await makeProfile({ name: "split-board" });
	const { app, page } = await launch(profile, 1440, 900);
	const recorder = new Recorder("split-board", { width: 1440, height: 900, maxHold: 1_500, endHold: 2_500 });
	try {
		const first = (await tabs(page)).find(tab => tab.active)?.tabId ?? "";
		await startTurn(page, first, "Add saved addresses to the checkout form");
		await fixture(page, "fixture:title:Saved addresses", first);
		await flow(page, { op: "reply", text: "Saved addresses are in: the form offers the last three." }, first);
		await expect.poll(async () => (await tabs(page)).find(tab => tab.tabId === first)?.status).toBe("ready");
		await finishedSession(
			page,
			"Flaky tests",
			"Find out why the cart tests flake",
			"The cart tests raced on a shared timer; fixed.",
		);

		// The running session: a todo list and two subagents.
		await page.keyboard.press("ControlOrMeta+t");
		await expect.poll(async () => (await tabs(page)).length).toBe(3);
		const running = (await tabs(page)).find(tab => tab.active)?.tabId ?? "";
		await expect.poll(async () => (await tabs(page)).find(tab => tab.tabId === running)?.status).toBe("ready");
		await startTurn(page, running, "Update the docs for the new checkout");
		await fixture(page, "fixture:title:Checkout docs", running);
		await flow(page, { op: "call", id: "todo", name: "todo", args: {} }, running);
		await flow(
			page,
			{
				op: "end",
				id: "todo",
				text: "todo updated",
				details: {
					phases: [
						{
							name: "Docs",
							tasks: [
								{ content: "Read the checkout code", status: "completed" },
								{ content: "Rewrite the guide", status: "in_progress" },
								{ content: "Check every link", status: "pending" },
							],
						},
					],
				},
			},
			running,
		);
		await flow(
			page,
			{
				op: "call",
				id: "agents",
				name: "task",
				args: {
					tasks: [
						{ name: "GuideWriter", task: "Rewrite the guide" },
						{ name: "LinkChecker", task: "Check every link" },
					],
				},
				agents: ["GuideWriter", "LinkChecker"],
			},
			running,
		);
		await expect(page.getByRole("complementary", { name: "Work board" })).toBeVisible({ timeout: 15_000 });

		await recorder.reset();
		await recorder.attach(page);
		await page.waitForTimeout(3_200);
		// Two sessions onto the workspace: a split of three panes.
		await dragOnto(page, "Saved addresses", page.locator(".omp-split-workspace"), 0.92, 0.5, "right");
		await expect(page.locator(".omp-session-pane")).toHaveCount(2);
		await page.waitForTimeout(1_800);
		await dragOnto(page, "Flaky tests", page.locator("[data-split]").first(), 0.5, 0.92, "bottom");
		await expect(page.locator(".omp-session-pane")).toHaveCount(3);
		await page.waitForTimeout(1_600);
		// The running session keeps working in its pane.
		await flow(page, { op: "end", id: "agents", text: "Both agents finished." }, running);
		await page.waitForTimeout(900);
		await flow(page, { op: "reply", text: "The guide is rewritten and every link resolves." }, running);
		await page.waitForTimeout(2_800);
		await recorder.finish({ width: 1600 });
	} finally {
		await recorder.detach();
		await exitApp(app);
		await cleanup(profile);
	}
});
