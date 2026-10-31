import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GITHUB_POLL_MINUTES } from "../../shared/schedules";
import { createGithubSource, type GhApi } from "./github";
import { fakeContext } from "./test-context";

const POLL_MS = GITHUB_POLL_MINUTES * 60_000;

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

/** A GitHub that answers each endpoint from `answers` (a value, or a function of how many times it was asked). */
function fakeGithub(answers: Record<string, unknown>) {
	const calls: string[] = [];
	const api: GhApi = async endpoint => {
		calls.push(endpoint);
		const key = Object.keys(answers).find(prefix => endpoint.startsWith(prefix));
		if (key === undefined) throw new Error(`gh: HTTP 404: Not Found (${endpoint})`);
		const answer = answers[key];
		if (answer instanceof Error) throw answer;
		return answer;
	};
	return { api, calls, answers };
}

async function poll(): Promise<void> {
	await vi.advanceTimersByTimeAsync(POLL_MS);
}

const pull = (number: number, title: string, login: string) => ({
	number,
	title,
	user: { login },
	html_url: `https://github.com/o/r/pull/${number}`,
});

describe("github source across a relaunch", () => {
	it("fires once for what was opened while OMPdesk was closed, and nothing on the launch after", async () => {
		const github = fakeGithub({ "repos/o/r/pulls": [pull(11, "Old", "bob")] });
		const first = fakeContext();
		const before = createGithubSource({
			repo: "o/r",
			events: ["pull_request"],
			api: github.api,
			context: first.context,
		});
		await vi.advanceTimersByTimeAsync(0);
		before.stop();
		const mark = first.saved.at(-1);
		expect(mark).toEqual({ seen: { pull_request: [11] } });

		github.answers["repos/o/r/pulls"] = [pull(12, "While closed", "alice"), pull(11, "Old", "bob")];
		const next = fakeContext(mark);
		const source = createGithubSource({
			repo: "o/r",
			events: ["pull_request"],
			api: github.api,
			context: next.context,
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(next.fired).toEqual(['PR #12 "While closed" opened by alice: https://github.com/o/r/pull/12']);
		source.stop();

		const third = fakeContext(next.saved.at(-1));
		const last = createGithubSource({
			repo: "o/r",
			events: ["pull_request"],
			api: github.api,
			context: third.context,
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(third.fired).toEqual([]);
		expect(github.calls.length).toBe(3);
		last.stop();
	});
});

describe("github source", () => {
	it("records what exists on the first poll and fires once per pull request opened after it", async () => {
		const github = fakeGithub({ "repos/o/r/pulls": [pull(11, "Old", "bob")] });
		const { context, fired } = fakeContext();
		const source = createGithubSource({ repo: "o/r", events: ["pull_request"], api: github.api, context });
		await vi.advanceTimersByTimeAsync(0);
		expect(github.calls).toHaveLength(1);
		expect(fired).toEqual([]);

		github.answers["repos/o/r/pulls"] = [pull(12, "Fix login", "alice"), pull(11, "Old", "bob")];
		await poll();
		expect(fired).toEqual(['PR #12 "Fix login" opened by alice: https://github.com/o/r/pull/12']);

		await poll();
		expect(fired).toHaveLength(1);
		source.stop();
	});

	it("tells several new pull requests oldest first, one fire each", async () => {
		const github = fakeGithub({ "repos/o/r/pulls": [pull(1, "One", "a")] });
		const { context, fired } = fakeContext();
		createGithubSource({ repo: "o/r", events: ["pull_request"], api: github.api, context });
		await vi.advanceTimersByTimeAsync(0);
		github.answers["repos/o/r/pulls"] = [pull(3, "Three", "c"), pull(2, "Two", "b"), pull(1, "One", "a")];
		await poll();
		expect(fired.map(line => line.slice(0, 8))).toEqual(['PR #2 "T', 'PR #3 "T']);
	});

	it("follows issues and leaves the pull requests of the issues endpoint out", async () => {
		const github = fakeGithub({ "repos/o/r/issues": [] });
		const { context, fired } = fakeContext();
		createGithubSource({ repo: "o/r", events: ["issue"], api: github.api, context });
		await vi.advanceTimersByTimeAsync(0);
		github.answers["repos/o/r/issues"] = [
			{ ...pull(9, "A pull request", "p"), pull_request: {} },
			{ number: 8, title: "Crash on start", user: { login: "bob" }, html_url: "https://github.com/o/r/issues/8" },
		];
		await poll();
		expect(fired).toEqual(['Issue #8 "Crash on start" opened by bob: https://github.com/o/r/issues/8']);
	});

	it("fires for a workflow run that failed after the baseline, not for the ones already failed", async () => {
		const run = (id: number, branch: string) => ({
			id,
			name: "CI",
			display_title: "Fix login",
			head_branch: branch,
			conclusion: "failure",
			html_url: `https://github.com/o/r/actions/runs/${id}`,
		});
		const github = fakeGithub({ "repos/o/r/actions/runs": { workflow_runs: [run(100, "main")] } });
		const { context, fired } = fakeContext();
		createGithubSource({ repo: "o/r", events: ["ci_failure"], api: github.api, context });
		await vi.advanceTimersByTimeAsync(0);
		github.answers["repos/o/r/actions/runs"] = { workflow_runs: [run(101, "feature"), run(100, "main")] };
		await poll();
		expect(fired).toEqual([
			'CI failure: workflow "CI" on feature ("Fix login"): https://github.com/o/r/actions/runs/101',
		]);
		await poll();
		expect(fired).toHaveLength(1);
		expect(github.calls[0]).toBe("repos/o/r/actions/runs?status=failure&per_page=20");
	});

	it("fires for a release published after the baseline and never for a draft", async () => {
		const github = fakeGithub({ "repos/o/r/releases": [{ id: 1, tag_name: "v1.0.0", html_url: "u1" }] });
		const { context, fired } = fakeContext();
		createGithubSource({ repo: "o/r", events: ["release"], api: github.api, context });
		await vi.advanceTimersByTimeAsync(0);
		github.answers["repos/o/r/releases"] = [
			{ id: 3, tag_name: "v1.2.0", draft: true, html_url: "u3" },
			{ id: 2, tag_name: "v1.1.0", name: "Spring", author: { login: "alice" }, html_url: "u2" },
			{ id: 1, tag_name: "v1.0.0", html_url: "u1" },
		];
		await poll();
		expect(fired).toEqual(['Release v1.1.0 "Spring" published by alice: u2']);
	});

	it("fires once for new commits on the default branch, with its short hashes and subjects", async () => {
		const commit = (sha: string, message: string) => ({ sha, commit: { message: `${message}\n\nbody` } });
		const github = fakeGithub({
			"repos/o/r/commits": [commit("aaaaaaa1111", "Start")],
			"repos/o/r": { default_branch: "main" },
		});
		const { context, fired } = fakeContext();
		createGithubSource({ repo: "o/r", events: ["push"], api: github.api, context });
		await vi.advanceTimersByTimeAsync(0);
		expect(fired).toEqual([]);
		github.answers["repos/o/r/commits"] = [
			commit("ccccccc3333", "Fix it"),
			commit("bbbbbbb2222", "Add it"),
			commit("aaaaaaa1111", "Start"),
		];
		await poll();
		expect(fired).toEqual(["2 new commits on main (o/r): ccccccc Fix it; bbbbbbb Add it"]);
		await poll();
		expect(fired).toHaveLength(1);
		expect(github.calls).toContain("repos/o/r/commits?sha=main&per_page=20");
	});

	it("fires nothing when gh fails, tells each distinct failure once, and fires what happened meanwhile once it answers", async () => {
		const github = fakeGithub({ "repos/o/r/pulls": [pull(1, "One", "a")] });
		const { context, fired, warned } = fakeContext();
		createGithubSource({ repo: "o/r", events: ["pull_request"], api: github.api, context });
		await vi.advanceTimersByTimeAsync(0);

		github.answers["repos/o/r/pulls"] = new Error("gh auth login required");
		await poll();
		await poll();
		expect(warned).toEqual(["github o/r: pull_request: gh auth login required"]);
		github.answers["repos/o/r/pulls"] = new Error("HTTP 404");
		await poll();
		expect(warned).toHaveLength(2);
		expect(fired).toEqual([]);

		github.answers["repos/o/r/pulls"] = [pull(2, "Two", "b"), pull(1, "One", "a")];
		await poll();
		expect(fired).toEqual(['PR #2 "Two" opened by b: https://github.com/o/r/pull/2']);
	});

	it("takes the baseline from its first good answer when the first poll failed", async () => {
		const github = fakeGithub({ "repos/o/r/pulls": new Error("offline") });
		const { context, fired } = fakeContext();
		createGithubSource({ repo: "o/r", events: ["pull_request"], api: github.api, context });
		await vi.advanceTimersByTimeAsync(0);
		github.answers["repos/o/r/pulls"] = [pull(5, "Existing", "a")];
		await poll();
		expect(fired).toEqual([]);
		github.answers["repos/o/r/pulls"] = [pull(6, "New", "b"), pull(5, "Existing", "a")];
		await poll();
		expect(fired).toHaveLength(1);
	});

	it("asks GitHub no more after stop, and not at all for a malformed repository", async () => {
		const github = fakeGithub({ "repos/o/r/pulls": [] });
		const { context, warned } = fakeContext();
		const source = createGithubSource({ repo: "o/r", events: ["pull_request"], api: github.api, context });
		await vi.advanceTimersByTimeAsync(0);
		source.stop();
		await vi.advanceTimersByTimeAsync(POLL_MS * 3);
		expect(github.calls).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);

		const bad = fakeGithub({});
		createGithubSource({ repo: "o/..", events: ["push"], api: bad.api, context });
		await vi.advanceTimersByTimeAsync(POLL_MS);
		expect(bad.calls).toEqual([]);
		expect(warned[0]).toContain("not an owner/name repository");
	});
});
