import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron, type Page } from "playwright";
import type { AutopilotStatus } from "../resources/gui-bridge/modes/autopilot-contracts";
import {
	command,
	crash,
	git,
	mainTab,
	markers,
	refs,
	setAutopilot,
	startRun,
	status,
	waitForRunTab,
	waitForStatus,
} from "./autopilot-harness";
import { exitApp } from "./harness";
import { survivors } from "./process-tree";
import { field, realOmpProfile, spentIn } from "./real-omp";

// Explicit opt-in (OMP_GUI_REAL_WORK=1): these audits spend model tokens on the user's `smol` role in a private
// disposable agent dir (config.yml and agent.db copied, 0700), a temp git repository and a local bare remote.
// Ordinary runs never call a model. Fan-out and the release need the fake omp.
//
// 1. Two cycles, then one push-level cycle. What it proves on the real omp 18.x: the run opens a new worktree tab on
//    autopilot/<date>; each turn is one cycle the journal records; the protocol section and the `autopilot` tool are
//    active (the agent begins and ends cycles); the tool guard really blocks a hard-banned command the agent is asked
//    to run; nothing reaches the remote while "local only"; Stop ends the run after the cycle in flight with no
//    further turn; no approval card ever shows. A second run on the push level pushes only its own autopilot branch
//    and leaves main alone.
// 2. The permission lifecycle, read from the run tab's own omp: while armed, stock `tools.approvalMode` is `yolo` as
//    a runtime override (config.yml untouched) and the active tools lack ask/eval/debug and hold `autopilot`; once a
//    stopped run has ended, both are what a fresh session in the same folder has. The same holds for a run killed
//    mid-cycle (SIGKILL) and resumed by the relaunch.
const APPROVE = /^(Approve|승인)$/;

/** The real-omp profile with a seeded repository (a bug and a TODO for the agent), a local bare remote and prefs. */
async function seededProfile() {
	const real = await realOmpProfile();
	const { profile, project, desktop } = real;
	const remote = path.join(profile, "remote.git");
	await fs.mkdir(remote);
	git(remote, "init", "-q", "--bare", "-b", "main");
	git(project, "symbolic-ref", "HEAD", "refs/heads/main");
	git(project, "config", "user.name", "Autopilot Audit");
	git(project, "config", "user.email", "audit@example.invalid");
	await fs.writeFile(
		path.join(project, "math.ts"),
		"export function add(a: number, b: number): number {\n\treturn a - b;\n}\n\n// TODO: export a clamp(value, min, max) helper\n",
	);
	await fs.writeFile(
		path.join(project, "math.test.ts"),
		'import { expect, test } from "bun:test";\nimport { add } from "./math";\n\ntest("add adds", () => {\n\texpect(add(2, 3)).toBe(5);\n});\n',
	);
	await fs.writeFile(
		path.join(project, "AGENTS.md"),
		"# Rules\n\nThe per-change check is `bun test`. Keep commits small. Commit message style: one short imperative line.\n",
	);
	git(project, "add", "-A");
	git(project, "commit", "-q", "-m", "seed");
	git(project, "remote", "add", "origin", remote);
	git(project, "push", "-q", "origin", "main");
	// Rules files stay loaded (the protocol defers to them); the user's extensions and skills stay off.
	await fs.writeFile(
		path.join(desktop, "prefs.json"),
		JSON.stringify({
			language: "en",
			firstRunComplete: true,
			lastProject: project,
			launchProfiles: { [project]: { noExtensions: true, noSkills: true } },
		}),
	);
	return { ...real, remote };
}

/** Launch on the profile's userData; without `project` the saved layout (the run's tab) is restored. */
async function launch(desktop: string, env: Record<string, string>, project?: string) {
	const app = await electron.launch({
		args: [
			path.resolve(process.env.OMP_GUI_E2E_OUT ?? "out", "main/index.js"),
			...(project ? [project] : []),
			`--user-data-dir=${desktop}`,
		],
		env,
	});
	const page = await app.firstWindow();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
	await page.waitForFunction(() => window.omp?.rpc != null);
	return { app, page };
}

test("real omp autopilot: two cycles in a new worktree, guarded, local only, then a push-level cycle", async () => {
	test.skip(process.env.OMP_GUI_REAL_WORK !== "1", "Opt-in model audit");
	test.setTimeout(2_400_000);
	const evidenceDir = process.env.OMP_GUI_REAL_WORK_ARTIFACTS ?? path.join(os.tmpdir(), "ompdesk-real-autopilot");
	await fs.mkdir(evidenceDir, { recursive: true });
	const { profile, project, desktop, env, remote } = await seededProfile();
	const remoteBefore = refs(remote, "refs/heads");
	const { app, page } = await launch(desktop, env, project);
	const evidence: Record<string, unknown> = { remoteBefore };
	try {
		await expect
			.poll(() => page.evaluate(() => window.omp.sidecar.getStatus()), { timeout: 60_000 })
			.toMatchObject({ status: "ready" });
		let approvalSeen = false;
		const watchApprovals = async () => {
			if ((await page.getByRole("button", { name: APPROVE }).count()) > 0) approvalSeen = true;
		};
		const origin = await mainTab(page);

		// Run 1: "local only" (Automatic would push the run's own branch: the repository has a remote). Cycle 1 also
		// gets a user instruction the guard must stop. The ceilings bound what an audit can spend if Stop never lands.
		const first = await startRun(page, origin, {
			preset: "local",
			limits: { usd: 2, minutes: 20 },
			maxParallel: 0,
		});
		const tab = await waitForRunTab(page);
		expect(tab.tabId).toBe(first);
		expect(tab.branch).toMatch(/^autopilot\/\d{4}-\d{2}-\d{2}/);
		expect(git(tab.cwd, "branch", "--show-current")).toBe(tab.branch);
		evidence.worktree = tab.cwd;
		const running = await waitForStatus(page, first, s => s.now?.n === 1, "cycle 1 starts", 180_000);
		expect(running.settings?.ship).toMatchObject({ autoPush: false, autoRelease: { on: false } });
		const steer = await command(page, first, {
			type: "steer",
			message:
				"Before anything else, run the bash command `git tag autopilot-probe` exactly once and tell me the result in your cycle summary.",
		});
		expect(steer.success).toBe(true);

		// Stop during cycle 2: it finishes, nothing starts after it.
		let stopped = false;
		const deadline = Date.now() + 1_500_000;
		let snapshot: AutopilotStatus = running;
		while (Date.now() < deadline) {
			await watchApprovals();
			snapshot = await status(page, first);
			if (!stopped && snapshot.now?.n === 2) {
				const stop = await setAutopilot(page, first, { action: "stop" });
				expect(stop.success).toBe(true);
				stopped = true;
			}
			if (snapshot.state === "ended" || snapshot.state === "paused") break;
			await page.waitForTimeout(2_000);
		}
		expect(stopped, "cycle 2 started in time").toBe(true);
		expect(snapshot.state, JSON.stringify(snapshot.cycles?.map(cycle => cycle.title))).toBe("ended");
		expect(snapshot.reason).toBe("user");
		expect(snapshot.cycles?.length).toBe(2);
		evidence.run1 = {
			cycles: snapshot.cycles?.map(cycle => ({
				n: cycle.n,
				area: cycle.area,
				title: cycle.title,
				verify: cycle.verify,
				commit: cycle.commit,
			})),
			totals: snapshot.totals,
		};
		await page.waitForTimeout(20_000);
		expect((await status(page, first)).cycles?.length, "no third turn after Stop").toBe(2);

		// Commits exist on the autopilot branch; the remote is where it was while "local only".
		const commits = git(tab.cwd, "log", "--format=%s", "main..HEAD");
		evidence.run1Commits = commits;
		expect(commits.length).toBeGreaterThan(0);
		expect(refs(remote, "refs/heads")).toBe(remoteBefore);
		expect(git(remote, "for-each-ref", "refs/tags")).toBe("");
		expect(git(project, "branch", "--show-current")).toBe("main");

		// The journal holds both cycles; the tool and section were active (the agent began and ended cycles); the guard blocked the tag.
		const session = (await page.evaluate(() => window.omp.tabs.list())).find(row => row.tabId === first)?.sessionPath;
		if (!session) throw new Error("The run's tab has no session file");
		const journal = await fs.readFile(session, "utf8");
		await fs.copyFile(session, path.join(evidenceDir, "run1-session.jsonl"));
		const cycleEntries = journal.split("\n").filter(line => line.includes('"customType":"ompdesk.autopilot-cycle"'));
		expect(cycleEntries.length).toBeGreaterThanOrEqual(2);
		expect(journal).toContain('"name":"autopilot"');
		expect(journal).toContain("Blocked by autopilot");
		expect(git(tab.cwd, "tag", "--list", "autopilot-probe")).toBe("");
		await watchApprovals();
		expect(approvalSeen, "an unattended run never shows an approval card").toBe(false);

		// Run 2: the push level, one cycle, from the user's own tab. Only the autopilot branch may reach the remote.
		const second = await startRun(page, origin, {
			preset: "push",
			limits: { cycles: 1, usd: 1, minutes: 10 },
			maxParallel: 0,
		});
		const run2Tab = await page.evaluate(
			id => window.omp.tabs.list().then(tabs => tabs.find(row => row.tabId === id)?.worktree?.branch),
			second,
		);
		expect(run2Tab).toMatch(/^autopilot\//);
		const paused = await waitForStatus(
			page,
			second,
			s => s.state === "paused" || s.state === "ended",
			"run 2 pauses",
			1_200_000,
		);
		expect(paused.reason).toBe("cycles");
		const green = paused.cycles?.[0]?.verify === "green";
		evidence.run2 = { cycle: paused.cycles?.[0], totals: paused.totals, green };
		await watchApprovals();
		const remoteBranches = git(remote, "for-each-ref", "--format=%(refname)", "refs/heads").split("\n").sort();
		const mainAfter = git(remote, "rev-parse", "refs/heads/main");
		expect(mainAfter).toBe(git(project, "rev-parse", "main"));
		expect(approvalSeen).toBe(false);
		if (green) {
			await expect
				.poll(() => git(remote, "for-each-ref", "--format=%(refname)", "refs/heads").split("\n").sort().length, {
					timeout: 60_000,
				})
				.toBe(2);
			const pushed = git(remote, "for-each-ref", "--format=%(refname)", "refs/heads").split("\n").sort();
			expect(
				pushed.filter(name => name !== "refs/heads/main").every(name => name.startsWith("refs/heads/autopilot/")),
			).toBe(true);
			evidence.pushedRefs = pushed;
		} else {
			// A cycle the agent did not call green is not pushed: the remote still has main only.
			expect(remoteBranches).toEqual(["refs/heads/main"]);
			evidence.pushedRefs = remoteBranches;
		}
		const costUsd = (snapshot.totals?.usd ?? 0) + (paused.totals?.usd ?? 0);
		evidence.cost = { usd: costUsd, tokens: (snapshot.totals?.tokens ?? 0) + (paused.totals?.tokens ?? 0) };
		await fs.writeFile(path.join(evidenceDir, "real-autopilot.json"), JSON.stringify(evidence, null, 2));
	} finally {
		await fs
			.writeFile(path.join(evidenceDir, "real-autopilot.json"), JSON.stringify(evidence, null, 2))
			.catch(() => undefined);
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

/** Tools an armed run never has (the bridge's `modes/autopilot.ts` EXCLUDED_TOOLS). */
const EXCLUDED = ["ask", "eval", "debug"];

interface Permissions {
	approval: unknown;
	layers: unknown;
	tools: string[];
}

/** What a tab's omp holds now: the effective `tools.approvalMode` with its settings layers, and the active tools. */
async function permissions(page: Page, tabId: string): Promise<Permissions> {
	const settings = await command(page, tabId, { type: "get_settings", paths: ["tools.approvalMode"] });
	const state = await command(page, tabId, { type: "get_state" });
	const dump = field(state.data, "dumpTools");
	return {
		approval: field(field(settings.data, "values"), "tools.approvalMode"),
		layers: field(field(field(settings.data, "provenance"), "tools.approvalMode"), "layers"),
		tools: (Array.isArray(dump) ? dump.map(tool => field(tool, "name")) : [])
			.filter((name): name is string => typeof name === "string")
			.sort(),
	};
}

function expectArmed(held: Permissions): void {
	expect(held.approval).toBe("yolo");
	expect(held.layers).toContain("runtime");
	expect(held.tools).toContain("autopilot");
	for (const name of EXCLUDED) expect(held.tools).not.toContain(name);
}

test("real omp autopilot: yolo and the tool set are held only while the run lives, across a SIGKILL too", async () => {
	test.skip(process.env.OMP_GUI_REAL_WORK !== "1", "Opt-in model audit");
	test.setTimeout(2_400_000);
	const evidenceDir = process.env.OMP_GUI_REAL_WORK_ARTIFACTS ?? path.join(os.tmpdir(), "ompdesk-real-autopilot");
	await fs.mkdir(evidenceDir, { recursive: true });
	const { profile, project, desktop, agent, env } = await seededProfile();
	const configPath = path.join(agent, "config.yml");
	const config = await fs.readFile(configPath, "utf8");
	let { app, page } = await launch(desktop, env, project);
	const evidence: Record<string, unknown> = {};
	const tabs = () => page.evaluate(() => window.omp.tabs.list());
	/** What a fresh session in `cwd` holds (same folder, launch profile and settings as the run's tab before arm). */
	const baselineIn = async (cwd: string): Promise<Permissions> => {
		const spawned = await page.evaluate(folder => window.omp.tabs.spawn({ kind: "agent", cwd: folder }), cwd);
		const id = spawned?.tabId ?? "";
		expect(id).not.toBe("");
		await expect
			.poll(async () => (await tabs()).find(tab => tab.tabId === id)?.status, { timeout: 120_000 })
			.toBe("ready");
		const held = await permissions(page, id);
		await page.evaluate(tabId => window.omp.tabs.close(tabId), id);
		return held;
	};
	const stopAndRestore = async (tabId: string, base: Permissions, label: string) => {
		expect(await setAutopilot(page, tabId, { action: "stop" })).toMatchObject({ success: true });
		const ended = await waitForStatus(page, tabId, s => s.state === "ended", `${label} ends`, 1_200_000);
		await expect.poll(() => permissions(page, tabId), { timeout: 120_000 }).toEqual(base);
		expect(await fs.readFile(configPath, "utf8")).toBe(config);
		return { reason: ended.reason, cycles: ended.cycles?.length, restored: await permissions(page, tabId) };
	};
	try {
		await expect
			.poll(() => page.evaluate(() => window.omp.sidecar.getStatus()), { timeout: 60_000 })
			.toMatchObject({ status: "ready" });
		const origin = await mainTab(page);

		// Run 1: armed while cycle 1 runs; Stop; once ended, the run's omp is back to the fresh session's values.
		const first = await startRun(page, origin, { maxParallel: 0 });
		const run1 = await waitForRunTab(page);
		await waitForStatus(page, first, s => s.now?.n === 1, "run 1 cycle 1 starts", 180_000);
		const armed1 = await permissions(page, first);
		expectArmed(armed1);
		expect(await fs.readFile(configPath, "utf8")).toBe(config);
		const base1 = await baselineIn(run1.cwd);
		evidence.run1 = { base: base1, armed: armed1, ...(await stopAndRestore(first, base1, "run 1")) };

		// Run 2: armed while cycle 1 runs, then SIGKILL; the relaunch resumes it armed; Stop; restored as in run 1.
		const second = await startRun(page, origin, { maxParallel: 0 });
		const run2 = (await tabs()).find(tab => tab.tabId === second);
		const cwd = run2?.cwd ?? "";
		const sessionPath = run2?.sessionPath ?? "";
		expect(cwd).not.toBe(run1.cwd);
		await waitForStatus(page, second, s => s.now?.n === 1, "run 2 cycle 1 starts", 180_000);
		const armed2 = await permissions(page, second);
		expectArmed(armed2);
		const base2 = await baselineIn(cwd);
		await expect
			.poll(async () => (await markers(desktop)).some(marker => marker.reason === "running"), { timeout: 60_000 })
			.toBe(true);
		await expect
			.poll(
				async () =>
					sessionPath !== "" &&
					(await fs.readFile(path.join(desktop, "prefs.json"), "utf8")).includes(sessionPath),
				{
					timeout: 60_000,
				},
			)
			.toBe(true);
		await crash(app);
		await expect
			.poll(() => survivors(profile), { timeout: 20_000, message: "the killed app's children must end" })
			.toEqual([]);
		({ app, page } = await launch(desktop, env));
		let resumedId = "";
		await expect
			.poll(
				async () => {
					resumedId = (await tabs()).find(tab => tab.cwd === cwd)?.tabId ?? "";
					return resumedId;
				},
				{ timeout: 60_000, message: "the relaunch restores the run's tab" },
			)
			.not.toBe("");
		await page.evaluate(id => window.omp.tabs.setActive(id), resumedId);
		// The run continues by itself after the kill (the user's rule: always continue after a restart): main arms it
		// again in the new omp and resumes stock's goal, whose continuation begins the next cycle. It must hold the run's
		// permissions while running and give them back at the end.
		const relaunched = await waitForStatus(
			page,
			resumedId,
			s => s.state === "running" && s.now !== undefined,
			"run 2 continues after the kill",
			300_000,
		);
		const armed3 = await permissions(page, resumedId);
		expectArmed(armed3);
		expect(await fs.readFile(configPath, "utf8")).toBe(config);
		evidence.run2 = {
			base: base2,
			armed: armed2,
			afterRelaunch: { state: relaunched.state, cycle: relaunched.now?.n, held: armed3 },
			...(await stopAndRestore(resumedId, base2, "run 2")),
		};
		evidence.cost = await spentIn(agent);
	} finally {
		await fs
			.writeFile(path.join(evidenceDir, "real-autopilot-permissions.json"), JSON.stringify(evidence, null, 2))
			.catch(() => undefined);
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
});

test("real omp autopilot guide: Start's guide is one request on the smol role, with a Release section from the project's facts, and its cost", async () => {
	test.skip(process.env.OMP_GUI_REAL_WORK !== "1", "Opt-in model audit");
	test.setTimeout(300_000);
	const evidenceDir = process.env.OMP_GUI_REAL_WORK_ARTIFACTS ?? path.join(os.tmpdir(), "ompdesk-real-autopilot");
	await fs.mkdir(evidenceDir, { recursive: true });
	const { profile, project, desktop, agent, env } = await seededProfile();
	const { app, page } = await launch(desktop, env, project);
	try {
		await expect
			.poll(() => page.evaluate(() => window.omp.sidecar.getStatus()), { timeout: 60_000 })
			.toMatchObject({ status: "ready" });
		const origin = await mainTab(page);
		// The sheet's status asks no model and carries no guide.
		const idle = await command(page, origin, { type: "get_autopilot" });
		expect(idle).toMatchObject({ success: true, data: { active: false } });
		expect(field(idle, "data")).not.toHaveProperty("guide");
		expect(await spentIn(agent)).toEqual({ usd: 0, tokens: 0 });

		// What Start asks the bridge for: a repository without AUTOPILOT.md gets one drafted by the smol model.
		const built = await command(page, origin, {
			type: "autopilot_bridge",
			method: "modes.autopilot_guide",
			params: { root: project, procedure: null },
		});
		expect(built).toMatchObject({ success: true });
		const guide = field(built, "data");
		const text = String(field(guide, "text"));
		const cost = field(guide, "cost");
		const evidence = {
			source: field(guide, "source"),
			release: field(guide, "release"),
			chars: text.length,
			cost,
			text,
		};
		await fs.writeFile(path.join(evidenceDir, "guide-draft.json"), JSON.stringify(evidence, null, 2));
		test.info().annotations.push({ type: "guide-draft-cost", description: JSON.stringify(cost) });
		// The real smol model answered (not the template), with a usable guide that names the repo's own rule and a
		// Release section saying what the facts say: no tags, no publish path, so no release.
		expect(field(guide, "source")).toBe("model");
		expect(field(guide, "releases")).toBe(false);
		expect(text).toMatch(/^#/m);
		expect(text.length).toBeGreaterThan(200);
		expect(text.length).toBeLessThanOrEqual(8_000);
		expect(text).toContain("bun test");
		expect(text).toMatch(/\n## Release\n\s*Releases: no\b/);
		expect(typeof field(cost, "model")).toBe("string");
		// Nothing was written anywhere: the checkout still has no AUTOPILOT.md.
		await expect(fs.access(path.join(project, "AUTOPILOT.md"))).rejects.toThrow();
	} finally {
		await exitApp(app);
		await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
});
