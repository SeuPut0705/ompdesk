/**
 * gui-bridge output style (resources/gui-bridge/modes/output-style.ts): the
 * `before_agent_start` hook appends the chosen style's instruction, follows
 * `output_style_set` without reinstalling, adds nothing for `default`, and
 * refuses unknown styles.
 */
import { afterEach, describe, expect, it } from "vitest";
import { install, methods, type OutputStyleHost, setOutputStyle } from "../../resources/gui-bridge/modes/output-style";
import { OUTPUT_STYLE_IDS, outputStyleInstruction } from "../../resources/gui-bridge/output-style-contracts";

type Handler = Parameters<OutputStyleHost["on"]>[1];

/** The hook's own behaviour does not depend on the session; omp always passes one. */
const context: Parameters<Handler>[1] = { sessionManager: { getBranch: () => [] }, agent: { kind: "main" } };

function installedHook(): (event: Parameters<Handler>[0]) => ReturnType<Handler> {
	const handlers: Handler[] = [];
	install({ on: (_event, handler) => handlers.push(handler) });
	expect(handlers).toHaveLength(1);
	return event => handlers[0]?.(event, context);
}

afterEach(() => {
	setOutputStyle({ style: "default" });
});

describe("gui-bridge output style", () => {
	it("leaves the stock prompt untouched by default", () => {
		expect(installedHook()({ systemPrompt: ["base"] })).toBeUndefined();
		expect(outputStyleInstruction("default")).toBeUndefined();
	});

	it("appends the chosen style after the prompt omp built and follows a change", async () => {
		const hook = installedHook();
		expect(await methods.output_style_set({ style: "concise" })).toEqual({ style: "concise" });
		const concise = hook({ systemPrompt: ["base", "tools"] })?.systemPrompt;
		expect(concise?.slice(0, 2)).toEqual(["base", "tools"]);
		expect(concise?.[2]).toContain("<output-style>");
		expect(concise?.[2]).toContain("Keep replies short.");
		await methods.output_style_set({ style: "detailed" });
		expect(hook({ systemPrompt: ["base"] })?.systemPrompt[1]).toContain("Give thorough replies.");
		expect(await methods.output_style_get()).toEqual({ style: "detailed" });
	});

	it("gives every non-default style its own instruction that never limits the work", () => {
		const instructions = OUTPUT_STYLE_IDS.filter(id => id !== "default").map(id => outputStyleInstruction(id));
		expect(new Set(instructions).size).toBe(instructions.length);
		for (const text of instructions) expect(text).toContain("never limits the work you do");
	});

	it("refuses an unknown style and keeps the current one", async () => {
		await methods.output_style_set({ style: "minimal" });
		await expect(methods.output_style_set({ style: "verbose" })).rejects.toThrow("output_style_set needs");
		expect(await methods.output_style_get()).toEqual({ style: "minimal" });
	});
});
