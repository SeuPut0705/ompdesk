import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_TEMPLATES } from "../shared/agent-templates";

/**
 * Pins Settings' model roles to stock omp, on the installed omp in an empty
 * private agent dir (a throwaway OpenAI key only gives the catalog models;
 * nothing is prompted and no user data is read):
 *
 * - every role's `effective` model equals what stock's own resolver returns
 *   for it (`resolveRoleChain`, `resolveAdvisorRoleSelection`, an empty role's
 *   inheritance), including what an empty role falls back to;
 * - a custom role (`modelRoles.<id>`, `@id`) resolves through stock, and an
 *   OMPdesk agent template picks that role's model, then the next role it lists
 *   while the role is empty — through stock's agent model resolution;
 * - defining, renaming and forgetting a custom role go through stock's
 *   `modelTags`, `modelRoles` and `cycleOrder` settings.
 */
const omp = join(homedir(), ".bun", "bin", "omp");

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
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
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
   out.builtin = Object.values(empty).filter(role => role.builtin).map(role => role.id);
   out.presetsListedEmpty = ["explore", "review", "debug", "docs", "test", "design"].map(id => [id, empty[id]?.effective?.source ?? null]);

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
   out.reviewEmpty = afterSlow.review.effective;
   out.testEmpty = afterSlow.test.effective;
   out.agentsEmpty = { review: agentModel("code-reviewer"), debug: agentModel("debugger"), test: agentModel("test-writer"), design: agentModel("ui-polisher") };
   out.oracleSlow = await oracle();

   await set("review", A);
   await set("test", B);
   const afterOwn = await roles();
   out.reviewOwn = afterOwn.review.effective;
   out.testOwn = afterOwn.test.effective;
   out.agentsOwn = { review: agentModel("code-reviewer"), test: agentModel("test-writer"), debug: agentModel("debugger") };

   // Define, rename, forget a custom role of the user's own.
   await methods.model_role_define({ id: "mine", name: "My role", description: "My own agents" }, env);
   await set("mine", B);
   const mine = (await roles()).mine;
   out.mine = { label: mine.label, name: mine.name, description: mine.description, builtin: mine.builtin, effective: mine.effective };
   await methods.model_role_define({ id: "mine", name: "Renamed" }, env);
   const renamed = (await roles()).mine;
   out.renamed = { label: renamed.label, description: renamed.description ?? null };
   const cycle = lookup("cycleOrder");
   cycle.set(settings, ["smol", "mine", "slow"]);
   await methods.model_role_forget({ id: "mine" }, env);
   const after = await roles();
   out.forgot = { listed: "mine" in after, role: settings.getModelRole("mine") ?? null, cycle: cycle.get(settings) };
   let refused = null;
   try { await methods.model_role_forget({ id: "smol" }, env); } catch (error) { refused = String(error.message); }
   out.refusedBuiltin = refused;
   await methods.model_role_define({ id: "design", name: "Look and feel", description: "x" }, env);
   out.designTag = (await roles()).design.label;
   await methods.model_role_define({ id: "design", name: "", description: "" }, env);
   out.designReset = (await roles()).design.label ?? null;
   console.error("ROLES_PROBE=" + JSON.stringify(out));
   process.exit(0);
  } catch (error) {
   console.error("ROLES_PROBE_FAILED " + (error instanceof Error ? error.stack : String(error)));
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

describe.skipIf(!existsSync(omp))("model roles on stock's resolution", () => {
	it("reports each role's effective model as stock resolves it and runs template agents on their preset role", () => {
		const isolated = mkdtempSync(join(tmpdir(), "ompdesk-roles-"));
		chmodSync(isolated, 0o700);
		try {
			cpSync(resolve("resources/gui-bridge"), join(isolated, "bridge"), { recursive: true });
			const extension = join(isolated, "bridge", "model-roles-probe.ts");
			writeFileSync(extension, PROBE);
			const env: Record<string, string | undefined> = {
				...process.env,
				PI_CODING_AGENT_DIR: isolated,
				PI_CONFIG_DIR: isolated,
				OMP_PROFILE: "",
				PI_PROFILE: "",
				OPENAI_API_KEY: "probe-not-a-real-key",
				ROLES_PROBE_TEMPLATES: JSON.stringify(
					AGENT_TEMPLATES.map(template => ({ name: template.name, model: template.model })),
				),
			};
			for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) {
				Reflect.deleteProperty(env, key);
			}
			const result = spawnSync(
				omp,
				["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-rules", "-e", extension],
				{ env, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024, input: "" },
			);
			const line = result.stderr.split("\n").find(value => value.startsWith("ROLES_PROBE"));
			expect(line, result.stderr.slice(-2500)).toMatch(/^ROLES_PROBE=/);
			const probe = JSON.parse(line?.slice("ROLES_PROBE=".length) ?? "{}") as Record<string, unknown> & {
				A: string;
				B: string;
			};
			const { A, B } = probe;
			expect(A).not.toBe(B);

			// Stock's 15 built-ins are flagged; the six presets are listed while empty.
			expect((probe.builtin as string[]).sort()).toEqual(
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
			expect(probe.ids).toEqual(expect.arrayContaining(["explore", "review", "debug", "docs", "test", "design"]));
			expect((probe.presetsListedEmpty as [string, string | null][]).every(([, source]) => source !== null)).toBe(
				true,
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

			// An empty custom role follows the next role its agents list: review → slow (B), test → task (A).
			expect(probe.reviewEmpty).toMatchObject({ model: B, source: "fallback", via: "slow" });
			expect(probe.testEmpty).toMatchObject({ model: A, source: "fallback", via: "task" });
			expect(probe.agentsEmpty).toEqual({ review: B, debug: B, test: A, design: A });

			// Assigned, the role is the agent's model.
			expect(probe.reviewOwn).toMatchObject({ model: A, source: "configured" });
			expect(probe.testOwn).toMatchObject({ model: B, source: "configured" });
			expect(probe.agentsOwn).toEqual({ review: A, test: B, debug: B });

			// A user's own role: defined, assigned, renamed (the description follows what is passed), forgotten everywhere.
			expect(probe.mine).toMatchObject({
				label: "My role",
				name: "My role",
				description: "My own agents",
				builtin: false,
				effective: { model: B, source: "configured" },
			});
			expect(probe.renamed).toEqual({ label: "Renamed", description: null });
			expect(probe.forgot).toEqual({ listed: false, role: null, cycle: ["smol", "slow"] });
			expect(probe.refusedBuiltin).toMatch(/cannot be a custom role id \(builtin\)/);
			expect(probe.designTag).toBe("Look and feel");
			expect(probe.designReset).toBeNull();
		} finally {
			rmSync(isolated, { recursive: true, force: true });
		}
	}, 130_000);
});
