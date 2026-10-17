/**
 * Autopilot's stop rules on the fake omp: red x3, no report x2, compaction churn, the 8 s stall, a hard-ban
 * violation caught by the tool guard and (for what the guard cannot see) by the git audit, and the optional
 * budgets, which also count the children's usage; with budgets off nothing stops the run. Every pause is
 * "after the cycle that tripped it": the cycle is recorded, no further cycle starts.
 */
import { expect, type Page, test } from "@playwright/test";
import type { AutopilotStatus } from "../resources/gui-bridge/modes/autopilot-contracts";
import {
	type ApProfile,
	type ApProfileOptions,
	agentTools,
	cleanupAp,
	launchAp,
	mainTab,
	makeApProfile,
	recorded,
	refs,
	settledStatus,
	startFromSheet,
	startRun,
	status,
	waitForStatus,
} from "./autopilot-harness";
import { exitApp } from "./harness";

interface PausedRun {
	profile: ApProfile;
	page: Page;
	tabId: string;
	paused: AutopilotStatus;
}

/** Run a profile until the run pauses, hand it to `check`, and always tear the app down. */
async function withPaused(
	options: ApProfileOptions,
	start: Record<string, unknown> & { ui?: boolean },
	check: (run: PausedRun) => Promise<void>,
	timeout = 90_000,
): Promise<void> {
	const profile = await makeApProfile(options);
	const { app, page } = await launchAp(profile);
	try {
		const tabId = start.ui
			? (await startFromSheet(page, "en")).tabId
			: await startRun(page, await mainTab(page), start);
		await waitForStatus(page, tabId, s => s.state === "paused", "the run pauses", timeout);
		// Stock admits the next turn before main's pause arrives (the same race on the real omp): that turn finishes.
		const paused = await settledStatus(page, tabId);
		await check({ profile, page, tabId, paused });
	} finally {
		await exitApp(app);
		await cleanupAp(profile);
	}
}

test("three red cycles in a row pause the run as tests_failing; the next cycle never starts", async () => {
	test.setTimeout(150_000);
	await withPaused({ script: { cycleMs: 300, verify: ["red", "red", "red", "green"] } }, {}, async run => {
		expect(run.paused.reason).toBe("tests_failing");
		expect(run.paused.cycles?.slice(0, 3).map(cycle => cycle.verify)).toEqual(["red", "red", "red"]);
		expect(run.paused.cycles?.length).toBeLessThanOrEqual(4);
		expect((await recorded(run.profile, "goal")).map(entry => entry.op)).toContain("pause");
	});
});

test("two cycles without an end report pause the run as no_report", async () => {
	test.setTimeout(150_000);
	await withPaused({ script: { cycleMs: 300, verify: ["none"] } }, {}, async run => {
		expect(run.paused.reason).toBe("no_report");
		expect(run.paused.cycles?.slice(0, 2).map(cycle => cycle.area)).toEqual(["unreported", "unreported"]);
		expect(run.paused.cycles?.length).toBeLessThanOrEqual(3);
	});
});

test("a cycle that compacts twice pauses the run as context_churn", async () => {
	test.setTimeout(150_000);
	await withPaused({ script: { cycleMs: 300, cycle: { compactions: 2 } } }, {}, async run => {
		expect(run.paused.reason).toBe("context_churn");
		expect(run.paused.cycles?.[0]?.compactions).toBe(2);
		expect(run.paused.cycles?.length).toBeLessThanOrEqual(2);
	});
});

test("no new turn within 8 s of a cycle's end pauses the run (stall), and the screen says why", async () => {
	test.setTimeout(150_000);
	await withPaused({ script: { cycleMs: 300, cycles: { "2": { noContinue: true } } } }, { ui: true }, async run => {
		expect(run.paused.reason).toBe("no_progress");
		expect(run.paused.cycles?.length).toBe(2);
		await run.page.locator("[data-autopilot-chip-open]").click();
		await expect(run.page.locator("[data-autopilot-reason]")).toHaveAttribute("data-autopilot-reason", "no_progress");
		// Resume goes on with cycle 3.
		await run.page.locator("[data-autopilot-resume]").click();
		await waitForStatus(run.page, run.tabId, s => (s.cycles?.length ?? 0) >= 3, "cycle 3 after the resume");
	});
});

test("a hard-banned command is blocked by the guard before it runs: the remote does not move and the run goes on", async () => {
	test.setTimeout(150_000);
	const profile = await makeApProfile({
		script: {
			cycleMs: 300,
			cycles: {
				"1": {
					tools: [
						{ tool: "bash", input: { command: "git push origin HEAD" } },
						{ tool: "bash", input: { command: "git push --force origin HEAD:main" } },
						{ tool: "bash", input: { command: "git reset --hard HEAD~1" } },
						{ tool: "write", input: { path: "/tmp/outside-the-worktree.txt", content: "x" } },
					],
				},
			},
		},
	});
	const before = refs(profile.remote, "refs/heads");
	const { app, page } = await launchAp(profile);
	try {
		const tabId = await startRun(page, await mainTab(page));
		await waitForStatus(page, tabId, s => (s.cycles?.length ?? 0) >= 2, "two cycles");
		const tools = (await agentTools(profile)).filter(entry => entry.tool === "bash" || entry.tool === "write");
		expect(tools.map(entry => typeof entry.blocked)).toEqual(["string", "string", "string", "string"]);
		expect(String(tools[0]?.blocked)).toMatch(/Blocked by autopilot/);
		expect(refs(profile.remote, "refs/heads")).toBe(before);
		expect((await status(page, tabId)).state).toBe("running");
	} finally {
		await exitApp(app);
		await cleanupAp(profile);
	}
});

test("a ban the guard cannot see (an obfuscated tag) is caught by the audit: paused as ban_violation", async () => {
	test.setTimeout(150_000);
	await withPaused(
		{
			script: {
				cycleMs: 300,
				cycles: { "1": { tools: [{ tool: "bash", input: { command: "git tag stray-tag" }, raw: true }] } },
			},
		},
		{},
		async run => {
			expect(run.paused.reason).toBe("ban_violation");
			expect(run.paused.detail ?? "").toContain("refs/tags/stray-tag");
		},
	);
});

test("a push the guard cannot see is caught by the audit too", async () => {
	test.setTimeout(150_000);
	await withPaused(
		{
			script: {
				cycleMs: 300,
				cycles: {
					"1": {
						tools: [{ tool: "bash", input: { command: "git push -q origin HEAD:refs/heads/rogue" }, raw: true }],
					},
				},
			},
		},
		{},
		async run => {
			expect(run.paused.reason).toBe("ban_violation");
			expect(run.paused.detail ?? "").toContain("refs/remotes/origin/rogue");
		},
	);
});

test("with the token budget on, the children's usage counts toward it; the run pauses as budget", async () => {
	test.setTimeout(180_000);
	await withPaused(
		{ script: { cycleMs: 500, childMs: 500, childTokens: 600, cycle: { children: 1, tokens: 1_000 } } },
		{ maxParallel: 1, limits: { tokens: 2_500 } },
		async run => {
			expect(run.paused.reason).toBe("budget");
			// Parent 1 000 + child 600 in cycle 1, then 1 000 in cycle 2: 2 600 >= 2 500 only with the children counted.
			expect(run.paused.cycles?.length).toBeGreaterThanOrEqual(2);
			expect(run.paused.cycles?.length).toBeLessThanOrEqual(3);
			expect(run.paused.cycles?.[0]?.tokens).toBe(1_600);
		},
		150_000,
	);
});

test("with the cycle budget on, the run pauses after that many cycles", async () => {
	test.setTimeout(150_000);
	await withPaused({ script: { cycleMs: 300 } }, { limits: { cycles: 2 } }, async run => {
		expect(run.paused.reason).toBe("cycles");
		expect(run.paused.cycles?.length).toBeGreaterThanOrEqual(2);
		expect(run.paused.cycles?.length).toBeLessThanOrEqual(3);
	});
});

test("with every budget off nothing stops a healthy run", async () => {
	test.setTimeout(150_000);
	const profile = await makeApProfile({ script: { cycleMs: 250, cycle: { tokens: 50_000, usd: 5 } } });
	const { app, page } = await launchAp(profile);
	try {
		const tabId = await startRun(page, await mainTab(page));
		const run = await waitForStatus(page, tabId, s => (s.cycles?.length ?? 0) >= 6, "six cycles", 120_000);
		expect(run.state).toBe("running");
		expect(run.settings?.limits).toEqual({ tokens: null, minutes: null, cycles: null, usd: null });
		expect(run.totals?.tokens).toBeGreaterThanOrEqual(300_000);
	} finally {
		await exitApp(app);
		await cleanupAp(profile);
	}
});
