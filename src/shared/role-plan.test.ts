import { describe, expect, it } from "vitest";
import type { ModelSetupFacts, SetupModelFacts } from "../../resources/gui-bridge/model-setup-contracts";
import { billingOf, type PlanRoleInput, planRoles, type RolePlanInput, setupSignature } from "./role-plan";

function model(selector: string, facts: Partial<SetupModelFacts> = {}): [string, SetupModelFacts] {
	const [provider, ...id] = selector.split("/");
	return [selector, { provider, id: id.join("/"), name: selector, kind: "chat", image: true, ...facts }];
}

// The shape of the account the baseline measured: two subscriptions, an OpenRouter key, a free on-device model.
const MODELS = Object.fromEntries([
	model("anthropic/opus", { family: "claude", int: 60, outputPrice: 20, contextWindow: 1_000_000 }),
	model("anthropic/sonnet", { family: "claude", int: 50, outputPrice: 10, contextWindow: 1_000_000 }),
	model("anthropic/haiku", { family: "claude", int: 43.4, outputPrice: 0.5, contextWindow: 200_000 }),
	model("openai-codex/sol", { family: "gpt", int: 51.8, outputPrice: 10, contextWindow: 400_000 }),
	model("openrouter/fable", { family: "claude", int: 65.7, outputPrice: 1, contextWindow: 1_000_000 }),
	model("apple/on-device", {
		family: "apple",
		kind: "tiny",
		int: 20,
		outputPrice: 0,
		contextWindow: 8_000,
		image: false,
	}),
	model("openrouter/typesafe/jev-1.14", { kind: "judge", image: false }),
]);
const CHAT = Object.keys(MODELS).filter(selector => MODELS[selector]?.kind !== "judge");

function facts(overrides: Partial<ModelSetupFacts> = {}): ModelSetupFacts {
	return {
		providers: {
			anthropic: { billing: "subscription", basis: "oauth" },
			"openai-codex": { billing: "subscription", basis: "oauth" },
			openrouter: { billing: "metered", basis: "api-key" },
			apple: { billing: "free", basis: "local-keyless" },
		},
		models: MODELS,
		roles: {},
		judgePins: ["openrouter/typesafe/jev-1.14"],
		...overrides,
	};
}

const chat = (id: string): PlanRoleInput => ({ id, section: "chat", candidates: CHAT });
const ROLES: PlanRoleInput[] = [
	"default",
	"slow",
	"smol",
	"plan",
	"task",
	"advisor",
	"commit",
	"tiny",
	"vision",
	"memory",
].map(chat);
ROLES.push({ id: "judge", section: "kind", candidates: ["openrouter/typesafe/jev-1.14"] });
ROLES.push({ id: "image", section: "kind", candidates: [] });

function plan(input: Partial<RolePlanInput> = {}) {
	const rows = planRoles({ mode: "full", roles: ROLES, facts: facts(), defaultModel: "anthropic/opus", ...input });
	return Object.fromEntries(rows.map(row => [row.role, row]));
}

describe("planRoles", () => {
	it("plans full auto over subscription and free models only, the strongest of them included", () => {
		const rows = plan();
		for (const row of Object.values(rows)) {
			if (row.model) expect(billingOf(facts(), row.model)).not.toBe("metered");
		}
		// OpenRouter's fable has the highest score of all, yet stays out.
		expect(rows.slow?.model).toBe("anthropic/opus");
	});

	it("gives cheap roles the cheapest capable model and strong roles the strongest", () => {
		const rows = plan();
		expect(rows.smol?.model).toBe("anthropic/haiku");
		expect(rows.commit?.model).toBe("anthropic/haiku");
		expect(rows.plan?.model).toBe("anthropic/opus");
		expect(rows.default?.model).toBe("anthropic/opus");
		expect(rows.smol?.reason).toMatchObject({
			rule: "cheap",
			int: 43.4,
			topInt: 60,
			outputPrice: 0.5,
			comparePrice: 20,
		});
	});

	it("keeps a commit model that cannot read a whole diff out", () => {
		const cheapTiny = facts({
			models: { ...MODELS, "apple/on-device": { ...MODELS["apple/on-device"]!, int: 55 } },
		});
		const rows = plan({ facts: cheapTiny });
		// The free on-device model is now cheapest and clever enough, but its 8k context is below commit's floor.
		expect(rows.tiny?.model).toBe("apple/on-device");
		expect(rows.commit?.model).toBe("anthropic/haiku");
	});

	it("puts the advisor on another vendor than the default", () => {
		const rows = plan();
		expect(rows.advisor?.model).toBe("openai-codex/sol");
		expect(rows.advisor?.reason.crossVendor).toBe(true);
	});

	it("moves off a provider whose accounts are nearly used up", () => {
		const rows = plan({ headroom: { anthropic: 0.1, "openai-codex": 0.9 } });
		expect(rows.slow?.model).toBe("openai-codex/sol");
		expect(rows.slow?.reason.headroom).toBe(0.9);
	});

	it("leaves model-kind roles to stock and skips hidden roles", () => {
		const rows = plan();
		expect(rows.judge).toMatchObject({ model: null, checked: false, reason: { rule: "stock" } });
		expect(rows.image).toMatchObject({ model: null, reason: { rule: "stock" } });
		expect(rows.memory).toBeUndefined();
	});

	it("keeps a role set by hand unticked, and ticks one OMPdesk's own last apply set", () => {
		const input = {
			roles: ROLES.map(role =>
				role.id === "smol" || role.id === "commit" ? { ...role, current: "anthropic/sonnet" } : role,
			),
			facts: facts({
				roles: { smol: { persisted: "anthropic/sonnet" }, commit: { persisted: "anthropic/sonnet:high" } },
			}),
			lastApplied: { commit: "anthropic/sonnet" },
		};
		const rows = plan(input);
		expect(rows.smol).toMatchObject({ model: "anthropic/haiku", manual: true, checked: false });
		expect(rows.commit).toMatchObject({ model: "anthropic/haiku", manual: false, checked: true });
	});

	it("does not tick a role already on the proposed model", () => {
		const rows = plan({
			roles: ROLES.map(role => (role.id === "slow" ? { ...role, current: "anthropic/opus:high" } : role)),
		});
		expect(rows.slow).toMatchObject({ model: "anthropic/opus", checked: false });
	});

	it("treats a provider the facts do not classify as metered", () => {
		const extra = Object.fromEntries([model("mystery/strong", { int: 99, outputPrice: 1 })]);
		const rows = plan({
			facts: facts({ models: { ...MODELS, ...extra } }),
			roles: ROLES.map(role =>
				role.section === "chat" ? { ...role, candidates: [...CHAT, "mystery/strong"] } : role,
			),
		});
		expect(Object.values(rows).map(row => row.model)).not.toContain("mystery/strong");
	});

	it("plans a role it has no rule for like the default, and a kind role it does not know on stock", () => {
		const rows = plan({
			roles: [...ROLES, chat("future-chat"), { id: "future-kind", section: "kind", candidates: [] }],
		});
		expect(rows["future-chat"]).toMatchObject({ model: "anthropic/opus", reason: { rule: "chat" } });
		expect(rows["future-kind"]).toMatchObject({ model: null, reason: { rule: "stock" } });
	});

	it("uses a picked metered model in the picked mode", () => {
		const rows = plan({ mode: "picked", picked: ["openrouter/fable", "anthropic/haiku"] });
		expect(rows.slow?.model).toBe("openrouter/fable");
		expect(rows.slow?.reason).toMatchObject({ billing: "metered", basis: "api-key" });
		for (const row of Object.values(rows))
			if (row.model) expect(["openrouter/fable", "anthropic/haiku"]).toContain(row.model);
	});

	it("changes its signature when a model, a role or a billing class appears", () => {
		const base = setupSignature(ROLES, facts());
		expect(setupSignature(ROLES, facts())).toBe(base);
		expect(setupSignature([...ROLES, chat("review")], facts())).not.toBe(base);
		const more = ROLES.map(role => (role.id === "slow" ? { ...role, candidates: [...CHAT, "x/new"] } : role));
		expect(setupSignature(more, facts())).not.toBe(base);
		const keyed = facts({
			providers: { ...facts().providers, anthropic: { billing: "metered", basis: "oauth-and-key" } },
		});
		expect(setupSignature(ROLES, keyed)).not.toBe(base);
	});
});
