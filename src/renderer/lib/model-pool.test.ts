/**
 * Model pool contract: the bridge's pure half (normalization, journal restore,
 * the orchestration instruction) and the GUI's member edits, subagent → member
 * matching and per-model usage split.
 */
import { describe, expect, it } from "vitest";
import {
	buildPoolInstruction,
	POOL_ENTRY_TYPE,
	poolFromEntries,
	roleHint,
} from "../../../resources/gui-bridge/modes/pool-core";
import {
	MAX_POOL_MEMBERS,
	normalizePool,
	POOL_ROLE_HINTS,
	POOL_ROLES,
} from "../../../resources/gui-bridge/pool-contracts";
import type { RpcModelPoolState, SubagentSnapshot } from "../../shared/rpc-types";
import {
	addPoolMember,
	EMPTY_MODEL_POOL,
	modelSelector,
	poolMemberFor,
	removePoolMember,
	setPoolMemberRole,
	usageByModel,
} from "./model-pool";

const haiku = { selector: "anthropic/claude-haiku-4-5", name: "Claude Haiku 4.5", role: "explore" };
const sonnet = { selector: "openai/gpt-5.2", name: "GPT-5.2", role: "reasoning" };
const pool: RpcModelPoolState = { enabled: true, members: [haiku, sonnet] };

function subagent(id: string, resolvedModel: string | undefined, tokens: number, cost = 0): SubagentSnapshot {
	return {
		id,
		index: 0,
		agent: "task",
		status: "completed",
		lastUpdate: 0,
		progress: {
			index: 0,
			id,
			agent: "task",
			agentSource: "bundled",
			status: "completed",
			task: "t",
			recentTools: [],
			recentOutput: [],
			toolCount: 0,
			requests: 2,
			tokens,
			cost,
			durationMs: 0,
			resolvedModel,
		},
	};
}

describe("bridge pool-core", () => {
	it("offers each preset role in its display order", () => {
		expect(Object.keys(POOL_ROLE_HINTS)).toEqual(POOL_ROLES);
	});

	it("normalizes untrusted input: valid selectors only, first one wins, defaults filled", () => {
		expect(
			normalizePool({
				enabled: true,
				members: [
					{ selector: " anthropic/claude-haiku-4-5 ", name: "  Claude\nHaiku ", role: "" },
					{ selector: "anthropic/claude-haiku-4-5", name: "dup", role: "review" },
					{ selector: "no-provider", name: "x" },
					{ selector: "with space/model" },
					null,
					{ selector: "openai/gpt-5.2" },
				],
			}),
		).toEqual({
			enabled: true,
			members: [
				{ selector: "anthropic/claude-haiku-4-5", name: "Claude Haiku", role: "general" },
				{ selector: "openai/gpt-5.2", name: "openai/gpt-5.2", role: "general" },
			],
		});
		expect(normalizePool("nope")).toEqual({ enabled: false, members: [] });
		// Enabled with nobody in it is off.
		expect(normalizePool({ enabled: true, members: [] }).enabled).toBe(false);
	});

	it("caps the pool size", () => {
		const members = Array.from({ length: 12 }, (_, i) => ({ selector: `p/m${i}`, name: `m${i}` }));
		expect(normalizePool({ enabled: true, members }).members).toHaveLength(MAX_POOL_MEMBERS);
	});

	it("restores the latest pool entry on the branch and ignores other entries", () => {
		const entries = [
			{ type: "message" },
			{ type: "custom", customType: POOL_ENTRY_TYPE, data: pool },
			{ type: "custom", customType: "other", data: { enabled: false } },
			{ type: "custom", customType: POOL_ENTRY_TYPE, data: { ...pool, enabled: false } },
			{ type: "message" },
		];
		expect(poolFromEntries(entries)).toEqual({ ...pool, enabled: false });
		expect(poolFromEntries(entries.slice(0, 3))).toEqual(pool);
		expect(poolFromEntries([{ type: "message" }])).toEqual({ enabled: false, members: [] });
	});

	it("builds the orchestration instruction only for an enabled pool of two or more", () => {
		expect(buildPoolInstruction({ ...pool, enabled: false })).toBeUndefined();
		expect(buildPoolInstruction({ enabled: true, members: [haiku] })).toBeUndefined();

		const instruction = buildPoolInstruction({
			enabled: true,
			members: [haiku, { ...sonnet, role: "Korean copy editing" }],
		});
		expect(instruction).toBeDefined();
		expect(instruction?.startsWith("<model-pool>")).toBe(true);
		expect(instruction?.endsWith("</model-pool>")).toBe(true);
		expect(instruction).toContain(
			"- `anthropic/claude-haiku-4-5` (Claude Haiku 4.5): fast, cheap exploration, search and lookups",
		);
		expect(instruction).toContain("- `openai/gpt-5.2` (GPT-5.2): Korean copy editing");
		// The wire field the routing rides on, parallel dispatch, and cross-checking.
		expect(instruction).toContain("setting each item's `model` to that member's selector exactly as listed");
		expect(instruction).toContain("in parallel in a single `task` call");
		expect(instruction).toContain("have a different pool model review");
		// A member whose model errors (404 etc.) gets its subtask reassigned, not retried.
		expect(instruction).toContain("re-dispatch the same subtask to another pool member");
	});

	it("maps preset roles to hints and passes free text through", () => {
		expect(roleHint("coding")).toBe("writing and editing code");
		expect(roleHint("translation")).toBe("translation");
		expect(roleHint("constructor")).toBe("constructor");
	});
});

describe("GUI pool helpers", () => {
	it("adds models once, as general workers, up to the cap", () => {
		const one = addPoolMember(EMPTY_MODEL_POOL, { selector: haiku.selector, name: haiku.name });
		expect(one.members).toEqual([{ selector: haiku.selector, name: haiku.name, role: "general" }]);
		expect(addPoolMember(one, { selector: haiku.selector, name: "again" })).toBe(one);

		let full: RpcModelPoolState = EMPTY_MODEL_POOL;
		for (let i = 0; i < MAX_POOL_MEMBERS + 2; i++) full = addPoolMember(full, { selector: `p/m${i}`, name: `m${i}` });
		expect(full.members).toHaveLength(MAX_POOL_MEMBERS);
	});

	it("switches the pool off when removal leaves fewer than two models", () => {
		const three: RpcModelPoolState = { enabled: true, members: [haiku, sonnet, { ...haiku, selector: "x/y" }] };
		expect(removePoolMember(three, "x/y")).toEqual(pool);
		expect(removePoolMember(pool, sonnet.selector)).toEqual({ enabled: false, members: [haiku] });
	});

	it("sets one member's role", () => {
		expect(setPoolMemberRole(pool, sonnet.selector, "review").members).toEqual([
			haiku,
			{ ...sonnet, role: "review" },
		]);
	});

	it("matches a subagent's resolved model to its pool member, thinking suffix included", () => {
		expect(modelSelector({ provider: "openai", id: "gpt-5.2" })).toBe("openai/gpt-5.2");
		expect(poolMemberFor(pool, "openai/gpt-5.2")).toBe(sonnet);
		expect(poolMemberFor(pool, "openai/gpt-5.2:high")).toBe(sonnet);
		expect(poolMemberFor(pool, "openai/gpt-5.2-mini")).toBeUndefined();
		expect(poolMemberFor({ ...pool, enabled: false }, "openai/gpt-5.2")).toBeUndefined();
		expect(poolMemberFor(pool, undefined)).toBeUndefined();
	});

	it("splits session usage by model: main agent row plus subagents grouped by model", () => {
		const rows = usageByModel(
			{ model: "openai/gpt-5.2", requests: 3, tokens: 1000, cost: 0.5 },
			[
				subagent("a", "anthropic/claude-haiku-4-5", 2000, 0.1),
				subagent("b", "anthropic/claude-haiku-4-5", 1000, 0.05),
				subagent("c", "openai/gpt-5.2:high", 1000, 0.3),
				subagent("d", undefined, 999),
			],
			pool,
		);
		expect(rows.map(row => [row.model, row.main, row.agents, row.tokens, row.member?.name])).toEqual([
			["anthropic/claude-haiku-4-5", false, 2, 3000, "Claude Haiku 4.5"],
			["openai/gpt-5.2", true, 0, 1000, "GPT-5.2"],
			["openai/gpt-5.2:high", false, 1, 1000, "GPT-5.2"],
		]);
		expect(rows[0].share).toBeCloseTo(0.6);
		expect(rows[0].cost).toBeCloseTo(0.15);
		expect(rows[0].requests).toBe(4);
		expect(usageByModel(null, [], null)).toEqual([]);
	});
});
