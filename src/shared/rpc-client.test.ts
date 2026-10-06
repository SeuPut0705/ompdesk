import { describe, expect, it } from "vitest";
import { createSessionRpcClient } from "./rpc-client";
import type { RpcResponse } from "./rpc-types";

describe("model RPC timeouts", () => {
	it("gives model switches enough time for provider/session reconfiguration", async () => {
		const calls: Array<{ type: string; timeoutMs: number | undefined }> = [];
		const response: RpcResponse = { type: "response", command: "set_model", success: true };
		const rpc = createSessionRpcClient(async (command, timeoutMs) => {
			calls.push({ type: command.type, timeoutMs });
			return response;
		});

		await rpc.setModel("openai", "gpt-test");
		await rpc.cycleModel();

		expect(calls).toEqual([
			{ type: "set_model", timeoutMs: 30_000 },
			{ type: "cycle_model", timeoutMs: 30_000 },
		]);
	});

	it("reassembles paged transcripts without requesting the oversized snapshot", async () => {
		const messages = [
			{ role: "user" as const, content: "first", timestamp: 1 },
			{ role: "assistant" as const, content: [{ type: "text" as const, text: "second" }], timestamp: 2 },
		];
		const calls: string[] = [];
		const rpc = createSessionRpcClient(async command => {
			calls.push(command.type);
			if (command.type !== "get_transcript_page")
				return { type: "response", command: command.type, success: false, error: "unexpected command" };
			return {
				type: "response",
				command: "get_transcript_page",
				success: true,
				data:
					command.cursor === undefined
						? { messages: [messages[0]], totalMessages: messages.length, nextCursor: "next" }
						: { messages: [messages[1]], totalMessages: messages.length },
			};
		});

		expect(await rpc.getTranscript()).toEqual({
			type: "response",
			command: "get_transcript",
			success: true,
			data: { messages },
		});
		expect(calls).toEqual(["get_transcript_page", "get_transcript_page"]);
	});
});
