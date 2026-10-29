/**
 * A tab's subagent transcripts are read on from a byte cursor, a settled agent read since it settled is not asked
 * again, and a hidden window asks nothing until it shows (a paired device re-read whole journals at every replay and
 * view: 11.5 MB in one minute of the host's traffic line, 28 Oct 2026).
 */
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage, RpcCommand, RpcResponse } from "../../shared/rpc-types";
import { createSubagentTranscripts } from "./subagent-transcripts";
import { createSubagentsStore, settledMark } from "./subagents";

const { document, window, Event } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, { document, window, Event });

const message = (text: string, timestamp: number): AgentMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	timestamp,
});

/** A journal as stock's reader answers it: the whole lines past `fromByte`, a line counted as 10 bytes. */
function journal(lines: AgentMessage[]) {
	const asked: RpcCommand[] = [];
	const command = vi.fn(async (rpc: RpcCommand, _timeoutMs?: number): Promise<RpcResponse> => {
		asked.push(rpc);
		const from = "fromByte" in rpc && typeof rpc.fromByte === "number" ? rpc.fromByte : 0;
		const reset = from > lines.length * 10;
		const start = reset ? 0 : from / 10;
		return {
			type: "response",
			command: rpc.type,
			success: true,
			data: { messages: lines.slice(start), nextByte: lines.length * 10, reset },
		};
	});
	return { command, asked, lines };
}

function setVisibility(state: "visible" | "hidden"): void {
	Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
	document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => setVisibility("visible"));

describe("subagent transcripts", () => {
	it("reads on from where the last read stopped, and keeps the same array when nothing is new", async () => {
		const { command, asked, lines } = journal([message("one", 1), message("two", 2)]);
		const transcripts = createSubagentTranscripts(command);
		const first = await transcripts.read("Scout");
		expect(first.messages).toEqual(lines);
		lines.push(message("three", 3));
		const second = await transcripts.read("Scout");
		expect(second.incoming).toEqual([message("three", 3)]);
		expect(second.messages).toEqual(lines);
		const third = await transcripts.read("Scout");
		expect(third.messages).toBe(second.messages);
		expect(asked.map(rpc => ("fromByte" in rpc ? rpc.fromByte : undefined))).toEqual([0, 20, 30]);
		// Each read carries the command's own budget, as the RPC client's reads do.
		expect(command.mock.calls[0]?.[1]).toBe(30_000);
	});

	it("asks nothing for a settled agent read since it settled, until it runs and settles again", async () => {
		const { command, asked, lines } = journal([message("done", 1)]);
		const transcripts = createSubagentTranscripts(command);
		await transcripts.read("Scout", { settled: "completed:100" });
		const again = await transcripts.read("Scout", { settled: "completed:100" });
		expect(again.messages).toEqual(lines);
		expect(asked).toHaveLength(1);
		// A follow-up run wrote more and settled at another time.
		lines.push(message("follow-up", 2));
		await transcripts.read("Scout", { settled: "completed:200" });
		expect(transcripts.held("Scout")?.messages).toEqual(lines);
		expect(asked).toHaveLength(2);
	});

	it("starts over when the journal is shorter than the cursor", async () => {
		const { command, lines } = journal([message("one", 1), message("two", 2)]);
		const transcripts = createSubagentTranscripts(command);
		await transcripts.read("Scout");
		lines.splice(0, 2, message("rewritten", 5));
		const read = await transcripts.read("Scout");
		expect(read.messages).toEqual([message("rewritten", 5)]);
	});

	it("reads the session's artifacts dir once stock's registry forgot the agent, and stays there", async () => {
		const asked: string[] = [];
		const transcripts = createSubagentTranscripts(async rpc => {
			asked.push(rpc.type);
			return rpc.type === "get_subagent_messages"
				? { type: "response", command: rpc.type, success: false, error: "Unknown subagent" }
				: { type: "response", command: rpc.type, success: true, data: { messages: [], nextByte: 0 } };
		});
		await transcripts.read("Scout");
		await transcripts.read("Scout");
		expect(asked).toEqual(["get_subagent_messages", "get_subagent_transcript", "get_subagent_transcript"]);
	});

	it("waits while the window is hidden and reads once when it shows", async () => {
		const { command, asked } = journal([message("one", 1)]);
		const transcripts = createSubagentTranscripts(command);
		setVisibility("hidden");
		const reads = [transcripts.read("Scout"), transcripts.read("Scout")];
		await Promise.resolve();
		expect(asked).toHaveLength(0);
		setVisibility("visible");
		await Promise.all(reads);
		// The second read starts where the first stopped.
		expect(asked.map(rpc => ("fromByte" in rpc ? rpc.fromByte : undefined))).toEqual([0, 10]);
	});

	it("a lane's replay at completion reads only what the journal gained while the agent ran", async () => {
		const { command, asked, lines } = journal([message("one", 1)]);
		const store = createSubagentsStore(command);
		const node = (status: "running" | "completed", toolCount: number) => ({
			id: "Scout",
			index: 0,
			agent: "scout",
			status,
			lastUpdate: toolCount,
			progress: { id: "Scout", status, toolCount } as never,
		});
		store.getState().setSnapshots([node("running", 1)]);
		await store.getState().hydrateSurface("Scout");
		lines.push(message("two", 2));
		store.getState().setSnapshots([node("completed", 2)]);
		await store.getState().hydrateSurface("Scout");
		expect(asked.map(rpc => ("fromByte" in rpc ? rpc.fromByte : undefined))).toEqual([0, 10]);
		expect(store.getState().transcripts.held("Scout")?.messages).toEqual(lines);
		expect(settledMark(store.getState().subagents.get("Scout"))).toBe("completed:2");
	});
});
