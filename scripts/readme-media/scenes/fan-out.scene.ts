/**
 * Fan-out → compare → merge: the main agent opens three worktree sessions with the OMPdesk control tools, each child
 * commits its approach, the work board's Child sessions section lists them, and the agent compares the branches,
 * merges the winner itself (`ompdesk_merge`: a merge commit in the checkout, nothing pushed) and closes one it
 * rejected (`ompdesk_session_stop`). Git is real, in the temp repository; the children's commits are made by the script,
 * standing in for what a real child does (as in `e2e/agent-review.e2e.ts`).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { exitApp, readRecords } from "../../../e2e/harness";
import { cleanup, fixture, flow, git, launch, makeProfile, Recorder, tabs, typePrompt } from "../lib";

const PROMPT = "Try three approaches to the checkout flow in parallel, then compare them.";
const APPROACHES = [
	{ key: "a", message: "Approach A: a single-page checkout" },
	{ key: "b", message: "Approach B: a stepper with saved progress" },
	{ key: "c", message: "Approach C: express checkout with a wallet" },
] as const;

test("fan-out, compare, merge", async () => {
	const profile = await makeProfile({ name: "fan-out" });
	const { app, page } = await launch(profile, 1440, 900);
	const recorder = new Recorder("fan-out", { width: 1440, height: 900, maxHold: 1_500, endHold: 2_500 });
	const results = async () =>
		(await readRecords(profile.record)).filter(frame => frame.type === "host_tool_result").length;
	/** The agent calls a control tool (its card in the transcript, the real tool run by the host). */
	const call = async (id: string, name: string, args: Record<string, unknown>, main: string) => {
		const before = await results();
		await flow(page, { op: "call", id, name, args }, main);
		await fixture(page, `fixture:host-tool:${name} ${JSON.stringify(args)}`, main);
		await expect.poll(results, { timeout: 90_000 }).toBe(before + 1);
	};
	try {
		const main = (await tabs(page)).find(tab => tab.active)?.tabId ?? "";
		await recorder.reset();
		await recorder.attach(page);
		await page.waitForTimeout(900);
		await typePrompt(page, PROMPT);
		await expect(page.locator("[data-transcript-kind]").first()).toBeVisible({ timeout: 30_000 });
		await expect(async () =>
			flow(
				page,
				{
					op: "call",
					id: "open",
					name: "ompdesk_session_open",
					args: { sessions: APPROACHES.map(a => ({ message: a.message, worktree: true })) },
				},
				main,
			),
		).toPass({ timeout: 15_000 });
		await fixture(page, "fixture:title:Checkout flow", main);
		await fixture(
			page,
			`fixture:host-tool:ompdesk_session_open ${JSON.stringify({ sessions: APPROACHES.map(a => ({ message: a.message, worktree: true })) })}`,
			main,
		);
		let children: { tabId: string; path: string; branch: string }[] = [];
		await expect
			.poll(async () => {
				children = (await tabs(page))
					.filter(tab => tab.tabId !== main && tab.worktree)
					.map(tab => ({ tabId: tab.tabId, path: tab.worktree?.path ?? "", branch: tab.worktree?.branch ?? "" }));
				return children.length;
			})
			.toBe(3);
		await flow(page, { op: "end", id: "open", text: "Opened 3 sessions, each in its own worktree." }, main);
		await page.waitForTimeout(1_600);

		// The children finish; their commits land in their own checkouts.
		for (const [index, child] of children.entries()) {
			const approach = APPROACHES[index];
			if (!approach) continue;
			await fixture(page, `fixture:title:Approach ${approach.key.toUpperCase()}`, child.tabId);
			await expect(async () => flow(page, { op: "reply", text: `${approach.message}: done.` }, child.tabId)).toPass({
				timeout: 20_000,
			});
			const file = `checkout-${approach.key}.ts`;
			await fs.writeFile(
				path.join(child.path, file),
				`export const checkout = "${approach.key}";\nexport const steps = ${index + 1};\n`,
			);
			git(child.path, "add", file);
			git(child.path, "commit", "-q", "-m", `Add checkout approach ${approach.key.toUpperCase()}`);
			await page.waitForTimeout(500);
		}
		await call(
			"result",
			"ompdesk_session_result",
			{ sessions: children.map(child => child.tabId), wait: true, timeout_seconds: 90 },
			main,
		);
		await flow(page, { op: "end", id: "result", text: "All three sessions finished." }, main);
		await call("compare", "ompdesk_compare", {}, main);
		await flow(
			page,
			{ op: "end", id: "compare", text: "Three branches, one commit each. Compare runs no tests." },
			main,
		);
		const opened = page.locator("[data-work-board-panel] [data-board-opened]");
		await expect(opened).toHaveCount(3, { timeout: 30_000 });
		await page.waitForTimeout(2_400);

		// The agent lands the winner itself and closes the approach it rejected.
		const first = children[0];
		const third = children[2];
		if (!first || !third) throw new Error("expected three children");
		await call("merge", "ompdesk_merge", { session: first.tabId }, main);
		await flow(page, { op: "end", id: "merge", text: "Merged Approach A into main. Nothing was pushed." }, main);
		await page.waitForTimeout(1_800);
		await call("stop", "ompdesk_session_stop", { session: third.tabId, close: true }, main);
		await flow(page, { op: "end", id: "stop", text: "Closed Approach C." }, main);
		await flow(
			page,
			{
				op: "reply",
				text: "Approach A is merged into main (nothing was pushed). Approach B stays open for another look; C is closed.",
			},
			main,
		);
		await expect(page.getByText("Approach A is merged into main")).toBeVisible();
		await page.waitForTimeout(2_500);
		await recorder.finish({ width: 1600 });
	} finally {
		await recorder.detach();
		await exitApp(app);
		await cleanup(profile);
	}
});
