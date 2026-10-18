import { expect, test } from "@playwright/test";
import { cleanupAp, git, launchAp, mainTab, makeApProfile, tabIds, waitForStatus } from "./autopilot-harness";
import { exitApp, readRecords } from "./harness";

// `ompdesk_autopilot` (src/main/agent-control): the main agent starts an Autopilot run on the fake omp
// (`fixture/autopilot.ts` emulates the cycles), reads its status and stops it. The fake omp calls the host tool with
// `fixture:host-tool:<name> <json>`. The run goes through `Autopilot.handleCommand`, the same path as the sheet's Start.

async function callTool(
	page: import("@playwright/test").Page,
	record: string,
	tabId: string,
	args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
	const read = async () =>
		(await readRecords(record))
			.filter(frame => frame.type === "host_tool_result" && frame.recordedBy !== undefined)
			.map(frame => {
				const result = frame.result as { content?: { text?: string }[] } | undefined;
				return { text: result?.content?.[0]?.text ?? "", isError: frame.isError === true };
			});
	const before = (await read()).length;
	const response = await page.evaluate(
		([id, command]) => window.omp.rpc.commandForTab(id, { type: "bash", command }),
		[tabId, `fixture:host-tool:ompdesk_autopilot ${JSON.stringify(args)}`] as const,
	);
	expect(response).toMatchObject({ success: true });
	await expect.poll(async () => (await read()).length, { timeout: 90_000 }).toBe(before + 1);
	return (await read())[before] as { text: string; isError: boolean };
}

test("an agent starts an Autopilot run, reads its status and ends it", async () => {
	test.setTimeout(180_000);
	const profile = await makeApProfile({
		script: { cycleMs: 500 },
		prefs: { agentControlManage: true },
	});
	const { app, page } = await launchAp(profile);
	try {
		const main = await mainTab(page);
		const before = await tabIds(page);
		const started = await callTool(page, profile.record, main, { action: "start", ship: "commit" });
		expect(started.isError, started.text).toBe(false);
		const runId = /Started Autopilot in session (\w+)/.exec(started.text)?.[1] ?? "";
		expect(runId).not.toBe("");
		expect(before).not.toContain(runId);
		expect(await tabIds(page)).toContain(runId);
		expect(git(profile.project, "branch", "--show-current")).toBe("main");

		const run = await waitForStatus(page, runId, s => (s.cycles?.length ?? 0) >= 1, "one cycle");
		expect(run.branch).toMatch(/^autopilot\//);

		const status = await callTool(page, profile.record, main, { action: "status", session: runId });
		expect(status.isError, status.text).toBe(false);
		expect(status.text).toContain(`Autopilot run ${runId}`);
		expect(status.text).toMatch(/cycle \d/);
		expect(status.text).toContain("ship level commit");
		expect(status.text).toMatch(/last commit \w{7,}/);

		const stopped = await callTool(page, profile.record, main, { action: "stop", session: runId });
		expect(stopped.isError, stopped.text).toBe(false);
		expect(stopped.text).toContain("Ending");
		await waitForStatus(page, runId, s => s.state === "ended", "the run ended");
		const after = await callTool(page, profile.record, main, { action: "status", session: runId });
		expect(after.text).toMatch(/ended/);
	} finally {
		await exitApp(app);
		await cleanupAp(profile);
	}
});
