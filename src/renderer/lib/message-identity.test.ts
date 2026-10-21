import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../shared/rpc-types";
import { sameDelivery } from "./message-identity";

describe("sameDelivery", () => {
	it("matches a live delivery to its page copy, which leaves out the thinking signature", () => {
		const live = {
			role: "assistant",
			timestamp: 5,
			content: [
				{ type: "thinking", thinking: "plan", thinkingSignature: "sig" },
				{ type: "text", text: "done" },
			],
		} as unknown as AgentMessage;
		const page = {
			role: "assistant",
			timestamp: 5,
			content: [
				{ type: "thinking", thinking: "plan" },
				{ type: "text", text: "done" },
			],
		} as unknown as AgentMessage;
		expect(sameDelivery(live, page)).toBe(true);
		const other = { ...page, content: [{ type: "thinking", thinking: "other" }] } as unknown as AgentMessage;
		expect(sameDelivery(live, other)).toBe(false);
	});
});
