import { describe, expect, it } from "vitest";
import { AGENT_CONTROL_TOOLS, isAgentControlTool } from "../../shared/agent-control";
import { AGENT_CONTROL_DEFINITIONS, ARGS, looseArgs } from "./tools";

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

describe("the schema states the bounds the parser enforces", () => {
	interface Property {
		maximum?: number;
	}
	const properties = (name: string): Record<string, Property> => {
		const definition = AGENT_CONTROL_DEFINITIONS.find(entry => entry.name === name);
		if (!definition) throw new Error(`no tool ${name}`);
		// The tools' parameters are JSON schemas of an object with properties (tools.test.ts above parses them as such).
		const schema = definition.parameters as { properties: Record<string, Property> };
		return schema.properties;
	};
	it("gives the page size of ompdesk_session_read as the schema's maximum", () => {
		const read = ARGS[AGENT_CONTROL_TOOLS.read];
		const most = properties(AGENT_CONTROL_TOOLS.read).limit?.maximum as number;
		expect(read.parse({ session: "abcd", limit: most })).toMatchObject({ limit: most });
		expect(() => read.parse({ session: "abcd", limit: most + 1 })).toThrow();
	});

	it("passes any ref a repository resolves on as worktree.base", () => {
		expect(ARGS[AGENT_CONTROL_TOOLS.open].parse({ worktree: { base: "origin/release-1.2" } })).toMatchObject({
			worktree: { base: "origin/release-1.2" },
		});
	});
});

describe("arguments a model wrote as JSON text", () => {
	const open = (raw: unknown) => ARGS[AGENT_CONTROL_TOOLS.open].parse(looseArgs(AGENT_CONTROL_TOOLS.open, raw));

	it("reads a boolean, an object and an array written as text where the schema takes no string", () => {
		expect(open({ message: "go", worktree: "true", throwaway: "false" })).toMatchObject({
			worktree: true,
			throwaway: false,
		});
		expect(open({ message: "go", worktree: '{"base":"main"}' })).toMatchObject({ worktree: { base: "main" } });
		expect(open({ sessions: '[{"message":"a","worktree":"true"},{"message":"b"}]' }).sessions).toEqual([
			{ message: "a", worktree: true },
			{ message: "b" },
		]);
		const read = ARGS[AGENT_CONTROL_TOOLS.read].parse(
			looseArgs(AGENT_CONTROL_TOOLS.read, { session: "abcd", limit: "5" }),
		);
		expect(read.limit).toBe(5);
		const app = ARGS[AGENT_CONTROL_TOOLS.app].parse(
			looseArgs(AGENT_CONTROL_TOOLS.app, { action: "settings.theme", args: '{"value":"nord"}' }),
		);
		expect(app.args).toEqual({ value: "nord" });
	});

	it("leaves text fields as typed, and still refuses text that spells no value of the field", () => {
		// A message, a session id and a model that read as JSON stay the text the model wrote.
		expect(open({ message: "true", model: "42" })).toMatchObject({ message: "true", model: "42" });
		expect(
			ARGS[AGENT_CONTROL_TOOLS.send].parse(
				looseArgs(AGENT_CONTROL_TOOLS.send, { session: "1234", message: '{"a":1}' }),
			),
		).toMatchObject({ session: "1234", message: '{"a":1}' });
		expect(() => open({ message: "go", worktree: "yes please" })).toThrow();
		expect(() => open({ message: "go", worktree: "{broken" })).toThrow();
	});
});

describe("attachments of ompdesk_session_send and ompdesk_report", () => {
	interface ItemSchema {
		items: { properties: { image: { minimum: number }; path: object }; additionalProperties: boolean };
		maxItems?: number;
		description: string;
	}
	const schemaOf = (name: string): ItemSchema => {
		const definition = AGENT_CONTROL_DEFINITIONS.find(entry => entry.name === name);
		if (!definition) throw new Error(`no tool ${name}`);
		const schema = definition.parameters as { properties: Record<string, ItemSchema> };
		return schema.properties.attachments as ItemSchema;
	};

	it("states in both schemas what the parser enforces: an item is a path or a picture number from 1, any number, 10 MiB each", () => {
		for (const name of [AGENT_CONTROL_TOOLS.send, AGENT_CONTROL_TOOLS.report]) {
			const schema = schemaOf(name);
			expect(schema.maxItems).toBeUndefined();
			expect(schema.items.additionalProperties).toBe(false);
			expect(schema.description).toContain("10 MiB");
			const parse = (attachments: unknown[]) =>
				name === AGENT_CONTROL_TOOLS.send
					? ARGS[AGENT_CONTROL_TOOLS.send].parse({ session: "abcd", message: "m", attachments })
					: ARGS[AGENT_CONTROL_TOOLS.report].parse({ kind: "note", text: "t", attachments });
			const lowest = schema.items.properties.image.minimum;
			expect(parse([{ image: lowest }]).attachments).toEqual([{ image: lowest }]);
			expect(() => parse([{ image: lowest - 1 }])).toThrow();
			expect(parse([{ path: "/a/b.pdf" }, { image: 2 }]).attachments).toHaveLength(2);
			expect(parse(Array.from({ length: 200 }, (_, index) => ({ image: index + 1 }))).attachments).toHaveLength(200);
		}
	});

	it("takes exactly one of path and image per item", () => {
		const send = (attachments: unknown[]) =>
			ARGS[AGENT_CONTROL_TOOLS.send].parse({ session: "abcd", message: "m", attachments });
		expect(() => send([{}])).toThrow();
		expect(() => send([{ path: "/a", image: 1 }])).toThrow();
		expect(() => send([{ path: "" }])).toThrow();
		expect(() => send([{ image: 1.5 }])).toThrow();
		expect(() => send([{ url: "https://x" }])).toThrow();
	});

	it("reads a list a model wrote as JSON text", () => {
		const parsed = ARGS[AGENT_CONTROL_TOOLS.send].parse(
			looseArgs(AGENT_CONTROL_TOOLS.send, {
				session: "abcd",
				message: "m",
				attachments: '[{"image":"1"},{"path":"/a/b.pdf"}]',
			}),
		);
		expect(parsed.attachments).toEqual([{ image: 1 }, { path: "/a/b.pdf" }]);
	});
});
