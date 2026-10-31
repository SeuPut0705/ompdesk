import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitSync, initRepo } from "../local/git/test-repos";
import { SCHEDULE_TICK_MS } from "../schedules";
import { createGitSource } from "./git";
import { gitPort } from "./ports";
import { fakeContext } from "./test-context";

const dirs: string[] = [];
let repo: string;

beforeEach(async () => {
	repo = await mkdtemp(join(tmpdir(), "routine-git-"));
	dirs.push(repo);
	await initRepo(repo);
});
afterEach(async () => {
	vi.useRealTimers();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function commit(message: string, file = "f.txt"): Promise<string> {
	await writeFile(join(repo, file), `${message}\n`);
	gitSync(repo, "add", ".");
	gitSync(repo, "commit", "-q", "-m", message);
	return gitSync(repo, "rev-parse", "--short", "HEAD");
}

/** Lets a read that is already in flight (real git processes) settle, then runs the next tick. */
async function tick(): Promise<void> {
	await vi.advanceTimersByTimeAsync(SCHEDULE_TICK_MS);
	await vi.waitFor(() => expect(settled()).toBe(true));
}
let busy = 0;
const settled = () => busy === 0;
const counting = {
	head: async (r: string, b: string) => {
		busy++;
		try {
			return await gitPort.head(r, b);
		} finally {
			busy--;
		}
	},
	commits: async (r: string, from: string, to: string) => {
		busy++;
		try {
			return await gitPort.commits(r, from, to);
		} finally {
			busy--;
		}
	},
};

describe("git source on a real repository", () => {
	it("records the baseline, then fires once for a moved branch with its log", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
		const { context, fired } = fakeContext();
		const source = createGitSource({ repo, branch: "main", git: counting, context });
		await tick();
		expect(fired).toEqual([]);

		const first = await commit("Fix login");
		const second = await commit("Add tests");
		await tick();
		expect(fired).toEqual([`2 new commits on main: ${second} Add tests; ${first} Fix login`]);

		await tick();
		expect(fired).toHaveLength(1);
		source.stop();
	});

	it("a relaunch fires once for the commits made while OMPdesk was closed, saving the new head first", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
		const first = fakeContext();
		const before = createGitSource({ repo, branch: "main", git: counting, context: first.context });
		await tick();
		before.stop();
		const head = first.saved.at(-1);
		expect(head).toEqual({ head: gitSync(repo, "rev-parse", "HEAD") });

		const made = await commit("While closed");
		const order: string[] = [];
		const next = fakeContext(head);
		const context = {
			...next.context,
			saveMark: (mark: unknown) => {
				order.push("save");
				next.context.saveMark(mark);
			},
			fire: (detail: string) => {
				order.push("fire");
				return next.context.fire(detail);
			},
		};
		const after = createGitSource({ repo, branch: "main", git: counting, context });
		await tick();
		await tick();
		expect(next.fired).toEqual([`1 new commit on main: ${made} While closed`]);
		expect(order).toEqual(["save", "fire"]);
		expect(next.saved.at(-1)).toEqual({ head: gitSync(repo, "rev-parse", "HEAD") });
		after.stop();
	});

	it("lists ten commits and counts the rest", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
		const { context, fired } = fakeContext();
		createGitSource({ repo, branch: "main", git: counting, context });
		await tick();
		for (let index = 0; index < 12; index++) await commit(`c${index}`, `f${index}.txt`);
		await tick();
		expect(fired).toHaveLength(1);
		expect(fired[0]).toMatch(/^12 new commits on main: .*; and 2 more$/);
		expect(fired[0]?.split("; ")).toHaveLength(11);
	});

	it("takes commits made during its own run as the baseline when the run ends, then fires for later ones", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
		const { context, fired, state } = fakeContext();
		const source = createGitSource({ repo, branch: "main", git: counting, context });
		await tick();

		state.running = true;
		await commit("by the routine");
		await tick();
		await tick();
		expect(fired).toEqual([]);

		state.running = false;
		source.runEnded?.();
		await vi.waitFor(() => expect(settled()).toBe(true));
		await tick();
		expect(fired).toEqual([]);

		const later = await commit("by someone else");
		await tick();
		expect(fired).toEqual([`1 new commit on main: ${later} by someone else`]);
	});

	it("fires nothing for a branch that does not exist yet or a reset back, and tells a missing branch once", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
		const { context, fired, warned } = fakeContext();
		createGitSource({ repo, branch: "later", git: counting, context });
		await tick();
		await tick();
		expect(warned).toHaveLength(1);
		gitSync(repo, "branch", "later");
		await tick();
		expect(fired).toEqual([]);

		const back = createGitSource({ repo, branch: "main", git: counting, context });
		await tick();
		await commit("one more");
		await tick();
		expect(fired).toHaveLength(1);
		gitSync(repo, "reset", "-q", "--hard", "HEAD~1");
		await tick();
		expect(fired).toHaveLength(1);
		back.stop();
	});

	it("tells a repository git cannot read once, and fires nothing", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
		const { context, fired, warned } = fakeContext();
		const nowhere = await mkdtemp(join(tmpdir(), "routine-nogit-"));
		dirs.push(nowhere);
		createGitSource({ repo: nowhere, branch: "main", git: counting, context });
		await tick();
		await tick();
		expect(fired).toEqual([]);
		expect(warned).toHaveLength(1);
	});

	it("reads no more after stop", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
		const head = vi.fn(async () => "abc");
		const { context } = fakeContext();
		const source = createGitSource({
			repo,
			branch: "main",
			git: { head, commits: async () => ({ total: 0, lines: [] }) },
			context,
		});
		await vi.advanceTimersByTimeAsync(0);
		source.stop();
		await vi.advanceTimersByTimeAsync(SCHEDULE_TICK_MS * 3);
		expect(head).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});
