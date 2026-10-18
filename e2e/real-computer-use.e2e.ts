import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import { exitApp } from "./harness";
import { field, realOmpProfile } from "./real-omp";

// Explicit opt-in: spends a few small-model turns in a private disposable profile. OMPdesk holds
// `computer.enabled` on (GUI_THINKING_DEFAULTS), so a session can call the `computer` eval prelude.
// NOTHING here clicks or types on the desktop: the read-only turn runs `computer.capabilities()` only, and
// the input turn runs under `tools.approvalMode: always-ask`, where the approval card is the assertion and
// it is DENIED, so the input never executes. Under stock's default (yolo) the same input would run unattended.
// A second session reads at the same time (`computer.capabilities()` only) to show read-only runs never queue.
const APPROVE = /^(Approve|승인)$/;
const DENY = /^(Deny|거부)$/;

test("real omp: computer prelude reads without a card, and input asks (always-ask) and is denied", async () => {
	test.skip(process.env.OMP_GUI_REAL_WORK !== "1", "Opt-in model audit");
	test.setTimeout(420_000);
	const { project, desktop, env, smol } = await realOmpProfile();
	const app = await electron.launch({
		args: [
			path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"),
			project,
			`--user-data-dir=${desktop}`,
		],
		env,
	});
	try {
		const page = await app.firstWindow();
		await expect
			.poll(() => page.evaluate(() => window.omp.sidecar.getStatus()), { timeout: 60_000 })
			.toMatchObject({ status: "ready" });
		const [provider, ...modelId] = smol.split("/");
		const switched = await page.evaluate(([p, m]) => window.omp.rpc.setModel(p, m), [
			provider ?? "",
			modelId.join("/"),
		] as const);
		expect(switched.success, JSON.stringify(switched)).toBe(true);
		// The held default resolves true at runtime.
		const got = await page.evaluate(() => window.omp.rpc.getSettings(["computer.enabled"]));
		expect(JSON.stringify(got)).toContain('"computer.enabled":true');

		await page.evaluate(() => {
			const ends: string[] = [];
			Object.assign(window, { __turnEnds: ends });
			window.omp.events.onTabBatch(events => {
				for (const event of events) if (event.type === "agent_end") ends.push(event.type);
			});
		});
		const ends = () => page.evaluate(() => (Reflect.get(window, "__turnEnds") as string[]).length);
		const input = page.locator("textarea").first();

		// 1. Read-only under the default approval mode: no card may ever show.
		let approvalSeen = false;
		const watch = setInterval(() => {
			void page
				.getByRole("button", { name: APPROVE })
				.count()
				.then(count => {
					if (count > 0) approvalSeen = true;
				})
				.catch(() => undefined);
		}, 200);
		await input.fill(
			"Use the eval tool once to run `return await computer.capabilities()` (read-only, no clicks or typing) and then say DONE.",
		);
		await input.press("Enter");
		await expect.poll(ends, { timeout: 180_000 }).toBeGreaterThan(0);
		clearInterval(watch);
		expect(approvalSeen, "a read-only computer call shows no approval card").toBe(false);

		// 1b. Two sessions reading the desktop at once (still only `computer.capabilities()`): a read-only run never
		// takes the desktop slot, so neither session waits and the screen indicator never shows.
		const tabList = () => page.evaluate(() => window.omp.tabs.list());
		const first = (await tabList())[0]?.tabId ?? "";
		await page.keyboard.press("ControlOrMeta+t");
		await expect.poll(async () => (await tabList()).length, { timeout: 30_000 }).toBe(2);
		const second = (await tabList()).find(tab => tab.tabId !== first)?.tabId ?? "";
		await expect
			.poll(async () => (await tabList()).find(tab => tab.tabId === second)?.status, { timeout: 60_000 })
			.toBe("ready");
		const slotSeen: string[] = [];
		const slotWatch = setInterval(() => {
			void page
				.evaluate(async () => {
					const slot = await window.omp.rpc.getDesktopSlot();
					return {
						shown:
							document.querySelector("[data-desktop-slot-indicator]") !== null ||
							document.querySelector("[data-desktop-slot-waiting]") !== null,
						state: slot.success ? JSON.stringify(slot.data) : "",
					};
				})
				.then(seen => {
					if (seen.shown) slotSeen.push("indicator or waiting card");
					if (seen.state && seen.state !== '{"holder":null,"queue":[]}') slotSeen.push(seen.state);
				})
				.catch(() => undefined);
		}, 100);
		const readOnly = (token: string) =>
			`Use the eval tool once to run \`return await computer.capabilities()\` (read-only, no clicks or typing) and then say ${token}.`;
		const sent = await page.evaluate(
			([id, message]) => window.omp.rpc.commandForTab(id, { type: "prompt", message }),
			[first, readOnly("READ-ONLY-A")] as const,
		);
		expect(sent.success, JSON.stringify(sent)).toBe(true);
		await input.fill(readOnly("READ-ONLY-B"));
		await input.press("Enter");
		for (const [tab, token] of [
			[first, "READ-ONLY-A"],
			[second, "READ-ONLY-B"],
		] as const) {
			await expect
				.poll(
					async () => {
						const last = await page.evaluate(
							id => window.omp.rpc.commandForTab(id, { type: "get_last_assistant_text" }),
							tab,
						);
						return String(field(last.data, "text") ?? "");
					},
					{ timeout: 180_000 },
				)
				.toContain(token);
		}
		clearInterval(slotWatch);
		expect(slotSeen, "read-only runs of two sessions never wait for or show the desktop slot").toEqual([]);
		// The input turn below runs in the session in front (the second one): always-ask applies to it as to any.

		// 2. Input under always-ask: a card appears; deny it. Nothing is executed.
		const set = await page.evaluate(() => window.omp.rpc.setSetting("tools.approvalMode", "always-ask"));
		expect(set.success, JSON.stringify(set)).toBe(true);
		const before = await ends();
		await input.fill(
			"Use the eval tool once to run `const w = await computer.focusedWindow(); await w.press('shift')` and then say DONE. If it is refused, stop and say REFUSED.",
		);
		await input.press("Enter");
		await expect(page.getByRole("button", { name: APPROVE }).first()).toBeVisible({ timeout: 120_000 });
		await page.getByRole("button", { name: DENY }).first().click();
		await expect.poll(ends, { timeout: 180_000 }).toBeGreaterThan(before);
	} finally {
		await exitApp(app);
	}
});
