import { describe, expect, it } from "vitest";
import { findPromptHookViolations } from "./lint-prompt-sections.mjs";

describe("lint-prompt-sections", () => {
	it("flags a before_agent_start handler that adds to the system prompt itself", () => {
		const source = `
pi.on("before_agent_start", event => ({ systemPrompt: [...event.systemPrompt, "mine"] }));
pi.on("before_agent_start", (event, ctx) => {
	const systemPrompt = [...event.systemPrompt, note(ctx)];
	return { systemPrompt };
});
`;
		expect(findPromptHookViolations(source).map(hit => hit.line)).toEqual([2, 3]);
	});

	it("accepts handlers that leave the prompt alone, other events and a prompt-section-ok escape", () => {
		const source = `
pi.on("before_agent_start", async (event, ctx) => ({ message: await recall(event.prompt, ctx) }));
pi.on("before_agent_start", () => { settle(); return undefined; });
pi.on("session_start", () => ({ systemPrompt: [] }));
pi.on("before_agent_start", () => ({ systemPrompt: ["x"] })); // prompt-section-ok: replaces the whole prompt on purpose
`;
		expect(findPromptHookViolations(source)).toEqual([]);
	});
});
