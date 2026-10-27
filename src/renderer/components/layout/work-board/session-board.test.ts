import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../../../shared/rpc-types";
import type { ToolEntry } from "../../../stores/tools";
import { type WorkEvidence, workOutcomes } from "../../chat/work/work-view";
import { peerOverlap } from "./open-peer";
import { lastCheck, summarizePeers, turnSkills } from "./session-board";

function bash(command: string, text: string, exitCode: number, at: number, cwd?: string): ToolEntry {
	return {
		toolName: "bash",
		args: { command, ...(cwd ? { cwd } : {}) },
		status: exitCode ? "error" : "done",
		streamingArgs: "",
		result: { content: [{ type: "text", text }], details: { exitCode } },
		isError: exitCode !== 0,
		startTime: at,
		endTime: at + 1_000,
	};
}

/** The board's inputs: the session's main-agent calls, and the newest turn's ledger as its card builds it. */
function check(session: [string, ToolEntry][], turn: WorkEvidence[]) {
	return lastCheck(session, workOutcomes(turn, undefined, "/repo").commands, "/repo", new Map());
}
const main = (key: string, entry: ToolEntry): WorkEvidence => ({ entry, toolCallId: key });

describe("lastCheck", () => {
	it("names the newest turn's failed check no later run of the same call fixed, as its card does", () => {
		const a = bash("bunx vitest run", " Tests  1 failed (3)", 1, 0, "packages/a");
		const b = bash("bunx vitest run", " Tests  4 passed (4)", 0, 2_000, "packages/b");
		expect(
			check(
				[
					["a", a],
					["b", b],
				],
				[main("a", a), main("b", b)],
			),
		).toMatchObject({ key: "a", state: "failed", count: 1 });
	});

	it("names the newest run once the same call passed", () => {
		const failed = bash("bunx vitest run", " Tests  1 failed (3)", 1, 0);
		const passed = bash("bunx vitest run", " Tests  4 passed (4)", 0, 2_000);
		expect(
			check(
				[
					["a", failed],
					["b", passed],
				],
				[main("a", failed), main("b", passed)],
			),
		).toMatchObject({ key: "b", state: "passed", count: 4 });
	});

	it("lets an earlier turn's failure go once a later turn is green", () => {
		const earlier = bash("bun run check:types", "error TS2322", 2, 0);
		const later = bash("bunx vitest run", " Tests  4 passed (4)", 0, 60_000);
		expect(
			check(
				[
					["t1", earlier],
					["t2", later],
				],
				[main("t2", later)],
			),
		).toMatchObject({ key: "t2", state: "passed" });
	});

	it("reads a subagent's calls as the card does: a main rerun fixes the subagent's failure", () => {
		const child = bash("bun run check:types", "error TS2322", 2, 0);
		const rerun = bash("bun run check:types", "ok", 0, 5_000);
		expect(check([["m", rerun]], [{ entry: child, agentName: "Worker" }, main("m", rerun)])).toMatchObject({
			key: "m",
			state: "passed",
		});
	});

	it("names a subagent's unfixed check failure, which has no call of the main agent to open", () => {
		const child = bash("bun run check:types", "error TS2322", 2, 0);
		const result = check([], [{ entry: child, agentName: "Worker" }]);
		expect(result).toMatchObject({ kind: "typecheck", state: "failed" });
		expect(result?.key).toBeUndefined();
	});

	it("names a check still running, whatever failed before it", () => {
		const failed = bash("bun run check:types", "error TS2322", 2, 0);
		const running: ToolEntry = { ...bash("bun run build", "", 0, 3_000), status: "running", endTime: null };
		expect(
			check(
				[
					["a", failed],
					["b", running],
				],
				[main("a", failed), main("b", running)],
			),
		).toMatchObject({ key: "b", state: "running" });
	});

	// 26 Oct 2026: a subagent asked for a named (service) build with `async` and `timeout`; stock's bash refused the call
	// before running anything, and the board said "Check · build failed · 0ms" for the rest of the turn.
	it("never names a build the bash tool refused before running it, and names the build that did run", () => {
		const refused: ToolEntry = {
			...bash(
				"pnpm build 2>&1 | tail -40",
				"Service mode does not accept async or timeout; use ready.timeout for readiness.",
				1,
				5_000,
			),
			result: {
				content: [
					{
						type: "text",
						text: "Service mode does not accept async or timeout; use ready.timeout for readiness.",
					},
				],
				details: {},
			},
			endTime: 5_000,
		};
		expect(check([], [{ entry: refused, agentName: "HP3D" }])).toBeNull();
		const built = bash("pnpm build", "✓ Compiled successfully", 0, 0);
		expect(check([["b", built]], [main("b", built), { entry: refused, agentName: "HP3D" }])).toMatchObject({
			key: "b",
			state: "passed",
		});
	});

	it("names a build that ran and lost its exit status failed", () => {
		const text = "Creating an optimized build…\n\nCommand failed: missing exit status";
		const lost: ToolEntry = {
			...bash("pnpm build", text, 1, 0),
			result: { content: [{ type: "text", text }], details: {} },
		};
		expect(check([["b", lost]], [main("b", lost)])).toMatchObject({ key: "b", state: "failed" });
	});

	// 27 Oct 2026: after a deliberate failing test the agent ran the lint, a filtered type check and the test files in
	// one list; the card said so in green while the board kept naming the failed test for 36 minutes.
	it("names the passing run of a list that mixes check kinds once it fixed the failed check, as its card does", () => {
		const failed = bash("bunx vitest run src/a.test.ts", " Tests  1 failed | 4 passed (5)", 1, 0);
		const mixed = bash(
			'bunx biome check src; bun run check:types 2>&1 | grep -E "a.ts"; bunx vitest run src/a.test.ts 2>&1 | grep -E "Tests "',
			" Tests  80 passed (80)",
			0,
			2_000,
		);
		expect(
			check(
				[
					["a", failed],
					["b", mixed],
				],
				[main("a", failed), main("b", mixed)],
			),
		).toMatchObject({ key: "b", kind: "test", state: "passed", count: 80 });
	});
});

describe("peerOverlap", () => {
	const peers = {
		toplevel: "/w",
		commonDir: "/w/.git",
		canMessage: true,
		worktree: [
			{ id: "a", title: "A", files: ["/w/src/a.ts", "/w/src/z.ts"] },
			{ id: "b", title: "B", files: ["/w/docs/x.md"] },
		],
		repo: [{ id: "c", title: "C", worktree: "/wt/c", files: ["/w/src/a.ts", "/w/src/q.ts"] }],
	};

	it("matches the run's files, relative or absolute, against the peers' recent changes, the other worktrees' marked", () => {
		expect(peerOverlap(["src/a.ts", "/w/docs/y.md"], peers, "/w")).toEqual([
			{ peer: peers.worktree[0], scope: "worktree", files: ["/w/src/a.ts"] },
			{ peer: peers.repo[0], scope: "repo", files: ["/w/src/a.ts"] },
		]);
		expect(peerOverlap(["src/q.ts"], peers, "/w")).toEqual([
			{ peer: peers.repo[0], scope: "repo", files: ["/w/src/q.ts"] },
		]);
		expect(peerOverlap([], peers, "/w")).toEqual([]);
		expect(peerOverlap(["src/a.ts"], null, "/w")).toEqual([]);
	});
});

describe("summarizePeers", () => {
	it("counts the files this session shares with a peer in another worktree as it does a same-worktree peer's", () => {
		const summary = summarizePeers({
			toplevel: "/w",
			commonDir: "/w/.git",
			canMessage: true,
			worktree: [{ id: "a", title: "A", shared: ["/w/src/a.ts"] }],
			repo: [
				{ id: "c", title: "C", worktree: "/wt/c", shared: ["/w/src/a.ts", "/w/src/q.ts"] },
				{ id: "d", title: "D", worktree: "/wt/d" },
			],
		});
		expect(summary).toMatchObject({ worktree: 1, repo: 2, shared: 2 });
	});

	it("counts none for sessions that share nothing, and says nothing for a session alone", () => {
		const alone = { toplevel: "/w", commonDir: "/w/.git", canMessage: true, worktree: [], repo: [] };
		expect(summarizePeers(alone)).toBeNull();
		expect(summarizePeers({ ...alone, repo: [{ id: "c", title: "C", worktree: "/wt/c" }] })?.shared).toBe(0);
	});
});

describe("turnSkills", () => {
	const prompt = (name: string, attribution: "user" | "agent"): AgentMessage => ({
		role: "custom",
		customType: "skill-prompt",
		content: "Skill instructions",
		attribution,
		details: { name },
	});
	const user: AgentMessage = { role: "user", content: "go" };
	const reply: AgentMessage = { role: "assistant", content: [{ type: "text", text: "ok" }] };

	it("names the skills injected after the last user message, oldest first and once each", () => {
		expect(
			turnSkills([
				prompt("old", "agent"),
				user,
				prompt("review", "agent"),
				reply,
				prompt("how", "agent"),
				prompt("review", "agent"),
			]),
		).toEqual(["review", "how"]);
	});

	it("starts at the /skill: prompt that is itself the turn's prompt, so an earlier turn's skills stay out", () => {
		expect(turnSkills([user, prompt("how", "user"), reply, prompt("release", "user"), reply])).toEqual(["release"]);
	});

	it("is empty when the turn named no skill, or the last message is a user prompt", () => {
		expect(turnSkills([prompt("old", "agent"), user, reply])).toEqual([]);
		expect(turnSkills([prompt("old", "agent"), user])).toEqual([]);
	});
});
