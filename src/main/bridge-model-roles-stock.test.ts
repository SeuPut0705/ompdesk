import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENT_TEMPLATES } from "../shared/agent-templates";
import { INSTALLED_OMP, runBridgeProbe } from "./test-bridge-probe";

/**
 * Pins Settings' model roles to stock omp, on the installed omp in an empty
 * private agent dir (a throwaway OpenAI key only gives the catalog models;
 * nothing is prompted and no user data is read):
 *
 * - every role's `effective` model equals what stock's own resolver returns
 *   for it (`resolveRoleChain`, `resolveAdvisorRoleSelection`, an empty role's
 *   inheritance), including what an empty role falls back to;
 * - only stock's built-in roles are listed: a custom `modelRoles.<id>` set
 *   outside OMPdesk stays in the settings and stock still resolves `@id`;
 * - each OMPdesk agent template runs on its first built-in role's model,
 *   through stock's agent model resolution.
 */

const PROBE = `
import { methods } from "./settings";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import {
 resolveAdvisorRoleSelection,
 resolveAgentModelPatterns,
 resolveModelOverride,
 resolveRoleChain,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { roleCandidatePool } from "@oh-my-pi/pi-coding-agent/config/model-roles";
export default function (pi) {
 pi.on("session_start", async () => {
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = { pi, session: () => session, context: () => undefined, emit: () => {} };
   const settings = session.settings;
   const sel = model => model.provider + "/" + model.id;
   const chat = session.modelRegistry.getAvailable().filter(model => modelKind(model) === "chat");
   const A = sel(chat[0]);
   const B = sel(chat.find(model => sel(model) !== A));
   const roles = async () => Object.fromEntries((await methods.model_roles({}, env)).roles.map(role => [role.id, role]));
   const set = (role, value) => methods.model_role_set({ role, modelId: value }, env);
   const templates = JSON.parse(process.env.ROLES_PROBE_TEMPLATES);
   /** What a template agent runs on, through stock's agent model resolution (no override, no active model). */
   const agentModel = name => {
    const template = templates.find(entry => entry.name === name);
    const patterns = resolveAgentModelPatterns({ agentModel: template.model, settings });
    const { model } = resolveModelOverride(patterns, session.modelRegistry, settings);
    return model ? sel(model) : null;
   };
   const out = { A, B };
   const empty = await roles();
   out.ids = Object.keys(empty);

   // Oracle: stock's own resolvers against each role's reported effective model.
   const oracle = async () => {
    const reported = await roles();
    const mismatches = [];
    for (const id of ["smol", "slow", "tiny", "memory", "image", "web", "speech", "dictation", "judge"]) {
     const stock = resolveRoleChain(id, settings, roleCandidatePool(id, settings, session.modelRegistry))[0];
     const expected = stock ? sel(stock.model) : undefined;
     if (reported[id].effective.model !== expected) mismatches.push([id, reported[id].effective.model ?? null, expected ?? null]);
    }
    const advisor = resolveAdvisorRoleSelection(settings, session.modelRegistry.getAvailable());
    const expectedAdvisor = advisor ? sel(advisor.model) : undefined;
    if (reported.advisor.effective.model !== expectedAdvisor) mismatches.push(["advisor", reported.advisor.effective.model ?? null, expectedAdvisor ?? null]);
    return mismatches;
   };
   out.oracleEmpty = await oracle();

   await set("smol", A);
   const afterSmol = await roles();
   out.smol = afterSmol.smol.effective;
   out.tiny = afterSmol.tiny.effective;
   out.memory = afterSmol.memory.effective;
   out.plan = afterSmol.plan.effective.source;
   out.oracleSmol = await oracle();

   await set("slow", B);
   await set("task", A);
   const afterSlow = await roles();
   out.advisor = afterSlow.advisor.effective;
   out.agentsBuiltin = Object.fromEntries(templates.map(template => [template.name, agentModel(template.name)]));
   out.oracleSlow = await oracle();

   // A custom role of the user's own, set outside OMPdesk: not listed, still honoured by stock for an agent.
   await set("mine", B);
   out.mine = { listed: "mine" in (await roles()), role: settings.getModelRole("mine") ?? null };
   const patterns = resolveAgentModelPatterns({ agentModel: ["@mine", "@task"], settings });
   const mineModel = resolveModelOverride(patterns, session.modelRegistry, settings).model;
   out.mineAgent = mineModel ? sel(mineModel) : null;
   console.error("ROLES_PROBE=" + JSON.stringify(out));
   process.exit(0);
  } catch (error) {
   console.error("ROLES_PROBE_FAILED " + (error instanceof Error ? error.stack : String(error)));
   process.exit(1);
  }
 });
}
`;

const JUDGE_PROBE = `
import { methods } from "./settings";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import { resolveRoleChain } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { getRoleInfo, roleCandidatePool } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { hasNativeJudge } from "@oh-my-pi/pi-coding-agent/judgment";
export default function (pi) {
 pi.on("session_start", async () => {
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = { pi, session: () => session, context: () => undefined, emit: () => {} };
   const { settings, modelRegistry } = session;
   const sel = model => model.provider + "/" + model.id;
   const roles = (await methods.model_roles({}, env)).roles;
   const accepts = getRoleInfo("judge", settings).accepts;
   const preferred = resolveRoleChain("judge", settings, modelRegistry.getAll("all").filter(model => accepts(model)));
   const usable = resolveRoleChain("judge", settings, roleCandidatePool("judge", settings, modelRegistry));
   const judgeKind = modelKind(preferred[0].model);
   console.error("JUDGE_PROBE=" + JSON.stringify({
    effective: roles.find(role => role.id === "judge").effective,
    native: hasNativeJudge(settings, modelRegistry),
    preferred: sel(preferred[0].model),
    preferredKind: judgeKind,
    preferredProviders: [...new Set(preferred.filter(candidate => modelKind(candidate.model) === judgeKind).map(candidate => candidate.model.provider))],
    answering: sel(usable[0].model),
    skippedRoles: roles.filter(role => role.effective?.skipped).map(role => role.id),
   }));
   process.exit(0);
  } catch (error) {
   console.error("JUDGE_PROBE_FAILED " + (error instanceof Error ? error.stack : String(error)));
   process.exit(1);
  }
 });
}
`;

interface Effective {
	model?: string;
	source: string;
	via?: string;
	unavailable?: boolean;
}

describe.skipIf(!existsSync(INSTALLED_OMP))("model roles on stock's resolution", () => {
	it("reports each built-in role's effective model as stock resolves it and runs template agents on their first role", () => {
		const probe = runBridgeProbe(PROBE, "ROLES_PROBE", {
			ROLES_PROBE_TEMPLATES: JSON.stringify(
				AGENT_TEMPLATES.map(template => ({ name: template.name, model: template.model })),
			),
		}) as Record<string, unknown> & { A: string; B: string };
		const { A, B } = probe;
		expect(A).not.toBe(B);

		// Stock's 15 built-ins, and nothing else, are listed.
		expect((probe.ids as string[]).sort()).toEqual(
			[
				"advisor",
				"commit",
				"default",
				"dictation",
				"image",
				"judge",
				"memory",
				"plan",
				"slow",
				"smol",
				"speech",
				"task",
				"tiny",
				"vision",
				"web",
			].sort(),
		);

		// Every chain role equals stock's own resolver, empty and as roles fill in.
		expect(probe.oracleEmpty).toEqual([]);
		expect(probe.oracleSmol).toEqual([]);
		expect(probe.oracleSlow).toEqual([]);

		// Empty Tiny and Memory follow Fast; Plan keeps the session's model.
		const smol = probe.smol as Effective;
		expect(smol).toMatchObject({ model: A, source: "configured" });
		expect(probe.tiny).toMatchObject({ model: A, source: "fallback" });
		expect(probe.memory).toMatchObject({ model: A, source: "fallback" });
		expect(probe.plan).toBe("session");
		// Advisor follows the configured Thinking role.
		expect(probe.advisor).toMatchObject({ model: B, source: "fallback" });

		// Each template agent runs on its first built-in role: Fast and Subtask hold A, Thinking B.
		const byRole: Record<string, string> = { "@smol": A, "@task": A, "@slow": B };
		expect(probe.agentsBuiltin).toEqual(
			Object.fromEntries(AGENT_TEMPLATES.map(template => [template.name, byRole[template.model[0] ?? ""]])),
		);

		// A custom role set outside OMPdesk: kept in the settings, not listed, still an agent's model through stock.
		expect(probe.mine).toEqual({ listed: false, role: B });
		expect(probe.mineAgent).toBe(B);
	}, 130_000);

	it("reports the judge's stock-preferred native model when no provider holds credentials for it, and nothing once one does", () => {
		const probeJudge = (env: Record<string, string>) =>
			runBridgeProbe(JUDGE_PROBE, "JUDGE_PROBE", env) as {
				effective: {
					model: string;
					source: string;
					skipped?: { model: string; kind: string; providers: string[] };
				};
				native: boolean;
				preferred: string;
				preferredKind: string;
				preferredProviders: string[];
				answering: string;
				skippedRoles: string[];
			};

		// No key: stock's judge chain answers with a prompted model (`hasNativeJudge` false), so the native model
		// stock lists first is reported as skipped, with every provider stock lists it under.
		const none = probeJudge({});
		expect(none.native).toBe(false);
		expect(none.preferredKind).toBe("judge");
		expect(none.effective.model).toBe(none.answering);
		expect(none.effective.skipped).toEqual({
			name: expect.any(String),
			model: none.preferred,
			kind: none.preferredKind,
			providers: none.preferredProviders,
		});
		expect(none.preferredProviders.length).toBeGreaterThan(1);
		expect(none.skippedRoles).toEqual(["judge"]);

		// A key for any one provider that holds it: stock now routes to a native judge, and the row reports nothing.
		for (const provider of none.preferredProviders) {
			const keyed = probeJudge({ [`${provider.toUpperCase()}_API_KEY`]: "probe-not-a-real-key" });
			expect(keyed.native, provider).toBe(true);
			expect(keyed.effective.skipped, provider).toBeUndefined();
			expect(keyed.skippedRoles, provider).toEqual([]);
		}
	}, 400_000);
});
