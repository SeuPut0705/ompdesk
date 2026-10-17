import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";
import type { AutopilotStatus } from "../resources/gui-bridge/modes/autopilot-contracts";
import {
	command,
	git,
	mainTab,
	refs,
	setAutopilot,
	startRun,
	status,
	waitForRunTab,
	waitForStatus,
} from "./autopilot-harness";
import { exitApp } from "./harness";
import { realOmpProfile } from "./real-omp";

// Explicit opt-in (OMP_GUI_REAL_WORK=1): this audit spends model tokens on the user's `smol` role (two cycles, then one
// push-level cycle) in a private disposable agent dir (config.yml and agent.db copied, 0700), a temp git repository and
// a local bare remote. Ordinary runs never call a model. Fan-out and the release need the fake omp.
//
// What it proves on the real omp 18.x: the run opens a new worktree tab on autopilot/<date>; each turn is one cycle
// the journal records; the protocol section and the `autopilot` tool are active (the agent begins and ends cycles);
// the tool guard really blocks a hard-banned command the agent is asked to run; nothing reaches the remote while
// "local only"; Stop ends the run after the cycle in flight with no further turn; no approval card ever shows. A
// second run on the push level pushes only its own autopilot branch and leaves main alone.
const APPROVE = /^(Approve|승인)$/;

test("real omp autopilot: two cycles in a new worktree, guarded, local only, then a push-level cycle", async () => {
	test.skip(process.env.OMP_GUI_REAL_WORK !== "1", "Opt-in model audit");
	test.setTimeout(2_400_000);
	const evidenceDir = process.env.OMP_GUI_REAL_WORK_ARTIFACTS ?? path.join(os.tmpdir(), "ompdesk-real-autopilot");
	await fs.mkdir(evidenceDir, { recursive: true });
	const { profile, project, desktop, env } = await realOmpProfile();
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
	const remoteBefore = refs(remote, "refs/heads");
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
	const app = await electron.launch({
		args: [path.resolve("out/main/index.js"), project, `--user-data-dir=${desktop}`],
		env,
	});
	const evidence: Record<string, unknown> = { remoteBefore };
	try {
		const page = await app.firstWindow();
		await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
		await expect
			.poll(() => page.evaluate(() => window.omp.sidecar.getStatus()), { timeout: 60_000 })
			.toMatchObject({ status: "ready" });
		let approvalSeen = false;
		const watchApprovals = async () => {
			if ((await page.getByRole("button", { name: APPROVE }).count()) > 0) approvalSeen = true;
		};
		const origin = await mainTab(page);

		// Run 1: "local only". Cycle 1 also gets a user instruction the guard must stop.
		const first = await startRun(page, origin, { maxParallel: 0 });
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
		const second = await startRun(page, origin, { preset: "push", limits: { cycles: 1 }, maxParallel: 0 });
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
