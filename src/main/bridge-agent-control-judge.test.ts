/**
 * `agent_control.judge` (resources/gui-bridge/agent-control.ts) on a fake session and stock: which model judges
 * (stock's advisor chain, then slow, a family other than the main model's preferred), what it reports back, and what
 * the usage ledger records. No model call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { methods } from "../../resources/gui-bridge/agent-control";
import { crossFamily, JUDGE_ROLES, modelFamily } from "../../resources/gui-bridge/agent-control-judge-core";
import {
	type NextPromptStock,
	resetNextPromptState,
	setNextPromptStock,
} from "../../resources/gui-bridge/modes/next-prompt-engine";

interface FakeModel {
	provider: string;
	id: string;
	identity?: { class?: string };
}

const model = (provider: string, id: string, family?: string): FakeModel => ({
	provider,
	id,
	...(family === undefined ? {} : { identity: { class: family } }),
});

const CLAUDE_A = model("anthropic", "claude-a", "anthropic");
const CLAUDE_B = model("anthropic", "claude-b", "anthropic");
const GPT = model("openai", "gpt-judge", "openai");
const GEMINI = model("google", "gemini-judge", "google");
const MAIN = model("anthropic", "claude-main", "anthropic");

interface Call {
	model: FakeModel;
	options: { signal: AbortSignal; maxTokens?: number; temperature?: number };
}

interface World {
	calls: Call[];
	usage: Array<Record<string, unknown>>;
	chains: Record<string, FakeModel[]>;
	keys: Set<string>;
	main: { current: FakeModel | undefined };
	judge: (params: unknown) => Promise<unknown>;
}

const ref = (m: FakeModel) => `${m.provider}/${m.id}`;

function build(): World {
	const calls: Call[] = [];
	const usage: Array<Record<string, unknown>> = [];
	const world: World = {
		calls,
		usage,
		chains: {},
		keys: new Set<string>(),
		main: { current: MAIN },
		judge: params => {
			const handler = methods["agent_control.judge"];
			if (!handler) throw new Error("agent_control.judge is not registered");
			return handler(params, { session: () => session, context: () => ({}) } as never);
		},
	};
	const session = {
		sessionId: "sess-1",
		settings: { fake: true },
		get model() {
			return world.main.current;
		},
		modelRegistry: {
			getApiKey: async (m: never) => (world.keys.has(ref(m as FakeModel)) ? "key" : undefined),
			resolver: (m: never) => ({ resolverFor: (m as FakeModel).id }),
			getAvailable: () => [],
		},
		sessionManager: {
			getSessionId: () => "sess-1",
			getLeafId: () => "leaf-1",
			appendModelUsage: (entry: Record<string, unknown>) => void usage.push(entry),
		},
	};
	const stock: NextPromptStock = {
		completeSimple: async (m, _context, options) => {
			calls.push({ model: m as unknown as FakeModel, options: options as Call["options"] });
			return {
				content: [{ type: "text", text: "verdict" }],
				stopReason: "stop",
				usage: { totalTokens: 42, cost: { total: 0.5 } },
			};
		},
		roleCandidatePool: () => [],
		resolveRoleChain: role => (world.chains[role] ?? []).map(m => ({ model: m })),
		shouldSkipHistory: () => false,
	};
	setNextPromptStock(stock);
	return world;
}

const ask = { system: "judge these", user: "evidence" };

let world: World;

beforeEach(() => {
	resetNextPromptState();
	world = build();
});

afterEach(() => {
	resetNextPromptState();
	setNextPromptStock(undefined);
	vi.restoreAllMocks();
});

describe("judge family rules", () => {
	it("reads a family from identity.class and treats missing and unknown as none", () => {
		expect(modelFamily(GPT)).toBe("openai");
		expect(modelFamily(model("x", "y"))).toBeNull();
		expect(modelFamily(model("x", "y", "unknown"))).toBeNull();
		expect(modelFamily(undefined)).toBeNull();
		expect(JUDGE_ROLES).toEqual(["advisor", "slow"]);
	});

	it("says cross-family only when both lineages are known", () => {
		expect(crossFamily(GPT, CLAUDE_A)).toBe(true);
		expect(crossFamily(CLAUDE_B, CLAUDE_A)).toBe(false);
		expect(crossFamily(GPT, model("x", "y", "unknown"))).toBeNull();
		expect(crossFamily(GPT, undefined)).toBeNull();
	});
});

describe("agent_control.judge model choice", () => {
	it("takes a cross-family model from the advisor chain ahead of a same-family one", async () => {
		world.chains.advisor = [CLAUDE_A, GPT];
		world.keys = new Set([ref(CLAUDE_A), ref(GPT)]);
		const reply = await world.judge(ask);
		expect(world.calls.map(call => ref(call.model))).toEqual(["openai/gpt-judge"]);
		expect(reply).toMatchObject({
			text: "verdict",
			model: "openai/gpt-judge",
			role: "advisor",
			family: "openai",
			mainModel: "anthropic/claude-main",
			mainFamily: "anthropic",
			crossFamily: true,
			usd: 0.5,
			tokens: 42,
		});
	});

	it("falls to the slow chain when every advisor candidate shares the main family", async () => {
		world.chains.advisor = [CLAUDE_A, CLAUDE_B];
		world.chains.slow = [GEMINI];
		world.keys = new Set([ref(CLAUDE_A), ref(CLAUDE_B), ref(GEMINI)]);
		const reply = await world.judge(ask);
		expect(world.calls.map(call => ref(call.model))).toEqual(["google/gemini-judge"]);
		expect(reply).toMatchObject({ role: "slow", family: "google", crossFamily: true });
	});

	it("uses the first credentialed model, reported as same-family, when none differs", async () => {
		world.chains.advisor = [CLAUDE_A];
		world.chains.slow = [CLAUDE_B];
		world.keys = new Set([ref(CLAUDE_A), ref(CLAUDE_B)]);
		const reply = await world.judge(ask);
		expect(world.calls.map(call => ref(call.model))).toEqual(["anthropic/claude-a"]);
		expect(reply).toMatchObject({ role: "advisor", family: "anthropic", crossFamily: false });
	});

	it("skips an advisor model without credentials", async () => {
		world.chains.advisor = [GPT, GEMINI];
		world.keys = new Set([ref(GEMINI)]);
		const reply = await world.judge(ask);
		expect(world.calls.map(call => ref(call.model))).toEqual(["google/gemini-judge"]);
		expect(reply).toMatchObject({ role: "advisor", crossFamily: true });
	});

	it("takes the first credentialed model without a verdict on family when the main model's is unknown", async () => {
		world.main.current = model("local", "mystery");
		world.chains.advisor = [CLAUDE_A, GPT];
		world.keys = new Set([ref(CLAUDE_A), ref(GPT)]);
		const reply = await world.judge(ask);
		expect(world.calls.map(call => ref(call.model))).toEqual(["anthropic/claude-a"]);
		expect(reply).toMatchObject({
			family: "anthropic",
			mainModel: "local/mystery",
			mainFamily: null,
			crossFamily: null,
		});
	});

	it("reports null families for a session that has no model", async () => {
		world.main.current = undefined;
		world.chains.slow = [GPT];
		world.keys = new Set([ref(GPT)]);
		const reply = await world.judge(ask);
		expect(reply).toMatchObject({
			role: "slow",
			family: "openai",
			mainModel: null,
			mainFamily: null,
			crossFamily: null,
		});
	});

	it("does not ask the same model twice when two chains list it", async () => {
		world.chains.advisor = [CLAUDE_A];
		world.chains.slow = [CLAUDE_A, GPT];
		world.keys = new Set([ref(CLAUDE_A), ref(GPT)]);
		const reply = await world.judge(ask);
		expect(reply).toMatchObject({ model: "openai/gpt-judge", role: "slow", crossFamily: true });
	});

	it("rejects when no candidate has credentials", async () => {
		world.chains.advisor = [GPT];
		world.chains.slow = [GEMINI];
		await expect(world.judge(ask)).rejects.toThrow("No credentials for openai/gpt-judge");
		expect(world.calls).toHaveLength(0);
	});

	it("rejects a reply its deadline cut off instead of answering with empty text", async () => {
		world.chains.advisor = [GPT];
		world.keys.add(ref(GPT));
		const stock: NextPromptStock = {
			completeSimple: async () => ({ content: [], stopReason: "aborted", errorMessage: "Request was aborted" }),
			roleCandidatePool: () => [],
			resolveRoleChain: role => (world.chains[role] ?? []).map(m => ({ model: m })),
			shouldSkipHistory: () => false,
		};
		setNextPromptStock(stock);
		await expect(world.judge(ask)).rejects.toThrow("The model request timed out after 170 s");
	});

	it("rejects when no role resolves to a model", async () => {
		await expect(world.judge(ask)).rejects.toThrow("resolves to no available model");
	});

	it("never stands in the main model when the chains are empty", async () => {
		world.keys = new Set([ref(MAIN)]);
		await expect(world.judge(ask)).rejects.toThrow();
		expect(world.calls).toHaveLength(0);
	});
});

describe("agent_control.judge request and ledger", () => {
	it("journals the resolved role under the judge purpose", async () => {
		world.chains.advisor = [CLAUDE_A];
		world.chains.slow = [GPT];
		world.keys = new Set([ref(CLAUDE_A), ref(GPT)]);
		await world.judge(ask);
		expect(world.usage).toHaveLength(1);
		expect(world.usage[0]).toMatchObject({ purpose: "ompdesk-judge", role: "slow", provider: "openai" });
	});

	it("lets the request run for the judge's own deadline, not the 20 s a suggestion gets", async () => {
		const timeout = vi.spyOn(AbortSignal, "timeout");
		world.chains.advisor = [GPT];
		world.keys = new Set([ref(GPT)]);
		await world.judge(ask);
		expect(timeout).toHaveBeenCalledWith(170_000);
		expect(world.calls[0]?.options).toMatchObject({ maxTokens: 2000, temperature: 0 });
	});
});
