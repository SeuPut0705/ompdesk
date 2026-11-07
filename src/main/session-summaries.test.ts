import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { RESTART_SUBAGENTS_MESSAGE } from "../../resources/gui-bridge/restart-core";
import type { RpcResponse, SubagentFrame, SubagentSnapshot } from "../shared/rpc-types";
import {
	applySummaryChange,
	runningAgentCount,
	type SummaryDelta,
	type VersionedSummaries,
} from "../shared/session-summary";
import { SessionSummaries, type SummaryFacts, type SummarySource } from "./session-summaries";

/** The builder's debounce, run when the test says. */
function manualTimers() {
	let pending: (() => void) | null = null;
	return {
		setTimeout: (fn: () => void) => {
			pending = fn;
			return 1;
		},
		clearTimeout: () => {
			pending = null;
		},
		now: () => 1_000,
		flush: () => {
			const fn = pending;
			pending = null;
			fn?.();
		},
	};
}

/** An omp as the builder sees it: its frames and statuses, and a registry `get_subagents` reads. */
class FakeOmp extends EventEmitter {
	registry: SubagentSnapshot[] = [];
	readonly rpcClient = {
		command: async (): Promise<RpcResponse> => ({
			type: "response",
			command: "get_subagents",
			success: true,
			data: { subagents: this.registry },
		}),
	};
	started(id: string, description = `Title: ${id}`): void {
		this.emit("subagentFrame", {
			type: "subagent_lifecycle",
			payload: { id, agent: "task", agentSource: "bundled", status: "started", index: 0, description },
		} satisfies SubagentFrame);
	}
	ended(id: string, status: "completed" | "failed" | "aborted" = "completed"): void {
		this.emit("subagentFrame", {
			type: "subagent_lifecycle",
			payload: { id, agent: "task", agentSource: "bundled", status, index: 0 },
		} satisfies SubagentFrame);
	}
	status(status: string): void {
		this.emit("status", { status });
	}
}

function world() {
	const timers = manualTimers();
	const sources: SummarySource[] = [];
	const summaries = new SessionSummaries(() => sources, timers);
	const deltas: SummaryDelta[] = [];
	summaries.onChange(delta => deltas.push(delta));
	const tab = (facts: Partial<SummaryFacts> & { sessionPath: string }) => {
		const omp = new FakeOmp();
		const state: SummaryFacts = { tabId: facts.sessionPath, cwd: "/w", kind: "agent", status: "ready", ...facts };
		sources.push({ sidecar: omp, facts: () => state });
		summaries.track(omp);
		return { omp, state };
	};
	const settle = async () => {
		await Promise.resolve();
		await Promise.resolve();
		timers.flush();
	};
	return { summaries, deltas, tab, settle };
}

const of = (copy: VersionedSummaries, path: string) => copy.sessions.find(session => session.sessionPath === path);

describe("SessionSummaries", () => {
	it("counts a tab's subagents from its omp's frames, up and down, whatever window shows it", async () => {
		const { summaries, tab, settle } = world();
		const { omp, state } = tab({ sessionPath: "/s/a.jsonl" });
		state.status = "running";
		omp.started("explore");
		omp.started("nested");
		await settle();
		expect(runningAgentCount(of(summaries.current(), "/s/a.jsonl"))).toBe(2);
		expect(of(summaries.current(), "/s/a.jsonl")?.agents.map(agent => agent.title)).toEqual(["explore", "nested"]);
		omp.ended("explore");
		await settle();
		expect(runningAgentCount(of(summaries.current(), "/s/a.jsonl"))).toBe(1);
		omp.ended("nested", "failed");
		await settle();
		// A failed one stays a row (it needs a look) but no longer runs.
		expect(of(summaries.current(), "/s/a.jsonl")?.agents.map(agent => agent.status)).toEqual(["failed"]);
		expect(runningAgentCount(of(summaries.current(), "/s/a.jsonl"))).toBe(0);
	});

	it("drops the subagents of an omp that died, and counts what the next one runs, revived ones included", async () => {
		const { summaries, tab, settle } = world();
		const { omp } = tab({ sessionPath: "/s/a.jsonl" });
		omp.started("one");
		omp.started("two");
		await settle();
		expect(runningAgentCount(of(summaries.current(), "/s/a.jsonl"))).toBe(2);
		omp.status("restarting");
		await settle();
		expect(of(summaries.current(), "/s/a.jsonl")?.agents).toEqual([]);
		// The new omp revived one before anyone asked it for frames: its registry says so.
		omp.registry = [{ id: "two", index: 1, agent: "task", status: "running", lastUpdate: 5 }];
		omp.status("ready");
		await settle();
		expect(runningAgentCount(of(summaries.current(), "/s/a.jsonl"))).toBe(1);
		omp.started("three");
		await settle();
		expect(runningAgentCount(of(summaries.current(), "/s/a.jsonl"))).toBe(2);
	});

	// 2 Nov 2026, the 0.94.0 → 0.94.1 update restart: each revived subagent ended at once and stock said `failed`.
	it("lists no agent a restart ended, by the restart note and its delivery; any other failure stays a row", async () => {
		const { summaries, tab, settle } = world();
		const { omp } = tab({ sessionPath: "/s/a.jsonl" });
		const custom = (message: Record<string, unknown>) =>
			omp.emit("events", [
				{ type: "message_end", message: { role: "custom", display: true, timestamp: 1, ...message } },
			]);
		const delivery = (id: string, output: string) =>
			custom({
				customType: "async-result",
				content: `<system-notice>\nBackground job ${id} has failed.\n<task-result id="${id}" agent="task" status="failed (exit 1)" duration="353ms">\n<output>\n${output}\n</output>\n</task-result>\n</system-notice>`,
				details: { jobs: [{ jobId: id, agentId: id, type: "task", status: "failed", durationMs: 353 }] },
			});
		omp.started("cut");
		omp.started("bad");
		omp.started("later");
		custom({
			customType: RESTART_SUBAGENTS_MESSAGE,
			content: "These background agents you started are working again",
			details: { jobs: [], subagents: [{ id: "cut", doing: "bash: probing the stream" }, { id: "bad" }] },
		});
		omp.ended("cut", "failed");
		omp.ended("bad", "failed");
		omp.ended("later", "failed");
		delivery("cut", "SYSTEM WARNING: Subagent ended without a final message.");
		delivery("bad", "Error: the build failed");
		delivery("later", "SYSTEM WARNING: Subagent ended without a final message.");
		await settle();
		// "cut" ended with the restart's empty message; "bad" failed for real; "later" was named by no restart note.
		expect(of(summaries.current(), "/s/a.jsonl")?.agents.map(agent => agent.id)).toEqual(["bad", "later"]);
	});

	it("reads a registry row that claims to run with no turn in flight as waiting, not running", async () => {
		const { summaries, tab, settle } = world();
		const { omp } = tab({ sessionPath: "/s/a.jsonl" });
		omp.registry = [{ id: "stuck", index: 0, agent: "task", status: "running", live: false, lastUpdate: 1 }];
		omp.status("ready");
		await settle();
		expect(of(summaries.current(), "/s/a.jsonl")?.agents.map(agent => agent.status)).toEqual(["stale"]);
		expect(runningAgentCount(of(summaries.current(), "/s/a.jsonl"))).toBe(0);
	});

	it("gives one row per session file: a tab that asks outranks one that runs", async () => {
		const { summaries, tab, settle } = world();
		tab({ sessionPath: "/s/a.jsonl", status: "running" });
		tab({ sessionPath: "/s/a.jsonl", status: "ready", ask: "approval", openFor: "Phone" });
		await settle();
		expect(summaries.current().sessions).toHaveLength(1);
		expect(of(summaries.current(), "/s/a.jsonl")).toMatchObject({ ask: "approval", openFor: "Phone" });
	});

	it("hands on each burst as one change that a holder of the last version applies to reach the same summaries", async () => {
		const { summaries, deltas, tab, settle } = world();
		const { omp, state } = tab({ sessionPath: "/s/a.jsonl" });
		const held = summaries.current();
		state.status = "running";
		omp.started("x");
		omp.started("y");
		state.title = "Renamed";
		summaries.changed();
		await settle();
		expect(deltas).toHaveLength(1);
		const next = applySummaryChange(held, deltas[0] as SummaryDelta);
		expect(next).toEqual(summaries.current());
		expect(of(next as VersionedSummaries, "/s/a.jsonl")?.title).toBe("Renamed");
		// Nothing changed: nothing goes out.
		summaries.changed();
		await settle();
		expect(deltas).toHaveLength(1);
	});

	it("never lets a holder that missed a change apply the next one: it reads the whole set, and is right again", async () => {
		const { summaries, deltas, tab, settle } = world();
		const { omp } = tab({ sessionPath: "/s/a.jsonl" });
		const stale = summaries.current();
		omp.started("x");
		await settle();
		omp.started("y");
		await settle();
		expect(deltas).toHaveLength(2);
		// This holder lost the first change (a hidden page, a dropped link): the second does not apply on its copy.
		expect(applySummaryChange(stale, deltas[1] as SummaryDelta)).toBeNull();
		const whole = applySummaryChange(stale, summaries.current());
		expect(runningAgentCount(of(whole as VersionedSummaries, "/s/a.jsonl"))).toBe(2);
	});

	it("leaves a closed tab out, and says so as a removal", async () => {
		const sources: SummarySource[] = [];
		const timers = manualTimers();
		const summaries = new SessionSummaries(() => sources, timers);
		const deltas: SummaryDelta[] = [];
		summaries.onChange(delta => deltas.push(delta));
		const omp = new FakeOmp();
		sources.push({
			sidecar: omp,
			facts: () => ({ sessionPath: "/s/a.jsonl", tabId: "t", cwd: "/w", kind: "agent", status: "ready" }),
		});
		summaries.track(omp);
		summaries.current();
		sources.length = 0;
		summaries.changed();
		timers.flush();
		expect(deltas.at(-1)?.remove).toEqual(["/s/a.jsonl"]);
		expect(summaries.current().sessions).toEqual([]);
	});
});
