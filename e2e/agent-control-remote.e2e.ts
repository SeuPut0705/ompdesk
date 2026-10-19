import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { controlToolCaller, exitApp, readRecords } from "./harness";
import { connectHost, launchRemote, makeRemoteProfile, type RemoteInstance } from "./remote-harness";

// OMPdesk control tools on a paired device's sessions (src/main/agent-control, src/main/remote/hosted-autopilot.ts):
// an agent on A starts an Autopilot run in a repository on B. B's own coordinator runs it (its worktree, its fake
// omp's cycles); A shows the run as a view of B's run session, reads its status and ends it. Then an agent whose
// session runs on B changes a setting of B's own machine services (`ompdesk_app` account rotation) and A's stays. The
// rules behind each step are unit-tested in service.test.ts, host.test.ts, host-services.test.ts,
// hosted-autopilot.test.ts and app-control.test.ts.

function git(cwd: string, ...args: string[]): string {
	return execFileSync(
		"git",
		["-c", "user.name=Seed", "-c", "user.email=seed@example.invalid", "-c", "commit.gpgsign=false", ...args],
		{ cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	).trim();
}

let parent: string;
let host: RemoteInstance | undefined;
let client: RemoteInstance | undefined;

test.beforeEach(async () => {
	parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-agent-remote-")));
});

test.afterEach(async () => {
	for (const instance of [client, host]) if (instance) await exitApp(instance.app);
	for (const instance of [client, host]) expect(instance?.errors ?? []).toEqual([]);
	await fs.rm(parent, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("runs Autopilot in a paired device's repository and changes that device's settings from a session there", async () => {
	test.setTimeout(300_000);
	const worktrees = path.join(parent, "wt");
	const hostProfile = await makeRemoteProfile(parent, "host", {
		language: "en",
		theme: "light",
		env: {
			OMP_GUI_TEST_AUTOPILOT: JSON.stringify({ cycleMs: 500 }),
			OMP_WORKTREE_DIR: worktrees,
			GIT_AUTHOR_NAME: "Seed",
			GIT_AUTHOR_EMAIL: "seed@example.invalid",
			GIT_COMMITTER_NAME: "Seed",
			GIT_COMMITTER_EMAIL: "seed@example.invalid",
		},
	});
	const repo = hostProfile.project;
	const bare = path.join(parent, "remote.git");
	await fs.mkdir(bare);
	git(bare, "init", "-q", "--bare", "-b", "main");
	git(repo, "init", "-q", "-b", "main");
	await fs.writeFile(path.join(repo, "index.ts"), "export const answer = 41;\n");
	await fs.writeFile(path.join(repo, "AGENTS.md"), "# Project rules\n\nKeep changes small.\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", "seed");
	git(repo, "remote", "add", "origin", bare);
	git(repo, "push", "-q", "origin", "main");
	const clientProfile = await makeRemoteProfile(parent, "client", {
		language: "en",
		theme: "light",
		port: hostProfile.port,
		prefs: { batchNotifications: false, agentControlManage: true },
	});
	host = await launchRemote(hostProfile);
	client = await launchRemote(clientProfile);
	const deviceId = await connectHost(host.page, client.page, "PC-B");
	await expect
		.poll(async () => (await client?.page.evaluate(() => window.omp.remote.getState()))?.hosts[0]?.state, {
			timeout: 30_000,
		})
		.toBe("online");
	const call = await controlToolCaller(client.page, clientProfile.record);

	// Nothing on B has the repository open from A: a session there to start from is opened and closed again.
	const started = await call("ompdesk_autopilot", { action: "start", device: "PC-B", folder: repo, ship: "commit" });
	expect(started.isError, started.text).toBe(false);
	expect(started.text).toContain("it runs on PC-B");
	const runId = /Started Autopilot in session (\w+)/.exec(started.text)?.[1] ?? "";
	expect(runId).not.toBe("");
	const deviceTabs = (await client.page.evaluate(() => window.omp.tabs.list())).filter(tab => tab.device === deviceId);
	expect(deviceTabs.map(tab => tab.tabId)).toEqual([runId]);
	// The run is B's: B's window has its tab in a new worktree, B's checkout stays on main, B's omp ran the cycles.
	expect(git(repo, "branch", "--show-current")).toBe("main");
	await expect
		.poll(async () =>
			(await host?.page.evaluate(() => window.omp.tabs.list()))?.some(tab => tab.cwd.startsWith(worktrees)),
		)
		.toBe(true);
	const autopilotFrames = (records: Record<string, unknown>[]) =>
		records.filter(frame => String(frame.type).startsWith("fixture_autopilot")).length;

	let status = "";
	await expect
		.poll(
			async () => {
				status = (await call("ompdesk_autopilot", { action: "status", session: runId })).text;
				return status;
			},
			{ timeout: 90_000 },
		)
		.toMatch(/last commit \w{7,}/);
	expect(status).toContain(`Autopilot run ${runId}`);
	expect(status).toContain("ship level commit");
	expect(git(repo, "branch", "--list", "autopilot/*")).toMatch(/autopilot\//);
	expect(autopilotFrames(await readRecords(hostProfile.record))).toBeGreaterThan(0);
	expect(autopilotFrames(await readRecords(clientProfile.record))).toBe(0);

	const stopped = await call("ompdesk_autopilot", { action: "stop", session: runId });
	expect(stopped.isError, stopped.text).toBe(false);
	expect(stopped.text).toContain("Ending");
	await expect
		.poll(async () => (await call("ompdesk_autopilot", { action: "status", session: runId })).text, {
			timeout: 90_000,
		})
		.toMatch(/: ended/);

	// A session of A's that runs on B: its agent's ompdesk_app reaches B's account rotation, not A's.
	const before = await client.page.evaluate(() => window.omp.accountRotation.get());
	const spawned = await client.page.evaluate(([cwd, device]) => window.omp.tabs.spawn({ cwd, device }), [
		repo,
		deviceId,
	] as const);
	const onHost = spawned?.tabId ?? "";
	expect(onHost).not.toBe("");
	await expect
		.poll(
			async () =>
				(await client?.page.evaluate(() => window.omp.tabs.list()))?.find(tab => tab.tabId === onHost)?.status,
			{
				timeout: 60_000,
			},
		)
		.toBe("ready");
	const there = await controlToolCaller(client.page, hostProfile.record, onHost);
	const changed = await there("ompdesk_app", { action: "settings.rotation", args: { value: "even" } });
	expect(changed.isError, changed.text).toBe(false);
	expect(changed.text).toContain("Account rotation is now even.");
	expect((await host.page.evaluate(() => window.omp.accountRotation.get())).mode).toBe("even");
	expect((await client.page.evaluate(() => window.omp.accountRotation.get())).mode).toBe(before.mode);
});
