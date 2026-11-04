import { describe, expect, it } from "vitest";
import {
	createHints,
	createPollTracker,
	EDIT_HINT,
	POLL_HINT,
	READY_LOG_REASON,
	readyLogCannotMatch,
} from "../../resources/gui-bridge/waste-guards-core";

/** The measured calls: a named service with `ready.log` and a command. */
function service(command: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { command, name: "tests", ready: { log: "Running \\d+ tests", timeout: 600 }, ...extra };
}

describe("ready.log that can never match", () => {
	it.each([
		["> file 2>&1", "bun test > /tmp/t.log 2>&1"],
		[">> file", "bun test >> t.log"],
		["&> file", "bun test &> t.log"],
		["1> file", "bun test 1> t.log"],
		["no space", "bun test >t.log 2>&1"],
		["&>> file", "bun test &>> t.log"],
		[">| file", "bun test >| t.log"],
		[">& file", "bun test >& t.log"],
		["/dev/null", "bun test > /dev/null"],
		["stderr to file, then stdout after it", "bun test 2> e.log > o.log"],
		["stderr joined, then stdout to a file", "bun test 2>&1 > t.log"],
		["quoted target", 'bun test > "$LOG_DIR/t.log" 2>&1'],
		["stdout to a closed fd", "bun test >&-"],
		["last command of a && chain", "cd app && bun test > t.log 2>&1"],
		["last command after ;", "export CI=1; bun test > t.log 2>&1"],
		["last stage of a pipeline", "bun test 2>&1 | sed s/a/b/ > t.log"],
		["background with &", "bun test > t.log 2>&1 &"],
		["a heredoc body before it", "cat <<'EOF'\nhello\nEOF\nbun test > t.log 2>&1"],
		["a heredoc line that carries the redirect", "cat <<EOF > out.txt\nhello\nEOF"],
		["a line continuation before the redirect", "bun test \\\n  > t.log 2>&1"],
	])("is refused: %s", (_label, command) => {
		expect(readyLogCannotMatch(service(command))).toBe(true);
	});

	it.each([
		["no redirect", "bun test"],
		["tee keeps stdout visible", "bun test 2>&1 | tee t.log"],
		["only stderr to a file", "bun test 2> e.log"],
		["stdout duplicated onto stderr", "bun test > t.log 1>&2"],
		["stdout to the terminal", "bun test > /dev/stdout"],
		["stdout through a process substitution", "bun test > >(tee t.log)"],
		["a redirect earlier in the chain", "bun test > t.log 2>&1; tail -f t.log"],
		["a redirect in an earlier pipeline stage", "bun test > t.log | tee u.log"],
		["a quoted >", 'echo "a > b"'],
		["a comment", "bun test # > t.log"],
		["a redirect that is only in a heredoc body", "cat <<'EOF'\nbun test > t.log 2>&1\nEOF"],
		["a redirect only inside a subshell", "(bun test > t.log)"],
		["input redirection", "bun test < input.txt"],
		["a later fd", "bun test 3> t.log"],
		["a comparison in a quoted argument", "node -e 'if (a > b) go()'"],
	])("passes: %s", (_label, command) => {
		expect(readyLogCannotMatch(service(command))).toBe(false);
	});

	it("looks only at a call stock would hold for ready.log", () => {
		const command = "bun test > t.log 2>&1";
		expect(readyLogCannotMatch({ command, name: "t", ready: { port: 3000 } })).toBe(false);
		expect(readyLogCannotMatch({ command, name: "t", ready: { log: "  " } })).toBe(false);
		expect(readyLogCannotMatch({ command, name: "t" })).toBe(false);
		// Stock ignores `ready` without a service name: the call does not wait.
		expect(readyLogCannotMatch({ command, ready: { log: "x" } })).toBe(false);
		expect(readyLogCannotMatch({ command, name: " ", ready: { log: "x" } })).toBe(false);
		expect(readyLogCannotMatch({ name: "t", ready: { log: "x" } })).toBe(false);
	});

	it("tells the agent what to do instead", () => {
		expect(READY_LOG_REASON).toContain("ready.log can never match");
		expect(READY_LOG_REASON).toContain("async: true");
		expect(READY_LOG_REASON).toContain("| tee file");
	});
});

/** The kinds polled by a session that made these calls in order (a fresh tracker per case). */
function polled(...calls: [tool: string, input: Record<string, unknown>][]): string[][] {
	const tracker = createPollTracker();
	return calls.map(([tool, input]) => tracker.observe(tool, input));
}

describe("polling kinds", () => {
	it.each([
		["sleep then a command", "bash", { command: "sleep 5; echo hi" }, ["sleep"]],
		["sleep 15 then gh run list", "bash", { command: "sleep 15 && gh run list --limit 3" }, ["sleep"]],
		["after other work", "bash", { command: "git push; sleep 30; gh run view 123" }, ["sleep"]],
		["a while loop with sleep", "bash", { command: "while ! curl -s localhost:3000; do sleep 2; done" }, ["sleep"]],
		["gh run watch in the foreground", "bash", { command: "gh run watch 42 --exit-status" }, ["gh-run"]],
		["tail -f", "bash", { command: "tail -f /tmp/t.log" }, ["tail-f"]],
		["tail -n 20 -f", "bash", { command: "tail -n 20 -f t.log" }, ["tail-f"]],
		["tail --follow", "bash", { command: "tail --follow t.log" }, ["tail-f"]],
	] as const)("%s polls at first sight", (_label, tool, input, kinds) => {
		expect(createPollTracker().observe(tool, { ...input })).toEqual(kinds);
	});

	it.each([
		["gh run list", "bash", { command: "gh run list --workflow release.yml" }],
		["gh run view", "bash", { command: "gh run view 42" }],
		[
			"gh run view --json with a quoted pipe",
			"bash",
			{ command: "gh run view 41866157920 --json jobs,headSha -q '.jobs[] | .name'" },
		],
		["gh run view --log-failed", "bash", { command: "gh run view 42 --log-failed" }],
		["gh run view --log of a job", "bash", { command: "gh run view 42 --job 7 --log" }],
		["pgrep", "bash", { command: "pgrep -f vitest" }],
		["a proc:// read", "read", { path: "proc://bg_1" }],
		["a proc:// read of a stream", "read", { path: "proc://bg_1/streams/0" }],
	] as const)("%s is a look, not a poll, the first time", (_label, tool, input) => {
		expect(createPollTracker().observe(tool, { ...input })).toEqual([]);
	});

	it("tells the second look at one target from a look at another", () => {
		expect(
			polled(
				["bash", { command: "gh run view 1 --json status" }],
				["bash", { command: "gh run view 1 --json jobs" }],
				["bash", { command: "gh run view 2" }],
				["bash", { command: "gh run list --limit 3" }],
				["bash", { command: "gh run list --limit 3" }],
				["bash", { command: "gh run list --limit 5" }],
				["bash", { command: "pgrep -f vitest" }],
				["bash", { command: "pgrep -f vitest" }],
				["bash", { command: "pgrep -f vite" }],
				["read", { path: "proc://bg_1" }],
				["read", { path: "proc://bg_1" }],
				["read", { path: "proc://bg_2" }],
			),
		).toEqual([[], ["gh-run"], [], [], ["gh-run"], [], [], ["pgrep"], [], [], ["proc"], []]);
	});

	it("never counts a diagnosis of a run as a look at it", () => {
		expect(
			polled(
				["bash", { command: "gh run view 1 --log-failed" }],
				["bash", { command: "gh run view 1 --log-failed" }],
				["bash", { command: "gh run view 1" }],
				["bash", { command: "gh run view 1 --job 9 --log" }],
				["bash", { command: "gh run view 1" }],
			),
		).toEqual([[], [], [], [], ["gh-run"]]);
	});

	it("reads a run id past the flags that take a number", () => {
		expect(
			polled(
				["bash", { command: "gh run view --job 77 --json status" }],
				["bash", { command: "gh run view 5 --job 77" }],
				["bash", { command: "gh run view --job 78" }],
				["bash", { command: "gh run view --job 77" }],
				["bash", { command: "gh run view 5 -a 2" }],
				["bash", { command: "gh run view 5 -a 3" }],
			),
		).toEqual([[], [], [], ["gh-run"], [], ["gh-run"]]);
	});

	it("sees every gh run look of one call", () => {
		expect(polled(["bash", { command: "gh run view 1; gh run view 1 && sleep 1 && echo x" }])).toEqual([
			["sleep", "gh-run"],
		]);
	});

	it.each([
		["a lone sleep", "bash", { command: "sleep 5" }],
		["sleep at the end", "bash", { command: "echo start; sleep 5" }],
		["tail without follow", "bash", { command: "tail -n 50 t.log" }],
		["gh run rerun", "bash", { command: "gh run rerun 42 --failed" }],
		[
			"a script written through a heredoc",
			"bash",
			{ command: "cat > poll.sh <<'EOF'\nsleep 5; gh run list; pgrep x\nEOF" },
		],
		["a plain file read", "read", { path: "src/main/index.ts:1-40" }],
		["another tool", "grep", { pattern: "sleep 5; x" }],
		["gh run watch under async: true", "bash", { command: "gh run watch 42 --exit-status", async: true }],
	] as const)("%s is no poll", (_label, tool, input) => {
		expect(polled([tool, { ...input }], [tool, { ...input }])[0]).toEqual([]);
	});
});

describe("poll hints", () => {
	it("keep quiet at the first look of a target and speak at the second", () => {
		const hints = createHints();
		expect(hints.note("bash", { command: "gh run view 41866157920 --log-failed" })).toBeUndefined();
		expect(hints.note("bash", { command: "gh run view 41866157920 --json jobs,headSha" })).toBeUndefined();
		expect(hints.note("bash", { command: "gh run view 41866157921 --json jobs,headSha" })).toBeUndefined();
		expect(hints.note("bash", { command: "gh run view 41866157920 --json jobs,headSha" })).toBe(POLL_HINT);
		expect(hints.note("bash", { command: "gh run view 41866157920 --json jobs,headSha" })).toBeUndefined();
	});

	it("speak for sleeping to wait and for the second read of a proc://", () => {
		expect(createHints().note("bash", { command: "sleep 30; gh run list" })).toBe(POLL_HINT);
		const hints = createHints();
		expect(hints.note("read", { path: "proc://bg_1" })).toBeUndefined();
		expect(hints.note("read", { path: "proc://bg_1" })).toBe(POLL_HINT);
	});

	it("speak once per kind, then keep quiet", () => {
		const hints = createHints();
		expect(hints.note("bash", { command: "sleep 5; echo hi" })).toBe(POLL_HINT);
		expect(hints.note("bash", { command: "sleep 5; echo hi" })).toBeUndefined();
		expect(hints.note("bash", { command: "sleep 9; ls" })).toBeUndefined();
		expect(hints.note("bash", { command: "gh run list" })).toBeUndefined();
		expect(hints.note("bash", { command: "gh run list" })).toBe(POLL_HINT);
		expect(hints.note("bash", { command: "gh run list" })).toBeUndefined();
		expect(hints.note("bash", { command: "pgrep node" })).toBeUndefined();
		expect(hints.note("bash", { command: "pgrep node" })).toBe(POLL_HINT);
		expect(hints.note("bash", { command: "tail -f t.log" })).toBe(POLL_HINT);
		expect(hints.note("read", { path: "proc://bg_1" })).toBeUndefined();
		expect(hints.note("read", { path: "proc://bg_1" })).toBe(POLL_HINT);
		expect(hints.note("read", { path: "proc://bg_1" })).toBeUndefined();
	});

	it("count a kind the call carried with a new one as told", () => {
		const hints = createHints();
		expect(hints.note("bash", { command: "sleep 5; gh run list" })).toBe(POLL_HINT);
		expect(hints.note("bash", { command: "gh run list" })).toBe(POLL_HINT);
		expect(hints.note("bash", { command: "gh run list" })).toBeUndefined();
		expect(hints.note("bash", { command: "sleep 5; pgrep x" })).toBeUndefined();
	});

	it("say nothing for a call that is no poll", () => {
		const hints = createHints();
		expect(hints.note("bash", { command: "bun test" })).toBeUndefined();
		expect(hints.note("read", { path: "a.ts" })).toBeUndefined();
		expect(hints.note("bash", { command: "sleep 5; echo hi" })).toBe(POLL_HINT);
	});

	it("keep their count per instance", () => {
		const first = createHints();
		const second = createHints();
		expect(first.note("bash", { command: "pgrep x" })).toBeUndefined();
		expect(first.note("bash", { command: "pgrep x" })).toBe(POLL_HINT);
		expect(second.note("bash", { command: "pgrep x" })).toBeUndefined();
		expect(second.note("bash", { command: "pgrep x" })).toBe(POLL_HINT);
	});
});

const ANCHORS =
	"This edit anchors to lines 9 of CHANGELOG.md that [CHANGELOG.md#F9F4] never displayed (it showed a partial range, a search hit, or a folded summary).";
const FOREIGN_TAG = "Tag #0000 is not from this session; re-read the file with `read` to get its tag.";

describe("hint on a refused edit", () => {
	it("speaks once for edits anchored to unseen lines or a tag the session never got", () => {
		const hints = createHints();
		expect(hints.note("edit", {}, { isError: true, text: ANCHORS })).toBe(EDIT_HINT);
		expect(hints.note("edit", {}, { isError: true, text: ANCHORS })).toBeUndefined();
		expect(hints.note("edit", {}, { isError: true, text: FOREIGN_TAG })).toBeUndefined();
		const other = createHints();
		expect(other.note("edit", {}, { isError: true, text: FOREIGN_TAG })).toBe(EDIT_HINT);
	});

	it("ignores a successful edit, another refusal and another tool", () => {
		const hints = createHints();
		expect(hints.note("edit", {}, { isError: false, text: ANCHORS })).toBeUndefined();
		expect(
			hints.note("edit", {}, { isError: true, text: "Edit rejected: file changed between read and edit." }),
		).toBeUndefined();
		expect(hints.note("read", {}, { isError: true, text: ANCHORS })).toBeUndefined();
		expect(hints.note("edit", {})).toBeUndefined();
		expect(hints.note("edit", {}, { isError: true, text: ANCHORS })).toBe(EDIT_HINT);
	});

	it("tells the rule: shown lines, a read after a grep hit, a tag from a read, tags from the response", () => {
		expect(EDIT_HINT).toContain("latest read");
		expect(EDIT_HINT).toContain("grep hit");
		expect(EDIT_HINT).toContain("never invent");
		expect(EDIT_HINT).toContain("response");
	});
});
