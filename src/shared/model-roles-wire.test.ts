import { describe, expect, it } from "vitest";
import { compactModelRoles, expandModelRoles } from "../../resources/gui-bridge/model-role-contracts";

const opus = { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", kind: "chat" };
const sonnet = { provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", kind: "chat" };
const jev = { provider: "openrouter", id: "typesafe/jev-1.14", name: "Jev 1.14", kind: "judge" };

const roles = [
	{ id: "default", name: "Default", candidates: [opus, sonnet] },
	{ id: "smol", name: "Smol", candidates: [sonnet, opus] },
	{ id: "judge", name: "Judge", candidates: [jev, sonnet] },
	{ id: "image", name: "Image", candidates: [] },
	{ id: "hidden", name: "Hidden" },
];

describe("get_model_roles on the wire", () => {
	it("sends each candidate once and expands back to the plain answer, each role's order kept", () => {
		const compact = compactModelRoles(roles);
		expect(compact.candidateModels).toEqual([opus, sonnet, jev]);
		expect(compact.roles[1]).toEqual({ id: "smol", name: "Smol", candidates: [1, 0] });
		expect(expandModelRoles(JSON.parse(JSON.stringify(compact)))).toEqual({ roles });
	});

	it("is smaller the more roles share their models", () => {
		const many = Array.from({ length: 17 }, (_, i) => ({
			id: `r${i}`,
			name: `R${i}`,
			candidates: [opus, sonnet, jev],
		}));
		expect(JSON.stringify(compactModelRoles(many)).length * 3).toBeLessThan(JSON.stringify({ roles: many }).length);
	});

	it("passes an older host's plain answer and anything else through", () => {
		const plain = { roles };
		expect(expandModelRoles(plain)).toBe(plain);
		expect(expandModelRoles(undefined)).toBeUndefined();
		expect(expandModelRoles({ roles: "x", candidateModels: [] })).toEqual({ roles: "x", candidateModels: [] });
	});

	it("drops an index that names no model instead of handing on a hole", () => {
		const expanded = expandModelRoles({ roles: [{ id: "a", candidates: [0, 5] }], candidateModels: [opus] });
		expect(expanded).toEqual({ roles: [{ id: "a", candidates: [opus] }] });
	});
});
