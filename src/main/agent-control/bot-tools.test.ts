import { describe, expect, it } from "vitest";
import { botSection } from "../../../resources/gui-bridge/agent-control";
import { BOT_REFERENCE_TOOLS, BOT_TOOL_REFERENCE, botToolReference } from "./bot-tools";
import { AGENT_CONTROL_DEFINITIONS } from "./tools";

interface Schema {
	properties?: Record<string, unknown>;
	required?: string[];
}

function schemaOf(name: string): Schema {
	const definition = AGENT_CONTROL_DEFINITIONS.find(entry => entry.name === name);
	if (!definition) throw new Error(`no tool ${name}`);
	// Every control tool's parameters are a JSON-schema object (tools.test.ts checks `type: "object"`).
	const schema = definition.parameters as Schema;
	return schema;
}

const lineOf = (name: string): string =>
	BOT_TOOL_REFERENCE.split("\n").find(line => line.startsWith(`- ${name} `)) ?? "";

describe("the bot's tool reference", () => {
	it("has one line per tool it uses most, naming every argument the tool's schema has, required ones without ?", () => {
		expect(BOT_TOOL_REFERENCE.split("\n")).toHaveLength(BOT_REFERENCE_TOOLS.length);
		for (const name of BOT_REFERENCE_TOOLS) {
			const schema = schemaOf(name);
			const line = lineOf(name);
			expect(line, name).not.toBe("");
			for (const argument of Object.keys(schema.properties ?? {})) {
				const marker = schema.required?.includes(argument) === true ? "" : "?";
				expect(line, `${name} ${argument}`).toMatch(
					new RegExp(`(\\| |, )${argument}${marker === "?" ? "\\?" : ""}: `),
				);
			}
		}
	});

	it("shows types, enum values, nested fields and which action takes a field", () => {
		expect(lineOf("ompdesk_session_send")).toContain("delivery?: follow_up|steer");
		expect(lineOf("ompdesk_session_result")).toContain("sessions?: string[]");
		expect(lineOf("ompdesk_session_open")).toContain("worktree?: bool|{branch?: string, base?: string}");
		expect(lineOf("ompdesk_bot")).toContain("question?: string [decide]");
		expect(lineOf("ompdesk_bot")).toContain("text?: string [duty_add, remember]");
	});

	it("refuses a name that is no control tool", () => {
		expect(() => botToolReference(["ompdesk_nothing"])).toThrow(/no control tool/);
	});

	it("reaches the prompt section when main sends it, and stays short of the docs it replaces", () => {
		const section = botSection("", "Bot", { tools: BOT_TOOL_REFERENCE });
		expect(section).toContain(BOT_TOOL_REFERENCE);
		expect(BOT_TOOL_REFERENCE.length).toBeLessThan(3_500);
	});
});
