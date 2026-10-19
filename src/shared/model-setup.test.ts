/**
 * Model setup contract: the research prompt names exactly the picked models
 * and the known roles, and the reply parser keeps only assignments to a known
 * role with a picked model, however the reply wraps its JSON.
 */
import { describe, expect, it } from "vitest";
import { ipcErrorCode } from "./ipc-error-codes";
import {
	buildModelSetupPrompt,
	type ModelSetupRequest,
	ModelSetupRequestSchema,
	parseModelSetupPlan,
} from "./model-setup";

const REQUEST: ModelSetupRequest = {
	researchModel: "anthropic/claude-opus-4-1",
	defaultModel: "anthropic/claude-sonnet-4-5",
	models: [
		{
			selector: "anthropic/claude-sonnet-4-5",
			provider: "anthropic",
			name: "Claude Sonnet 4.5",
			contextWindow: 1_000_000,
			cost: { input: 3, output: 15 },
			intelligence: 61.4,
		},
		{ selector: "openai/gpt-5.2", provider: "openai", name: "GPT-5.2", contextWindow: 400_000 },
	],
	roles: [
		{ id: "default", name: "Default" },
		{ id: "smol", name: "Fast" },
		{ id: "advisor", name: "Advisor" },
		{ id: "reviewer", name: "Reviewer" },
	],
	language: "Korean",
};

const VALID = {
	assignments: [
		{ role: "default", model: "anthropic/claude-sonnet-4-5", reason: "Best coding scores." },
		{ role: "advisor", model: "openai/gpt-5.2", reason: "Different vendor." },
	],
	advisor: { enable: true, reason: "A strong second vendor." },
	sources: [{ title: "Leaderboard", url: "https://example.com/board" }],
	notes: "Prices as of today.",
};

describe("buildModelSetupPrompt", () => {
	const prompt = buildModelSetupPrompt(REQUEST);

	it("lists exactly the picked models with what the catalog knows", () => {
		const modelLines = prompt.split("\n").filter(line => /^- \S+\/\S+ \(provider /.test(line));
		expect(modelLines).toEqual([
			'- anthropic/claude-sonnet-4-5 (provider anthropic; name "Claude Sonnet 4.5"; context window 1M tokens; $3 input / $15 output per 1M tokens; catalog intelligence score 61)',
			'- openai/gpt-5.2 (provider openai; name "GPT-5.2"; context window 400K tokens)',
		]);
		expect(prompt).toContain('"model" is one of: anthropic/claude-sonnet-4-5, openai/gpt-5.2.');
		expect(prompt).toContain("current default model is anthropic/claude-sonnet-4-5");
		expect(prompt).not.toContain("claude-opus-4-1");
	});

	it("describes every requested role, the advisor as a cross-vendor reviewer, and asks for JSON only", () => {
		const roleLines = prompt.split("\n").filter(line => /^- [a-z]+ \([A-Za-z]+\): /.test(line));
		expect(roleLines.map(line => line.slice(2, line.indexOf(" (")))).toEqual([
			"default",
			"smol",
			"advisor",
			"reviewer",
		]);
		expect(prompt).toMatch(/- advisor \(Advisor\): Second-opinion reviewer.*different vendor than the default/);
		expect(prompt).toContain('"role" is one of: default, smol, advisor, reviewer.');
		// A role the table has no purpose for is described by its name and section: any chat role is researchable.
		expect(prompt).toContain("- reviewer (Reviewer): Reviewer (chat role)");
		expect(prompt).toContain("Reply with ONLY one JSON object");
		expect(prompt).toContain("benchmarks and comparisons for exactly these models");
		expect(prompt).toContain('Write every "reason" and "notes" in Korean.');
	});

	it("proposes per purpose group, built-ins in the contract's order, and says so", () => {
		const lines = prompt.split("\n");
		expect(lines.filter(line => line.startsWith("### "))).toEqual([
			"### Conversation",
			"### Agent work",
			"### Other roles",
		]);
		const under = (heading: string) => {
			const start = lines.indexOf(heading) + 1;
			const end = lines.findIndex((line, index) => index >= start && line.startsWith("#"));
			return lines.slice(start, end < 0 ? undefined : end).filter(line => line.startsWith("- "));
		};
		expect(under("### Conversation").map(line => line.slice(2, line.indexOf(" (")))).toEqual(["default", "smol"]);
		expect(under("### Agent work").map(line => line.slice(2, line.indexOf(" (")))).toEqual(["advisor"]);
		expect(prompt).toContain("Decide group by group");
	});

	it("lists a role in a group only for a stock built-in; the group of a custom role is never proposed", () => {
		const custom = buildModelSetupPrompt({ ...REQUEST, roles: [{ id: "review", name: "Review" }] });
		expect(custom).not.toContain("### Conversation");
		expect(custom).toContain("### Other roles");
		expect(custom).toContain("- review (Review): Review (chat role)");
	});
});

describe("ModelSetupRequestSchema", () => {
	it("accepts a request and refuses flag-like or empty selections", () => {
		expect(ModelSetupRequestSchema.safeParse(REQUEST).success).toBe(true);
		expect(ModelSetupRequestSchema.safeParse({ ...REQUEST, researchModel: "--help" }).success).toBe(false);
		expect(ModelSetupRequestSchema.safeParse({ ...REQUEST, models: [] }).success).toBe(false);
		expect(ModelSetupRequestSchema.safeParse({ ...REQUEST, roles: [{ id: "a b", name: "x" }] }).success).toBe(false);
	});

	it("takes any number of picked models: the picker has no cap", () => {
		const many = Array.from({ length: 40 }, (_, index) => ({ selector: `p/m${index}`, provider: "p" }));
		expect(ModelSetupRequestSchema.safeParse({ ...REQUEST, models: many }).success).toBe(true);
	});
});

describe("parseModelSetupPlan", () => {
	it("reads a bare valid reply", () => {
		expect(parseModelSetupPlan(JSON.stringify(VALID), REQUEST)).toEqual({ plan: VALID, dropped: [] });
	});

	it("finds the plan inside prose and a code fence, past an echoed shape", () => {
		const text = [
			'I will answer in the shape {"assignments":[{"role":"<role id>","model":"<provider/id>","reason":"x"}]}.',
			"Here it is:",
			"```json",
			JSON.stringify(VALID, null, 2),
			"```",
			"Let me know {if} you need more.",
		].join("\n");
		expect(parseModelSetupPlan(text, REQUEST).plan).toEqual(VALID);
	});

	it("repairs near-miss models and roles and drops the rest", () => {
		const { plan, dropped } = parseModelSetupPlan(
			JSON.stringify({
				...VALID,
				assignments: [
					{ role: "Default", model: "anthropic/claude-sonnet-4-5:high", reason: "r1" },
					{ role: "smol", model: "gpt-5.2", reason: "r2" },
					{ role: "advisor", model: "google/gemini-3-pro", reason: "not picked" },
					{ role: "image", model: "openai/gpt-5.2", reason: "unknown role" },
					{ role: "default", model: "openai/gpt-5.2", reason: "duplicate" },
					{ role: "slow" },
				],
				sources: [{ title: "ok", url: "https://a.example" }, { title: "bad", url: "javascript:alert(1)" }, "x"],
			}),
			REQUEST,
		);
		expect(plan.assignments).toEqual([
			{ role: "default", model: "anthropic/claude-sonnet-4-5", reason: "r1" },
			{ role: "smol", model: "openai/gpt-5.2", reason: "r2" },
		]);
		expect(plan.sources).toEqual([{ title: "ok", url: "https://a.example" }]);
		expect(dropped).toEqual([
			'advisor: "google/gemini-3-pro" is not one of the selected models',
			'unknown role "image"',
			"default: duplicate assignment",
			'malformed assignment {"role":"slow"}',
		]);
	});

	it("derives the advisor switch when the reply omits it", () => {
		const { plan, dropped } = parseModelSetupPlan(
			JSON.stringify({ assignments: VALID.assignments, sources: [] }),
			REQUEST,
		);
		expect(plan.advisor).toEqual({ enable: true, reason: "" });
		expect(dropped).toEqual(["advisor decision missing or malformed"]);
	});

	it("fails with model_setup_no_plan when nothing is valid", () => {
		const unknownModel = JSON.stringify({
			...VALID,
			assignments: [{ role: "default", model: "google/gemini-3-pro", reason: "x" }],
		});
		const unknownRole = JSON.stringify({
			...VALID,
			assignments: [{ role: "image", model: "openai/gpt-5.2", reason: "x" }],
		});
		for (const text of ["", "No JSON here, sorry.", "{not json}", unknownModel, unknownRole]) {
			let caught: unknown;
			try {
				parseModelSetupPlan(text, REQUEST);
			} catch (error) {
				caught = error;
			}
			expect(ipcErrorCode(caught)).toBe("model_setup_no_plan");
		}
		expect(() => parseModelSetupPlan(unknownRole, REQUEST)).toThrow(/unknown role "image"/);
	});
});
