/**
 * The bridge's copy of the session-title rule (memory-recall-contracts.ts `taskTitle`) gives what the shared rule
 * gives (src/shared/memory-prompt.ts `promptTitle`, the one ai-memory's extension and main use). The copy exists
 * because the bridge ships outside the app's bundle, where src/shared is not; this test keeps the two in step.
 */
import { describe, expect, it } from "vitest";
import { taskTitle } from "../../resources/gui-bridge/modes/memory-recall-contracts";
import { isJunkTitle, promptTitle } from "../shared/memory-prompt";

const CASES = [
	"Complete assignment thoroughly:",
	"Complete assignment thoroughly:\n\n# Fix the parser\nmore",
	'<ompdesk-agent-message from="오케스트레이터">',
	'<ompdesk-agent-message from="x">\nTitle: Jev 비교\nCompare the judges.\n</ompdesk-agent-message>',
	'<ompdesk-agent-message from="x">\nComplete assignment thoroughly:\n\n- 첫 줄 작업\n</ompdesk-agent-message>',
	"You are a subagent spawned by another session.\nTitle: 파서 고치기",
	"Title: a very long title ".repeat(10),
	"```ts\nconst a = 1;\n```\n테일스케일로만 연결해줘",
	"> quoted line\n---\n",
	"  plain prompt with   spaces  ",
	"",
	"x".repeat(200),
];

describe("taskTitle", () => {
	it("answers exactly what the shared promptTitle answers, junk titles included", () => {
		for (const raw of CASES) {
			const shared = promptTitle(raw);
			expect(taskTitle(raw), JSON.stringify(raw)).toBe(shared && !isJunkTitle(shared) ? shared : undefined);
		}
	});
});
