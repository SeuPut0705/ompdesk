import { describe, expect, it } from "vitest";
import { AGENT_CONTROL_TOOLS, isAgentControlTool } from "../../shared/agent-control";
import { AGENT_CONTROL_DEFINITIONS, ARGS } from "./tools";

describe("OMPdesk control tool definitions", () => {
	it("registers one definition per tool, each with a JSON schema stock accepts and a strict argument parser", () => {
		const names = Object.values(AGENT_CONTROL_TOOLS);
		expect(AGENT_CONTROL_DEFINITIONS.map(definition => definition.name).sort()).toEqual([...names].sort());
		for (const definition of AGENT_CONTROL_DEFINITIONS) {
			expect(definition.parameters).toMatchObject({ type: "object", additionalProperties: false });
			expect(definition.description.length).toBeGreaterThan(20);
			expect(isAgentControlTool(definition.name)).toBe(true);
			expect(ARGS[definition.name as keyof typeof ARGS]).toBeDefined();
		}
	});

	it("offers no tool for accounts, settings, permissions or approvals-by-default", () => {
		for (const name of Object.values(AGENT_CONTROL_TOOLS))
			expect(name).not.toMatch(/account|setting|permission|login|token|pref|yolo/i);
		expect(isAgentControlTool("ompdesk_settings_set")).toBe(false);
		expect(isAgentControlTool("gui_terminal_read")).toBe(false);
	});

	it("keeps destructive actions behind named arguments of the stop tool, never their own tool", () => {
		const names = Object.values(AGENT_CONTROL_TOOLS);
		expect(names.filter(name => /delete|remove|close|kill/.test(name))).toEqual([]);
		expect(ARGS[AGENT_CONTROL_TOOLS.stop].parse({ session: "abcd", delete: true })).toMatchObject({ delete: true });
		expect(() => ARGS[AGENT_CONTROL_TOOLS.stop].parse({ session: "abcd", force: true })).toThrow();
	});

	it("parses fan-out, worktree and multi-result arguments and rejects mixtures", () => {
		const open = ARGS[AGENT_CONTROL_TOOLS.open];
		expect(
			open.parse({
				sessions: [
					{ message: "a", worktree: true },
					{ message: "b", worktree: { branch: "x/y", base: "HEAD" } },
				],
			}),
		).toBeTruthy();
		expect(() => open.parse({ message: "a", sessions: [{ message: "b" }] })).toThrow();
		expect(() => open.parse({ sessions: [] })).toThrow();
		expect(() => open.parse({ sessions: Array.from({ length: 5 }, () => ({ message: "x" })) })).toThrow();
		const result = ARGS[AGENT_CONTROL_TOOLS.result];
		expect(result.parse({ sessions: ["a1b2", "c3d4"], wait: true, until: "any" })).toBeTruthy();
		expect(() => result.parse({ session: "a1b2", sessions: ["c3d4"] })).toThrow();
		expect(() => result.parse({ until: "all" })).toThrow();
	});
});
