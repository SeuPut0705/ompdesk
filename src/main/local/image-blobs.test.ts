/**
 * Subagent transcripts come straight from their JSONL, where stock persisted
 * every image as a `blob:sha256:` reference. The local handlers swap each one
 * for the bytes the tab's bridge reads from stock's blob store, so a read
 * screenshot draws; a reference whose blob is gone stays for the renderer to
 * show as unavailable.
 */
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../shared/rpc-types";
import { localHandlerFor } from "./index";
import type { BridgeClient, LocalCommandContext } from "./types";

const STORED = `blob:sha256:${"a".repeat(64)}`;
const COLLECTED = `blob:sha256:${"b".repeat(64)}`;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6VQAAAAASUVORK5CYII=";

/** A stock read of a PNG as its subagent journal persists it (captured from a real session). */
function readResult(path: string, data: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: `read-${path}`,
		toolName: "read",
		content: [
			{ type: "text", text: "Read image file [image/png]" },
			{ type: "image", data, mimeType: "image/png" },
		],
		details: { fileSize: 120207, meta: { source: { type: "path", value: path } }, mediaPath: path },
		isError: false,
		timestamp: 1,
	};
}

/** The `get_subagent_messages` result fields this test reads. */
interface SubagentTranscript {
	messages: AgentMessage[];
	entries: unknown[];
	nextByte: number;
}

function transcript(): SubagentTranscript {
	return {
		messages: [
			readResult("/tmp/ReloadTruth-real/scenarios/ko-group-1.png", STORED),
			readResult("/tmp/final2/real/scenarios/ko-group-1.png", COLLECTED),
			// The same picture read twice is fetched once.
			readResult("/tmp/ReloadTruth-real/scenarios/ko-group-1-again.png", STORED),
			{ role: "user", content: "a message without images", timestamp: 2 },
		],
		entries: [],
		nextByte: 42,
	};
}

function context(reply: () => unknown) {
	const stock: Array<Record<string, unknown>> = [];
	const bridged: Array<{ method: string; params: unknown }> = [];
	const bridge: BridgeClient = {
		connected: true,
		onEvent: () => () => {},
		request: async <T>(method: string, params?: unknown): Promise<T> => {
			bridged.push({ method, params });
			if (method === "read_image_blob") {
				const { ref } = params as { ref: string };
				return { data: ref === STORED ? PNG : null } as T;
			}
			return reply() as T;
		},
	};
	const ctx: LocalCommandContext = {
		cwd: "/tmp",
		omp: { bin: "omp", version: "18.6.1", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
		bridge,
		send: async <T>(command: Record<string, unknown>): Promise<T> => {
			stock.push(command);
			return reply() as T;
		},
	};
	return { ctx, stock, bridged };
}

function imageData(message: AgentMessage | undefined): unknown {
	const content = message?.content;
	return Array.isArray(content) ? content.find(block => block.type === "image")?.data : undefined;
}

describe("subagent transcript images", () => {
	it("restores stock's blob references from the blob store on get_subagent_messages", async () => {
		const handler = localHandlerFor("get_subagent_messages");
		if (!handler) throw new Error("get_subagent_messages is not handled locally");
		const { ctx, stock, bridged } = context(transcript);
		const result = (await handler(
			{ type: "get_subagent_messages", id: "gui-7", subagentId: "ReloadTruth" },
			ctx,
		)) as SubagentTranscript;

		// Stock still answers the read; only the image bytes are filled in.
		expect(stock).toEqual([{ type: "get_subagent_messages", subagentId: "ReloadTruth" }]);
		expect(result.nextByte).toBe(42);
		expect(imageData(result.messages[0])).toBe(PNG);
		expect(imageData(result.messages[2])).toBe(PNG);
		// A collected blob stays a reference: the renderer shows that file as unavailable.
		expect(imageData(result.messages[1])).toBe(COLLECTED);
		expect(bridged).toEqual([
			{ method: "read_image_blob", params: { ref: STORED } },
			{ method: "read_image_blob", params: { ref: COLLECTED } },
		]);
	});

	it("restores them on the bridge's get_subagent_transcript too", async () => {
		const handler = localHandlerFor("get_subagent_transcript");
		if (!handler) throw new Error("get_subagent_transcript is not handled locally");
		const { ctx, bridged } = context(transcript);
		const result = (await handler(
			{ type: "get_subagent_transcript", id: "gui-8", subagentId: "ReloadTruth", fromByte: 0 },
			ctx,
		)) as SubagentTranscript;

		expect(bridged[0]).toEqual({
			method: "get_subagent_transcript",
			params: { subagentId: "ReloadTruth", fromByte: 0 },
		});
		expect(imageData(result.messages[0])).toBe(PNG);
	});
});
