/**
 * `fallback-chains.ts`: how keys read, edits that keep every other key as read, and `chainKeyFor`, the renderer copy of
 * stock `resolveRetryFallbackChainKey` (AGENTS.md: a copy is pinned to stock). On a machine with omp the precedence
 * cases also run through the installed stock function, after its own `expandDefaultRetryFallbackChains`.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	type ChainContext,
	chainKeyFor,
	chainRows,
	moveEntry,
	removeEntry,
	selectorKind,
	serializeChains,
	withChain,
	withoutChain,
} from "./fallback-chains";

const stockFile = path.join(
	os.homedir(),
	".bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/session/retry-fallback-chains.ts",
);
const stockRoles = path.join(
	os.homedir(),
	".bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/config/model-roles.ts",
);

const FABLE = "anthropic/claude-fable-5-2";
const OPUS = "anthropic/claude-opus-5-5";
const SOL = "openai-codex/gpt-6.1-sol";
const OWNER = { "anthropic/*": [SOL], "openai-codex/*": [FABLE] };
const ROLES = { default: FABLE, task: OPUS };
const PROVIDERS = ["anthropic", "openai-codex", "openrouter"];

interface Case {
	name: string;
	chains: Record<string, unknown>;
	roles: Record<string, string>;
	kind?: string[];
	selector: string;
	hint?: string;
	expected: string | undefined;
}

const CASES: Case[] = [
	{
		name: "owner: Fable on the default role",
		chains: OWNER,
		roles: ROLES,
		selector: FABLE,
		hint: "default",
		expected: "anthropic/*",
	},
	{
		name: "owner: Opus on the task role",
		chains: OWNER,
		roles: ROLES,
		selector: OPUS,
		hint: "task",
		expected: "anthropic/*",
	},
	{ name: "owner: GPT SOL, no role", chains: OWNER, roles: ROLES, selector: SOL, expected: "openai-codex/*" },
	{
		name: "an exact model row wins over its provider row",
		chains: { ...OWNER, [FABLE]: [OPUS, SOL] },
		roles: ROLES,
		selector: FABLE,
		hint: "default",
		expected: FABLE,
	},
	{
		name: "the provider row still takes the other models",
		chains: { ...OWNER, [FABLE]: [OPUS, SOL] },
		roles: ROLES,
		selector: OPUS,
		hint: "task",
		expected: "anthropic/*",
	},
	{
		name: "an id-prefix wildcard beats the plain provider row under its prefix",
		chains: { "openrouter/*": ["a/b"], "openrouter/google/*": ["c/d"] },
		roles: {},
		selector: "openrouter/google/gemini-x",
		expected: "openrouter/google/*",
	},
	{
		name: "and leaves other ids to the plain row",
		chains: { "openrouter/*": ["a/b"], "openrouter/google/*": ["c/d"] },
		roles: {},
		selector: "openrouter/anthropic/claude",
		expected: "openrouter/*",
	},
	{
		name: "a role row by its hint",
		chains: { task: [SOL] },
		roles: ROLES,
		selector: OPUS,
		hint: "task",
		expected: "task",
	},
	{ name: "a role row by its model", chains: { task: [SOL] }, roles: ROLES, selector: OPUS, expected: "task" },
	{
		name: "a role row does not take another role's model",
		chains: { task: [SOL] },
		roles: ROLES,
		selector: FABLE,
		hint: "default",
		expected: undefined,
	},
	{
		name: "default's list reaches a role by expansion",
		chains: { default: [SOL] },
		roles: ROLES,
		selector: OPUS,
		hint: "task",
		expected: "default",
	},
	{
		name: "default's list for a model no role uses",
		chains: { default: [SOL] },
		roles: ROLES,
		selector: "openai-codex/gpt-5",
		expected: "default",
	},
	{
		name: "default first among roles sharing a model",
		chains: { slow: [SOL], default: ["x/y"] },
		roles: { default: OPUS, slow: OPUS },
		selector: OPUS,
		expected: "default",
	},
	{
		name: "an empty default list switches nothing",
		chains: { default: [] },
		roles: ROLES,
		selector: SOL,
		expected: undefined,
	},
	{
		name: "an empty default list still reaches a role",
		chains: { default: [] },
		roles: ROLES,
		selector: OPUS,
		hint: "task",
		expected: "default",
	},
	{
		name: "a kind role never takes a chain by its model",
		chains: { web: [SOL] },
		roles: { web: FABLE },
		kind: ["web"],
		selector: FABLE,
		expected: undefined,
	},
	{
		name: "a model key stock cannot read still owns its model",
		chains: { [FABLE]: "oops" },
		roles: ROLES,
		selector: FABLE,
		hint: "default",
		expected: FABLE,
	},
];

function context(item: Case): ChainContext {
	return {
		chains: item.chains,
		roleModels: item.roles,
		kindRoles: new Set(item.kind ?? []),
		isProvider: provider => PROVIDERS.includes(provider),
	};
}

describe("chainKeyFor", () => {
	it.each(CASES)("$name", item => {
		expect(chainKeyFor(context(item), item.selector, item.hint)).toBe(item.expected);
	});

	it("cannot tell when a model key carries a thinking level for this model", () => {
		const item: Case = {
			name: "",
			chains: { [`${FABLE}:high`]: [OPUS] },
			roles: ROLES,
			selector: FABLE,
			expected: undefined,
		};
		expect(chainKeyFor(context(item), FABLE, "default")).toBeNull();
	});

	it.skipIf(!existsSync(stockFile))("answers as the installed stock resolver does", () => {
		// Stock modules need Bun's runtime; vitest runs on Node, so a Bun child evaluates them. A role stock reached by
		// expanding `default` reads as `default`, the key a person edits.
		const script = `
import { expandDefaultRetryFallbackChains, resolveRetryFallbackChainKey } from ${JSON.stringify(stockFile)};
import { isKindRole } from ${JSON.stringify(stockRoles)};
const cases = ${JSON.stringify(CASES)};
const providers = ${JSON.stringify(PROVIDERS)};
console.log(JSON.stringify(cases.map(item => {
	const kind = (item.kind ?? []).every(role => isKindRole(role));
	const chains = expandDefaultRetryFallbackChains(item.chains, Object.keys(item.roles));
	const context = {
		chains,
		getModelRole: role => item.roles[role],
		modelLookup: { find: () => undefined, hasProvider: provider => providers.includes(provider) },
	};
	const key = resolveRetryFallbackChainKey(context, item.selector, undefined, item.hint);
	return { kind, key: key === undefined ? null : Object.hasOwn(item.chains, key) ? key : "default" };
})));`;
		const stock = JSON.parse(execFileSync("bun", ["-e", script], { encoding: "utf8" })) as {
			kind: boolean;
			key: string | null;
		}[];
		expect(stock.every(answer => answer.kind)).toBe(true);
		expect(CASES.map(item => chainKeyFor(context(item), item.selector, item.hint) ?? null)).toEqual(
			stock.map(answer => answer.key),
		);
	});
});

describe("keys and entries", () => {
	it("reads a model, a service, a role, default, and shows the rest as written", () => {
		expect(selectorKind(FABLE)).toEqual({ kind: "model", provider: "anthropic", id: "claude-fable-5-2" });
		expect(selectorKind("anthropic/*")).toEqual({ kind: "provider", provider: "anthropic" });
		expect(selectorKind("task")).toEqual({ kind: "role", role: "task" });
		expect(selectorKind("default")).toEqual({ kind: "default" });
		for (const verbatim of ["openrouter/google/*", `${FABLE}:high`, "anthropic/claude-*", "/x", ""]) {
			expect(selectorKind(verbatim), verbatim).toEqual({ kind: "verbatim" });
		}
	});

	it("lists every key, and a value that is not a list of strings as unreadable", () => {
		expect(chainRows({ ...OWNER, broken: "x", mixed: ["a/b", 3] })).toEqual([
			{ key: "anthropic/*", chain: [SOL] },
			{ key: "openai-codex/*", chain: [FABLE] },
			{ key: "broken", chain: null },
			{ key: "mixed", chain: null },
		]);
	});
});

describe("edits", () => {
	const record = { "openrouter/google/*": ["google/*", `${OPUS}:low`], ...OWNER, odd: { keep: [1, null] } };

	it("sets one key, appends a new one last, and keeps every other key byte for byte", () => {
		const next = withChain(record, FABLE, [OPUS, SOL]);
		expect(Object.keys(next)).toEqual(["openrouter/google/*", "anthropic/*", "openai-codex/*", "odd", FABLE]);
		expect(JSON.stringify(withoutChain(next, FABLE))).toBe(JSON.stringify(record));
		expect(JSON.stringify(withChain(record, "anthropic/*", [OPUS]))).toBe(
			JSON.stringify({ ...record, "anthropic/*": [OPUS] }),
		);
	});

	it("moves, removes and unsets", () => {
		expect(moveEntry([OPUS, SOL], 1, -1)).toEqual([SOL, OPUS]);
		expect(moveEntry([OPUS, SOL], 0, -1)).toEqual([OPUS, SOL]);
		expect(moveEntry([OPUS, SOL], 1, 1)).toEqual([OPUS, SOL]);
		expect(removeEntry([OPUS, SOL, OPUS], 2)).toEqual([OPUS, SOL]);
		expect(serializeChains({})).toBeUndefined();
		expect(serializeChains(OWNER)).toEqual(OWNER);
	});
});
