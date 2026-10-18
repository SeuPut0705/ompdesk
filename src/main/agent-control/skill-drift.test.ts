/**
 * The built-in `ompdesk` skill (resources/omp-builtin/skills/ompdesk/) teaches the host tools defined in tools.ts.
 * Renaming a tool or a parameter, or adding one, must update the skill in the same change:
 * - every tool name the skill mentions exists, and the kernel (SKILL.md) names every tool;
 * - every parameter (and `ompdesk_session_open`'s per-session fields) appears somewhere in the skill;
 * - every backticked word on a kernel tool line is a parameter or enum value of that tool;
 * - every skill:// link resolves to a file of the skill, and the kernel stays at most 60 lines.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_CONTROL_DEFINITIONS } from "./tools";

const ROOT = path.join(__dirname, "../../../resources/omp-builtin/skills/ompdesk");
const kernel = readFileSync(path.join(ROOT, "SKILL.md"), "utf8");
const references = readdirSync(path.join(ROOT, "references")).map(name =>
	readFileSync(path.join(ROOT, "references", name), "utf8"),
);
const all = [kernel, ...references].join("\n");

interface Schema {
	properties?: Record<string, Schema>;
	items?: Schema;
	enum?: readonly string[];
}

/** Parameter names and enum values of one tool; `sessions` items with fields (open's fan-out) count as parameters. */
function vocabulary(schema: Schema): { params: Set<string>; values: Set<string> } {
	const params = new Set<string>();
	const values = new Set<string>();
	for (const [name, property] of Object.entries(schema.properties ?? {})) {
		params.add(name);
		for (const value of property.enum ?? property.items?.enum ?? []) values.add(value);
		if (name === "sessions" && property.items?.properties) {
			const nested = vocabulary(property.items);
			for (const param of nested.params) params.add(param);
			for (const value of nested.values) values.add(value);
		}
	}
	return { params, values };
}

const tools = new Map(AGENT_CONTROL_DEFINITIONS.map(tool => [tool.name, vocabulary(tool.parameters as Schema)]));

describe("ompdesk skill matches the host tools", () => {
	it("names only defined tools, and the kernel names every one", () => {
		const mentioned = new Set(all.match(/\bompdesk_[a-z_]+/g));
		expect([...mentioned].filter(name => !tools.has(name))).toEqual([]);
		expect([...tools.keys()].filter(name => !kernel.includes(`\`${name}\``))).toEqual([]);
	});

	it("documents every parameter", () => {
		const missing = [...tools].flatMap(([name, { params }]) =>
			[...params].filter(param => !all.includes(`\`${param}\``)).map(param => `${name}.${param}`),
		);
		expect(missing).toEqual([]);
	});

	it("uses on each kernel tool line only that tool's parameters and values", () => {
		const unknown: string[] = [];
		for (const line of kernel.split("\n").filter(text => text.startsWith("- `ompdesk_"))) {
			// A line may describe two tools; each backticked word belongs to the tool named before it.
			let current: string | undefined;
			for (const [, word] of line.matchAll(/`([^`]+)`/g)) {
				if (word === undefined) continue;
				if (tools.has(word)) {
					current = word;
					continue;
				}
				const vocab = current ? tools.get(current) : undefined;
				if (!vocab?.params.has(word) && !vocab?.values.has(word)) unknown.push(`${current}: ${word}`);
			}
		}
		expect(unknown).toEqual([]);
	});

	it("links only files the skill ships and keeps the kernel short", () => {
		const links = [...all.matchAll(/skill:\/\/ompdesk\/([\w./-]+\.md)/g)].map(match => match[1] ?? "");
		expect(links.length).toBeGreaterThan(0);
		expect(links.filter(link => !existsSync(path.join(ROOT, link)))).toEqual([]);
		expect(kernel.split("\n").length).toBeLessThanOrEqual(60);
	});
});
