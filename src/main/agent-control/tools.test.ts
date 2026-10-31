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

	it("takes any number of sessions, criteria and answers in one call", () => {
		const ids = Array.from({ length: 50 }, (_, index) => `sess${index}`);
		expect(ARGS[AGENT_CONTROL_TOOLS.result].parse({ sessions: ids }).sessions).toHaveLength(50);
		const criteria = Array.from({ length: 40 }, (_, index) => `criterion ${index}`);
		expect(ARGS[AGENT_CONTROL_TOOLS.compare].parse({ sessions: ids, criteria }).criteria).toHaveLength(40);
		expect(
			ARGS[AGENT_CONTROL_TOOLS.open].parse({ sessions: ids.map(() => ({ message: "go" })) }).sessions,
		).toHaveLength(50);
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
		expect(open.parse({ sessions: Array.from({ length: 12 }, () => ({ message: "x" })) })).toBeTruthy();
		const result = ARGS[AGENT_CONTROL_TOOLS.result];
		expect(result.parse({ sessions: ["a1b2", "c3d4"], wait: true, until: "any" })).toBeTruthy();
		expect(() => result.parse({ session: "a1b2", sessions: ["c3d4"] })).toThrow();
		expect(() => result.parse({ until: "all" })).toThrow();
	});
});

describe("ompdesk_autopilot arguments", () => {
	const args = ARGS[AGENT_CONTROL_TOOLS.autopilot];

	it("parses each action and rejects another action's fields", () => {
		expect(args.parse({ action: "start" })).toEqual({ action: "start" });
		expect(
			args.parse({
				action: "start",
				ship: "push",
				branch: { kind: "existing", name: "dev" },
				advanced: { limits: { cycles: 3 } },
			}),
		).toBeTruthy();
		expect(args.parse({ action: "stop", session: "abcd", now: true })).toMatchObject({ now: true });
		expect(() => args.parse({ action: "status" })).toThrow();
		expect(() => args.parse({ action: "start", session: "abcd" })).toThrow();
		expect(() => args.parse({ action: "start", ship: "force" })).toThrow();
		expect(() => args.parse({ action: "start", branch: { kind: "existing" } })).toThrow();
		// No cap on child sessions: `parallel` is no argument any more.
		expect(() => args.parse({ action: "start", advanced: { parallel: 2 } })).toThrow();
		expect(() => args.parse({ action: "start", advanced: { limits: { usd: -1 } } })).toThrow();
	});
});

describe("ompdesk_bot arguments", () => {
	const args = ARGS[AGENT_CONTROL_TOOLS.bot];

	it("parses each action and rejects another action's fields", () => {
		expect(args.parse({ action: "desk" })).toEqual({ action: "desk" });
		expect(
			args.parse({ action: "decide", question: "  Ship it? ", options: ["Yes", "No"], context: "CI is green" }),
		).toEqual({
			action: "decide",
			question: "Ship it?",
			options: ["Yes", "No"],
			context: "CI is green",
		});
		expect(args.parse({ action: "duty_add", text: "Check the nightly build" })).toMatchObject({ action: "duty_add" });
		expect(args.parse({ action: "duty_remove", id: "0a1b2c3d" })).toMatchObject({ id: "0a1b2c3d" });
		expect(() => args.parse({ action: "decide" })).toThrow();
		expect(() =>
			args.parse({ action: "decide", question: "Pick", options: Array.from({ length: 7 }, (_, i) => `${i}`) }),
		).toThrow();
		expect(() => args.parse({ action: "duty_add" })).toThrow();
		expect(() => args.parse({ action: "duty_add", text: "x".repeat(301) })).toThrow();
		expect(() => args.parse({ action: "duty_remove" })).toThrow();
		expect(() => args.parse({ action: "desk", id: "x" })).toThrow();
		expect(() => args.parse({ action: "answer", id: "x" })).toThrow();
		expect(args.parse({ action: "remember", text: " Deploys on Fridays " })).toEqual({
			action: "remember",
			text: "Deploys on Fridays",
		});
		expect(() => args.parse({ action: "remember", text: "x".repeat(301) })).toThrow();
		expect(args.parse({ action: "identity", avatar_file: "/tmp/a.png" })).toMatchObject({
			avatar_file: "/tmp/a.png",
		});
		expect(() => args.parse({ action: "identity", text: "x" })).toThrow();
		expect(args.parse({ action: "visited", limit: 5 })).toEqual({ action: "visited", limit: 5 });
		expect(() => args.parse({ action: "activity", limit: 0 })).toThrow();
	});
});
