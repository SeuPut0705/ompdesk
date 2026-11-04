import { describe, expect, it } from "vitest";
import {
	createPollHints,
	POLL_HINT,
	pollKinds,
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

describe("polling kinds", () => {
	it.each([
		["sleep then a command", "bash", { command: "sleep 5; echo hi" }, ["sleep"]],
		["sleep 15 then gh run list", "bash", { command: "sleep 15 && gh run list --limit 3" }, ["sleep", "gh-run"]],
		["after other work", "bash", { command: "git push; sleep 30; gh run view 123" }, ["sleep", "gh-run"]],
		["a while loop with sleep", "bash", { command: "while ! curl -s localhost:3000; do sleep 2; done" }, ["sleep"]],
		["gh run list", "bash", { command: "gh run list --workflow release.yml" }, ["gh-run"]],
		["gh run view", "bash", { command: "gh run view 42 --log-failed" }, ["gh-run"]],
		["gh run watch", "bash", { command: "gh run watch 42 --exit-status" }, ["gh-run"]],
		["pgrep", "bash", { command: "pgrep -f vitest" }, ["pgrep"]],
		["tail -f", "bash", { command: "tail -f /tmp/t.log" }, ["tail-f"]],
		["tail -n 20 -f", "bash", { command: "tail -n 20 -f t.log" }, ["tail-f"]],
		["tail --follow", "bash", { command: "tail --follow t.log" }, ["tail-f"]],
		["a proc:// read", "read", { path: "proc://bg_1" }, ["proc"]],
		["a proc:// read of a stream", "read", { path: "proc://bg_1/streams/0" }, ["proc"]],
	] as const)("%s", (_label, tool, input, kinds) => {
		expect(pollKinds(tool, { ...input })).toEqual(kinds);
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
		expect(pollKinds(tool, { ...input })).toEqual([]);
	});
});

describe("poll hints", () => {
	it("speak once per kind, then keep quiet", () => {
		const hints = createPollHints();
		expect(hints.note("bash", { command: "sleep 5; echo hi" })).toBe(POLL_HINT);
		expect(hints.note("bash", { command: "sleep 5; echo hi" })).toBeUndefined();
		expect(hints.note("bash", { command: "sleep 9; ls" })).toBeUndefined();
		expect(hints.note("bash", { command: "gh run list" })).toBe(POLL_HINT);
		expect(hints.note("bash", { command: "gh run view 1" })).toBeUndefined();
		expect(hints.note("bash", { command: "pgrep node" })).toBe(POLL_HINT);
		expect(hints.note("bash", { command: "tail -f t.log" })).toBe(POLL_HINT);
		expect(hints.note("read", { path: "proc://bg_1" })).toBe(POLL_HINT);
		expect(hints.note("read", { path: "proc://bg_2" })).toBeUndefined();
	});

	it("count a kind the call carried with a new one as told", () => {
		const hints = createPollHints();
		expect(hints.note("bash", { command: "sleep 5; gh run list" })).toBe(POLL_HINT);
		expect(hints.note("bash", { command: "gh run list" })).toBeUndefined();
		expect(hints.note("bash", { command: "sleep 5; pgrep x" })).toBe(POLL_HINT);
	});

	it("say nothing for a call that is no poll", () => {
		const hints = createPollHints();
		expect(hints.note("bash", { command: "bun test" })).toBeUndefined();
		expect(hints.note("read", { path: "a.ts" })).toBeUndefined();
		expect(hints.note("bash", { command: "sleep 5; echo hi" })).toBe(POLL_HINT);
	});

	it("keep their count per instance", () => {
		const first = createPollHints();
		const second = createPollHints();
		expect(first.note("bash", { command: "pgrep x" })).toBe(POLL_HINT);
		expect(second.note("bash", { command: "pgrep x" })).toBe(POLL_HINT);
	});
});
