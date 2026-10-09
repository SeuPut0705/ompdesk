import { describe, expect, it } from "vitest";
import {
	type AgentAccountPools,
	clearAgentPool,
	parseAgentAccountPools,
	poolFor,
	poolIncludes,
	restrictedProviders,
	serializeAgentAccountPools,
	togglePoolAccount,
} from "./account-pools";

const WORK = "email:work@example.com|org:org-1";
const HOME = "email:home@example.com";

describe("parseAgentAccountPools", () => {
	it("reads an absent or null value as no pools", () => {
		expect(parseAgentAccountPools(undefined)).toEqual({});
		expect(parseAgentAccountPools(null)).toEqual({});
	});

	it("keeps agent → provider → identity keys, and null agent entries that clear a lower layer", () => {
		const value = { task: { anthropic: [WORK, HOME] }, scout: null };
		expect(parseAgentAccountPools(value)).toEqual(value);
	});

	it("refuses shapes omp itself would not load, instead of dropping parts of them", () => {
		expect(parseAgentAccountPools([])).toBeNull();
		expect(parseAgentAccountPools({ task: ["anthropic"] })).toBeNull();
		expect(parseAgentAccountPools({ task: { anthropic: WORK } })).toBeNull();
		expect(parseAgentAccountPools({ task: { anthropic: [""] } })).toBeNull();
		expect(parseAgentAccountPools({ task: { anthropic: [` ${WORK}`] } })).toBeNull();
	});
});

describe("identity-key matching", () => {
	const pools: AgentAccountPools = { task: { anthropic: [WORK] }, scout: null };

	it("matches a key only exactly, under the same agent and provider", () => {
		expect(poolIncludes(pools, "task", "anthropic", WORK)).toBe(true);
		// The org qualifier is part of the key: the bare email names a different subscription.
		expect(poolIncludes(pools, "task", "anthropic", "email:work@example.com")).toBe(false);
		expect(poolIncludes(pools, "task", "anthropic", WORK.toUpperCase())).toBe(false);
		expect(poolIncludes(pools, "task", "openai-codex", WORK)).toBe(false);
		expect(poolIncludes(pools, "reviewer", "anthropic", WORK)).toBe(false);
	});

	it("tells an unrestricted provider (undefined) from a pooled one", () => {
		expect(poolFor(pools, "task", "anthropic")).toEqual([WORK]);
		expect(poolFor(pools, "task", "openai-codex")).toBeUndefined();
		expect(poolFor(pools, "scout", "anthropic")).toBeUndefined();
		expect(restrictedProviders(pools, "task")).toEqual(["anthropic"]);
		expect(restrictedProviders(pools, "scout")).toEqual([]);
	});

	it("never reads inherited object members as agents or providers", () => {
		expect(poolFor(pools, "toString", "anthropic")).toBeUndefined();
		expect(poolFor(pools, "task", "constructor")).toBeUndefined();
	});
});

describe("togglePoolAccount", () => {
	it("adds a key once, creating the agent and provider entries", () => {
		const added = togglePoolAccount({}, "task", "anthropic", WORK, true);
		expect(added).toEqual({ task: { anthropic: [WORK] } });
		expect(togglePoolAccount(added, "task", "anthropic", WORK, true)).toEqual(added);
		expect(togglePoolAccount(added, "task", "anthropic", HOME, true)).toEqual({ task: { anthropic: [WORK, HOME] } });
	});

	it("drops the provider with its last key, since an empty list would allow no account", () => {
		const pools: AgentAccountPools = { task: { anthropic: [WORK], "openai-codex": [HOME] } };
		expect(togglePoolAccount(pools, "task", "anthropic", WORK, false)).toEqual({ task: { "openai-codex": [HOME] } });
	});

	it("drops the agent once nothing is left, so it is unrestricted again", () => {
		const pools: AgentAccountPools = { task: { anthropic: [WORK] }, scout: { anthropic: [HOME] } };
		expect(togglePoolAccount(pools, "task", "anthropic", WORK, false)).toEqual({ scout: { anthropic: [HOME] } });
	});

	it("replaces a null agent entry when that agent gets a pool, and leaves the input untouched", () => {
		const pools: AgentAccountPools = { scout: null };
		expect(togglePoolAccount(pools, "scout", "anthropic", HOME, true)).toEqual({ scout: { anthropic: [HOME] } });
		expect(pools).toEqual({ scout: null });
	});
});

describe("serialization", () => {
	it("writes the map as is while any agent has a pool", () => {
		const pools: AgentAccountPools = { task: { anthropic: [WORK] }, scout: null };
		expect(serializeAgentAccountPools(pools)).toBe(pools);
		expect(JSON.parse(JSON.stringify(serializeAgentAccountPools(pools)))).toEqual(pools);
	});

	it("removes the override (undefined) once no agent is left", () => {
		const cleared = clearAgentPool({ task: { anthropic: [WORK] } }, "task");
		expect(cleared).toEqual({});
		expect(serializeAgentAccountPools(cleared)).toBeUndefined();
	});
});
