import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../../shared/rpc-types";
import type { Row } from "./chat-stream-utils";
import { desktopRowEstimate, estimateRowSize, RowSizeLearner } from "./transcript-row-estimate";

const message = (role: "user" | "assistant", text: string): Row => ({
	kind: "message",
	message: { role, content: [{ type: "text", text }], timestamp: 1 } as AgentMessage,
});
const process = { kind: "process", messages: [] } as unknown as Row;
const IPHONE = { width: 393, phone: true };
const IPAD = { width: 834, phone: false };

describe("estimateRowSize", () => {
	it("keeps the desktop's guesses", () => {
		for (const row of [message("user", "x".repeat(500)), message("assistant", "short"), process])
			expect(estimateRowSize(row, null, () => 999)).toBe(desktopRowEstimate(row));
		expect(desktopRowEstimate(message("assistant", "short"))).toBe(144);
		expect(desktopRowEstimate(process)).toBe(136);
	});

	// Heights measured on an iPhone 15 (393 px): the built app's long session and the dev harness's transcript.
	it.each([
		["a one-line reply", message("assistant", "Long session answer 249"), 40],
		["a two-line reply", message("assistant", "a".repeat(136)), 60],
		[
			"four short paragraphs",
			message("assistant", ["a".repeat(60), "b".repeat(70), "c".repeat(60), "d".repeat(63)].join("\n\n")),
			142,
		],
		["a one-line prompt", message("user", "Long session turn 000"), 64],
		["a two-line prompt", message("user", "p".repeat(103)), 84],
	])("guesses %s on a phone within 8 px of what it measures", (_name, row, measured) => {
		expect(Math.abs(estimateRowSize(row, IPHONE) - measured)).toBeLessThanOrEqual(8);
	});

	it("guesses a work card from what the transcript's work cards measured, once three did", () => {
		const learned = new RowSizeLearner();
		expect(estimateRowSize(process, IPHONE, kind => learned.mean(kind))).toBe(136);
		for (const size of [73, 76, 73]) learned.add("process", size);
		expect(estimateRowSize(process, IPHONE, kind => learned.mean(kind))).toBe(74);
	});

	it("guesses a tablet's rows, messages by role too, from what they measured", () => {
		const learned = new RowSizeLearner();
		const reply = message("assistant", "Long session answer 249");
		expect(estimateRowSize(reply, IPAD, key => learned.mean(key))).toBe(144);
		for (let i = 0; i < 3; i++) {
			learned.add("message:assistant", 61);
			learned.add("message:user", 85);
		}
		expect(estimateRowSize(reply, IPAD, key => learned.mean(key))).toBe(61);
		expect(estimateRowSize(message("user", "hi"), IPAD, key => learned.mean(key))).toBe(85);
	});

	it("counts a fenced code block's lines without wrapping them", () => {
		const code = message("assistant", ["Here:", "```ts", "x".repeat(400), "y", "```"].join("\n"));
		expect(estimateRowSize(code, IPHONE)).toBe(20 + 20 * 3 + 8 + 40);
	});
});
