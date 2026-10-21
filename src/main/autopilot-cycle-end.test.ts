import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	AUTOPILOT_BRIDGE_METHODS,
	type AutopilotCycleRecord,
} from "../../resources/gui-bridge/modes/autopilot-contracts";
import type { RepoProbe } from "./autopilot";
import {
	afters,
	autopilot,
	build,
	commit,
	installAutopilotRig,
	main,
	notices,
	record,
	remote,
	runLogs,
	start,
	tmp,
	world,
} from "./autopilot-test-rig";
import { gitSync } from "./local/git/test-repos";
import type { SidecarLike } from "./sidecar-types";

installAutopilotRig();

describe("a cycle's end", () => {
	/** Fires the timers the coordinator arms while its chain waits on them, until the chain has drained. */
	async function drainWithTimers(): Promise<void> {
		for (let round = 0; round < 50; round++) {
			const { promise, resolve } = Promise.withResolvers<void>();
			setImmediate(resolve);
			await promise;
			for (const fire of afters.splice(0)) fire();
		}
		await autopilot.idle();
	}

	it("a git that cannot answer for a moment is no missing repository: no pause, the next cycle goes on", async () => {
		const probes: RepoProbe[] = ["unknown", "unknown", "present"];
		build({ probeRepo: async () => probes.shift() ?? "present" });
		await start();
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		autopilot.frame(sidecar, { type: "autopilot_cycle_end", record: record() });
		await drainWithTimers();
		const states = () => world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).map(call => call.params?.state);
		expect(states()).not.toContain("paused");
		expect(world.stock("ap-1", "set_goal").map(call => call.params?.action ?? "create")).toEqual(["create"]);
	});

	it("one probe that says gone is checked again: gone twice pauses, gone then present goes on", async () => {
		const once: RepoProbe[] = ["gone", "present"];
		build({ probeRepo: async () => once.shift() ?? "present" });
		await start();
		autopilot.frame(world.sidecars.get("ap-1") as unknown as SidecarLike, {
			type: "autopilot_cycle_end",
			record: record(),
		});
		await drainWithTimers();
		expect(
			world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).map(call => call.params?.state),
		).not.toContain("paused");
		build({ probeRepo: async () => "gone" });
		await start();
		autopilot.frame(world.sidecars.get("ap-2") as unknown as SidecarLike, {
			type: "autopilot_cycle_end",
			record: record(),
		});
		await drainWithTimers();
		expect(world.bridgeCalls("ap-2", AUTOPILOT_BRIDGE_METHODS.setState).at(-1)?.params).toMatchObject({
			state: "paused",
			reason: "repo_gone",
		});
	});

	it("pushes the autopilot branch after a green cycle when auto push is on, and records the journal action first", async () => {
		await start({ type: "set_autopilot", action: "start", preset: "push" });
		const sha = await commit(path.join(tmp, "wt-2026-10-17"), "a.txt");
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		autopilot.frame(sidecar, { type: "autopilot_cycle_end", record: record({ commit: sha }) });
		await autopilot.idle();
		expect(gitSync(remote, "rev-parse", "refs/heads/autopilot/2026-10-17")).toBe(sha);
		expect(gitSync(remote, "rev-parse", "refs/heads/main")).not.toBe(sha);
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.shipAction)[0]?.params).toEqual({
			kind: "push",
			refs: ["refs/remotes/origin/autopilot/2026-10-17"],
			sha,
		});
		const flags = world
			.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState)
			.map(call => call.params?.inFlight ?? null);
		expect(flags).toEqual([expect.objectContaining({ kind: "push" }), null]);
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).at(-1)?.params?.state).toBe("running");
	});

	it("does not push a red cycle, nor anything when auto push is off", async () => {
		await start({ type: "set_autopilot", action: "start", preset: "push" });
		await commit(path.join(tmp, "wt-2026-10-17"), "a.txt");
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		autopilot.frame(sidecar, { type: "autopilot_cycle_end", record: record({ verify: "red" }) });
		await autopilot.idle();
		expect(gitSync(remote, "for-each-ref", "refs/heads/autopilot")).toBe("");
		build();
		await start({ type: "set_autopilot", action: "start", preset: "local" });
		await commit(path.join(tmp, "wt-2026-10-17-2"), "b.txt").catch(() => undefined);
		autopilot.frame(world.sidecars.get("ap-2") as unknown as SidecarLike, {
			type: "autopilot_cycle_end",
			record: record(),
		});
		await autopilot.idle();
		expect(gitSync(remote, "for-each-ref", "refs/heads/autopilot")).toBe("");
	});

	describe("Automatic shipping lands on the default branch", () => {
		const worktree = () => path.join(tmp, "wt-2026-10-17");
		const end = async (over: Partial<AutopilotCycleRecord>) => {
			autopilot.frame(world.sidecars.get("ap-1") as unknown as SidecarLike, {
				type: "autopilot_cycle_end",
				record: record(over),
			});
			await autopilot.idle();
		};
		const notes = () =>
			world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.note).map(call => String(call.params?.text));

		it("a green cycle with a commit lands on main; a red cycle and one without a commit never do", async () => {
			await start();
			const before = gitSync(remote, "rev-parse", "refs/heads/main");
			const red = await commit(worktree(), "red.txt");
			await end({ verify: "red", commit: red });
			await end({ verify: "green" });
			expect(gitSync(remote, "rev-parse", "refs/heads/main")).toBe(before);
			const sha = await commit(worktree(), "green.txt");
			await end({ verify: "green", commit: sha });
			expect(gitSync(remote, "rev-parse", "refs/heads/main")).toBe(sha);
			// Never the user's checkout, never the run's own branch on the remote.
			expect(gitSync(main, "rev-parse", "main")).toBe(before);
			expect(gitSync(remote, "for-each-ref", "refs/heads/autopilot")).toBe("");
		});

		/** Someone else's commit on the remote's main, from a clone of their own (the run's repository is not touched). */
		async function pushElsewhere(file: string, text: string): Promise<string> {
			const other = path.join(tmp, "someone-else");
			if (await fs.stat(other).catch(() => null)) gitSync(other, "pull", "-q", "--ff-only", "origin", "main");
			else gitSync(tmp, "clone", "-q", remote, other);
			gitSync(other, "config", "user.email", "o@example.com");
			gitSync(other, "config", "user.name", "Other");
			gitSync(other, "config", "commit.gpgsign", "false");
			await fs.writeFile(path.join(other, file), text);
			gitSync(other, "add", file);
			gitSync(other, "commit", "-q", "-m", `elsewhere ${file}`);
			gitSync(other, "push", "-q", "origin", "HEAD:main");
			return gitSync(other, "rev-parse", "HEAD");
		}

		it("main moved: nothing lands and the agent is told to merge; after its merge the next green cycle lands", async () => {
			await start();
			const moved = await pushElsewhere("other.txt", "other\n");
			const sha = await commit(worktree(), "a.txt");
			await end({ verify: "green", commit: sha });
			expect(gitSync(remote, "rev-parse", "refs/heads/main")).toBe(moved);
			expect(notes().at(-1)).toMatch(
				/^Not landed: origin\/main has commits this run lacks\. Run git fetch origin && git merge origin\/main/,
			);
			// The agent's next cycle: merge, check, commit.
			gitSync(worktree(), "merge", "-q", "--no-edit", "origin/main");
			const merged = gitSync(worktree(), "rev-parse", "HEAD");
			await end({ verify: "green", commit: merged });
			expect(gitSync(remote, "rev-parse", "refs/heads/main")).toBe(merged);
		});

		it("main moved: the cycle's own check runs on the merge, and a passing merge lands without the agent", async () => {
			await start();
			const moved = await pushElsewhere("other.txt", "other\n");
			const sha = await commit(worktree(), "a.txt");
			await end({ verify: "green", commit: sha, checkCommand: "test -f a.txt && test -f other.txt" });
			const landed = gitSync(remote, "rev-parse", "refs/heads/main");
			expect(gitSync(remote, "rev-list", "--parents", "-n", "1", landed).split(" ").slice(1)).toEqual([sha, moved]);
			expect(notes().at(-1)).toMatch(/^Landed on origin\/main as a merge .* fast-forwarded to it/);
			expect(gitSync(worktree(), "rev-parse", "HEAD")).toBe(landed);
			// A merge that fails the check never lands: the agent is told what failed.
			const next = await commit(worktree(), "b.txt");
			await pushElsewhere("third.txt", "third\n");
			const before = gitSync(remote, "rev-parse", "refs/heads/main");
			await end({ verify: "green", commit: next, checkCommand: "test ! -f third.txt" });
			expect(gitSync(remote, "rev-parse", "refs/heads/main")).toBe(before);
			expect(notes().at(-1)).toMatch(
				/^Not landed: .*your check \(test ! -f third\.txt\) fails on that merge \(exit 1\)/,
			);
		});

		it("a conflicting main is a note naming the files, never a pause", async () => {
			await start();
			await pushElsewhere("README.md", "theirs\n");
			await fs.writeFile(path.join(worktree(), "README.md"), "ours\n");
			gitSync(worktree(), "commit", "-q", "-am", "ours");
			await end({ verify: "green", commit: gitSync(worktree(), "rev-parse", "HEAD") });
			expect(notes().at(-1)).toContain("merging it conflicts in README.md");
			expect(
				world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).map(call => call.params?.state),
			).not.toContain("paused");
		});

		it("a protected main falls back to one pull request, said once, and the end summary says what landed", async () => {
			const hook = path.join(remote, "hooks", "pre-receive");
			await fs.writeFile(
				hook,
				'#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = refs/heads/main ]; then echo "GH006: Protected branch update failed" >&2; exit 1; fi\ndone\nexit 0\n',
			);
			await fs.chmod(hook, 0o755);
			await start();
			const first = await commit(worktree(), "a.txt");
			await end({ verify: "green", commit: first });
			const second = await commit(worktree(), "b.txt");
			await end({ verify: "green", commit: second });
			expect(gitSync(remote, "rev-parse", "refs/heads/autopilot/2026-10-17")).toBe(second);
			const said = notices.filter(notice => notice.title === "Autopilot can't push to the default branch");
			expect(said).toEqual([
				expect.objectContaining({ body: expect.stringContaining("https://github.com/o/r/pull/1") }),
			]);
			const status = await autopilot.status(world.sidecars.get("ap-1") as unknown as SidecarLike, "ap-1");
			expect(status.ship?.landing).toMatchObject({ via: "pr", url: "https://github.com/o/r/pull/1" });

			world.statuses
				.get("ap-1")
				?.cycles?.push(record({ n: 1, commit: first }), record({ n: 2, commit: second, verify: "red" }));
			autopilot.frame(world.sidecars.get("ap-1") as unknown as SidecarLike, {
				type: "autopilot_stop_requested",
				reason: "budget",
			});
			await autopilot.idle();
			expect(runLogs.at(-1)).toMatchObject({
				message: "paused",
				details: {
					reason: "budget",
					cycles: 2,
					green: 1,
					commits: 2,
					landed: 0,
					pr: "https://github.com/o/r/pull/1",
				},
			});
			expect(notices.at(-1)?.body).toBe(
				"autopilot/2026-10-17: 2 cycles (1 green), 2 commits; main is protected: 0 of 2 landed, the rest waits in https://github.com/o/r/pull/1. Stopped: The token limit was reached.",
			);
		});

		it("the end summary counts what landed and is written for the user's own pause too, with no notification", async () => {
			await start();
			const sha = await commit(worktree(), "a.txt");
			await end({ verify: "green", commit: sha });
			const unlanded = await commit(worktree(), "b.txt");
			await end({ verify: "red", commit: unlanded });
			world.statuses
				.get("ap-1")
				?.cycles?.push(record({ n: 1, commit: sha }), record({ n: 2, commit: unlanded, verify: "red" }));
			autopilot.frame(world.sidecars.get("ap-1") as unknown as SidecarLike, {
				type: "autopilot_stop_requested",
				reason: "user_pause",
			});
			await autopilot.idle();
			expect(runLogs.at(-1)).toMatchObject({ message: "paused", details: { landed: 1, commits: 2 } });
			expect(notices).toEqual([]);
		});
	});

	it("a verified user push request pushes at the turn's end even with auto push off", async () => {
		await start();
		const sha = await commit(path.join(tmp, "wt-2026-10-17"), "a.txt");
		world.requests.push({ kind: "push", quote: "push now", cycle: 1, at: 1 });
		autopilot.frame(world.sidecars.get("ap-1") as unknown as SidecarLike, {
			type: "autopilot_cycle_end",
			record: record({ verify: "red" }),
		});
		await autopilot.idle();
		expect(gitSync(remote, "rev-parse", "refs/heads/autopilot/2026-10-17")).toBe(sha);
	});

	it("a refused push is reported to the agent and never pauses the run", async () => {
		gitSync(main, "remote", "set-url", "origin", path.join(tmp, "missing.git"));
		await start({ type: "set_autopilot", action: "start", preset: "push" });
		await commit(path.join(tmp, "wt-2026-10-17"), "a.txt");
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		for (let cycle = 1; cycle <= 4; cycle++) {
			autopilot.frame(sidecar, { type: "autopilot_cycle_end", record: record({ n: cycle }) });
			await autopilot.idle();
		}
		const states = world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).map(call => call.params?.state);
		expect(states).not.toContain("paused");
		expect(String(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.note).at(-1)?.params?.text)).toMatch(
			/push of autopilot\/2026-10-17 failed.*never forces/,
		);
	});

	it("pauses with ban_violation when the cycle moved something it was not entitled to", async () => {
		await start();
		const worktree = path.join(tmp, "wt-2026-10-17");
		await commit(worktree, "a.txt");
		gitSync(worktree, "push", "-q", "origin", "HEAD:refs/heads/autopilot/2026-10-17");
		autopilot.frame(world.sidecars.get("ap-1") as unknown as SidecarLike, {
			type: "autopilot_cycle_end",
			record: record(),
		});
		await autopilot.idle();
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).at(-1)?.params).toMatchObject({
			state: "paused",
			reason: "ban_violation",
		});
		expect(world.stock("ap-1", "set_goal").at(-1)?.params).toEqual({ action: "pause" });
		expect(notices.at(-1)).toMatchObject({ kind: "error", title: "Autopilot paused" });
	});

	// What the guard cannot see (an obfuscated command), the audit still names: the moved ref is the detail.
	it.each([
		["a tag", (worktree: string) => gitSync(worktree, "tag", "stray-tag"), "refs/tags/stray-tag"],
		[
			"a push to another branch",
			(worktree: string) => gitSync(worktree, "push", "-q", "origin", "HEAD:refs/heads/rogue"),
			"refs/remotes/origin/rogue",
		],
	])("names %s the cycle made behind the guard's back", async (_name, act, ref) => {
		await start();
		const worktree = path.join(tmp, "wt-2026-10-17");
		await commit(worktree, "a.txt");
		act(worktree);
		autopilot.frame(world.sidecars.get("ap-1") as unknown as SidecarLike, {
			type: "autopilot_cycle_end",
			record: record(),
		});
		await autopilot.idle();
		const paused = world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).at(-1)?.params;
		expect(paused).toMatchObject({ state: "paused", reason: "ban_violation" });
		expect(String((paused as { detail?: unknown } | undefined)?.detail ?? "")).toContain(ref);
	});

	it("a clean cycle is not a violation, and a second cycle is judged against the first's end", async () => {
		await start();
		const worktree = path.join(tmp, "wt-2026-10-17");
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		await commit(worktree, "a.txt");
		autopilot.frame(sidecar, { type: "autopilot_cycle_end", record: record() });
		await autopilot.idle();
		await commit(worktree, "b.txt");
		autopilot.frame(sidecar, { type: "autopilot_cycle_end", record: record({ n: 2 }) });
		await autopilot.idle();
		expect(
			world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.setState).some(call => call.params?.state === "paused"),
		).toBe(false);
	});

	it("folds the children's usage into the cycle, closes their tabs and removes only clean merged worktrees", async () => {
		await start();
		const parent = path.join(tmp, "wt-2026-10-17");
		const merged = path.join(tmp, "child-merged");
		const unmerged = path.join(tmp, "child-unmerged");
		gitSync(main, "worktree", "add", "-q", "-b", "omp/agent/merged", merged, "autopilot/2026-10-17");
		gitSync(main, "worktree", "add", "-q", "-b", "omp/agent/unmerged", unmerged, "autopilot/2026-10-17");
		await commit(unmerged, "u.txt");
		for (const [tab, dir, branch] of [
			["child-1", merged, "omp/agent/merged"],
			["child-2", unmerged, "omp/agent/unmerged"],
		] as const) {
			world.addTab(tab, dir);
			await autopilot.beforeFirstPrompt({
				tabId: tab,
				callerTabId: "ap-1",
				tag: "autopilot-child",
				worktree: { path: dir, branch },
			});
		}
		world.stats.set("child-1", { tokens: { total: 1000 }, cost: 0.5 });
		world.stats.set("child-2", { tokens: { total: 250 }, cost: 0.25 });
		world.busy.add("child-2");
		await commit(parent, "p.txt");
		autopilot.frame(world.sidecars.get("ap-1") as unknown as SidecarLike, {
			type: "autopilot_cycle_end",
			record: record({ n: 4 }),
		});
		await autopilot.idle();
		expect(world.released.sort()).toEqual(["child-1", "child-2"]);
		expect(world.stock("child-2", "abort")).toHaveLength(1);
		expect(world.bridgeCalls("ap-1", AUTOPILOT_BRIDGE_METHODS.cycleAmend)[0]?.params).toEqual({
			n: 4,
			tokens: 1250,
			usd: 0.75,
		});
		await expect(fs.stat(merged)).rejects.toThrow();
		await expect(fs.stat(unmerged)).resolves.toBeTruthy();
		expect(
			gitSync(main, "for-each-ref", "--format=%(refname:short)", "refs/heads/omp/agent").split("\n").sort(),
		).toEqual(["omp/agent/merged", "omp/agent/unmerged"]);
	});

	it("keeps a merged child's worktree when it has uncommitted changes", async () => {
		await start();
		const dir = path.join(tmp, "child-dirty");
		gitSync(main, "worktree", "add", "-q", "-b", "omp/agent/dirty", dir, "autopilot/2026-10-17");
		await fs.writeFile(path.join(dir, "README.md"), "dirty\n");
		world.addTab("child-1", dir);
		await autopilot.beforeFirstPrompt({
			tabId: "child-1",
			callerTabId: "ap-1",
			tag: "autopilot-child",
			worktree: { path: dir, branch: "omp/agent/dirty" },
		});
		autopilot.frame(world.sidecars.get("ap-1") as unknown as SidecarLike, {
			type: "autopilot_cycle_end",
			record: record(),
		});
		await autopilot.idle();
		await expect(fs.stat(dir)).resolves.toBeTruthy();
	});

	it("a cycle's end is no notification, green or red: the screen and the timeline say it", async () => {
		await start();
		const sidecar = world.sidecars.get("ap-1") as unknown as SidecarLike;
		autopilot.frame(sidecar, { type: "autopilot_cycle_end", record: record({ n: 2, title: "Fix it" }) });
		autopilot.frame(sidecar, {
			type: "autopilot_cycle_end",
			record: record({ n: 3, verify: "red", title: "Broke it" }),
		});
		await autopilot.idle();
		expect(notices).toEqual([]);
	});
});
