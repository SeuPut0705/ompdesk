/**
 * A stop is part of a call's verdict: the same transcript read by the work card (its row's `stoppedAt`) and by the
 * work board's check row (`lastCheck`, the turn's outcome) must say the same of a check the stop cut off.
 */
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../../../shared/rpc-types";
import { createToolsStore } from "../../../stores/tools";
import { lastCheck } from "../../layout/work-board/session-board";
import { buildHistoryRows, callStops } from "../chat-stream-utils";
import { workVerdict } from "./work-checks";
import { workOutcomes } from "./work-view";

const call = (id: string, command: string, at: number): AgentMessage => ({
	role: "assistant",
	content: [{ type: "toolCall", id, name: "bash", arguments: { command } }],
	stopReason: "toolUse",
	timestamp: at,
});
const answer = (id: string, text: string, at: number, exitCode?: number): AgentMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "bash",
	content: [{ type: "text", text }],
	details: exitCode === undefined ? {} : { exitCode },
	isError: true,
	timestamp: at,
});
// Stock's empty aborted reply after a tool stop (agent-loop.ts): the run's own end.
const stop = (at: number): AgentMessage => ({
	role: "assistant",
	content: [],
	stopReason: "aborted",
	errorMessage: "Request was aborted",
	timestamp: at,
});

describe("a check a stop cut off", () => {
	// The user stopped a build: stock killed it, its exit 130 arrived with the stop.
	const messages: AgentMessage[] = [
		{ role: "user", content: [{ type: "text", text: "build it" }], timestamp: 1_000 },
		call("build", "bun run build", 2_000),
		answer("build", "vite building…\n\nCommand exited with code 130", 9_000, 130),
		stop(9_200),
	];

	it("is interrupted on the card and never a failed check on the board", () => {
		const [row] = buildHistoryRows(messages, "compact").filter(item => item.kind === "process");
		if (row?.kind !== "process") throw new Error("no work row");
		expect(row.stoppedAt).toBe(9_200);
		const tools = createToolsStore();
		tools.getState().hydrateMessages(messages);
		const entries = [...tools.getState().finishedTools];
		const stops = callStops(messages);
		const card = workOutcomes(
			entries.map(([toolCallId, entry]) => ({ entry, toolCallId })),
			row.stoppedAt,
			"/repo",
		);
		expect(card.commands.map(command => command.status)).toEqual(["interrupted"]);
		expect(workVerdict(card.commands, "/repo").error).toBeUndefined();
		const turn = workOutcomes(
			entries.map(([toolCallId, entry]) => ({ entry, toolCallId, stoppedAt: stops.get(toolCallId) })),
			undefined,
			"/repo",
		);
		expect(turn.commands.map(command => command.status)).toEqual(["interrupted"]);
		expect(lastCheck(entries, turn.commands, "/repo", new Map(), stops)?.state).not.toBe("failed");
	});

	it("builds each call's stops again only when a stop arrives, and hands back the same map meanwhile", () => {
		const stopped = callStops(messages);
		expect([...stopped.values()]).toEqual([9_200]);
		const grown = [
			...messages,
			{ role: "user", content: [{ type: "text", text: "again" }], timestamp: 10_000 } as AgentMessage,
			call("lint", "bunx biome check src", 11_000),
		];
		expect(callStops(grown)).toBe(stopped);
		expect(callStops([...grown])).toBe(stopped);
		const again = [...grown, answer("lint", "x\n\n[Command aborted]", 12_000), stop(12_100)];
		const next = callStops(again);
		expect(next).not.toBe(stopped);
		expect([...next.entries()]).toEqual([
			["build", 9_200],
			["lint", 12_100],
		]);
	});
});
