import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The model setup's plan reaches OMPdesk's own `review` role end to end, on the installed omp in a private agent dir
 * (fake OAuth tokens only: nothing is prompted, no model is called): the bridge's `model_roles` and
 * `model_setup_facts`, the pure planner (`src/shared/role-plan.ts`, full auto), then the dialog's apply
 * (`model_role_set` per ticked row). After applying the review row `@review` resolves to the planned model with
 * config.yml's bytes unchanged; after applying every row config.yml still holds no `review`.
 */
const omp = join(homedir(), ".bun", "bin", "omp");
const bun = join(homedir(), ".bun", "bin", "bun");
const sdk = join(
	homedir(),
	".bun",
	"install",
	"global",
	"node_modules",
	"@oh-my-pi",
	"pi-coding-agent",
	"src",
	"sdk.ts",
);

const PROBE = `
import * as fs from "node:fs";
import * as path from "node:path";
import { methods as facts } from "./model-setup-facts";
import { methods } from "./settings";
import { resolveModelOverride } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
const { planRoles } = await import(process.env.ROLE_PLAN);
export default function (pi) {
 pi.on("session_start", async () => {
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = { pi, session: () => session, context: () => undefined, emit: () => {} };
   const config = path.join(process.env.PI_CODING_AGENT_DIR, "config.yml");
   const bytes = () => (fs.existsSync(config) ? fs.readFileSync(config, "utf8") : null);
   const roles = (await methods.model_roles({}, env)).roles;
   const plan = planRoles({
    mode: "full",
    roles: roles.map(role => ({
     id: role.id,
     section: role.section,
     ...(role.hidden ? { hidden: true } : {}),
     candidates: role.candidates.map(candidate => candidate.provider + "/" + candidate.id),
     ...(role.model ? { current: role.model } : {}),
    })),
    facts: await facts.model_setup_facts({}, env),
    defaultModel: roles.find(role => role.id === "default")?.effective?.model,
   });
   const review = plan.find(row => row.role === "review") ?? null;
   const before = bytes();
   if (review?.model) await methods.model_role_set({ role: "review", modelId: review.model }, env);
   await session.settings.flush();
   const resolved = resolveModelOverride(["@review"], session.modelRegistry, session.settings).model;
   const unchanged = bytes() === before;
   for (const row of plan) {
    if (row.role !== "review" && row.checked && row.model) await methods.model_role_set({ role: row.role, modelId: row.model }, env);
   }
   await session.settings.flush();
   console.error("PLAN_PROBE=" + JSON.stringify({
    review,
    resolved: resolved ? resolved.provider + "/" + resolved.id : null,
    unchanged,
    rowsApplied: plan.filter(row => row.checked && row.model).map(row => row.role),
   }));
   process.exit(0);
  } catch (error) {
   console.error("PLAN_PROBE_FAILED " + (error instanceof Error ? error.stack : String(error)));
   process.exit(1);
  }
 });
}
`;

/** Stock's own AuthStorage writes the fixtures into the private dir's agent.db before omp starts. */
const SEED = `
import { discoverAuthStorage } from ${JSON.stringify(sdk)};
const auth = await discoverAuthStorage(process.argv[2]);
for (const [provider, credentials] of JSON.parse(process.env.PLAN_SEED)) await auth.credentials.set(provider, credentials);
process.exit(0);
`;

const oauth = (name: string) => ({
	type: "oauth",
	access: `fake-access-${name}`,
	refresh: `fake-refresh-${name}`,
	expires: Date.now() + 30 * 86_400_000,
});

/** Env vars stock reads a key, a token or an endpoint from: the user's own must never reach a fixture. */
const AMBIENT =
	/(_API_KEY|_TOKEN|_BASE_URL|_ENDPOINT|_HOST|_URL)$|^(OLLAMA_HOST|AWS_PROFILE|GOOGLE_APPLICATION_CREDENTIALS)$/;

interface PlanProbe {
	review: { role: string; model: string | null; checked: boolean; reason: { rule: string } } | null;
	resolved: string | null;
	unchanged: boolean;
	rowsApplied: string[];
	config: Record<string, unknown>;
}

function runPlan(providers: string[]): PlanProbe {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-plan-review-"));
	chmodSync(isolated, 0o700);
	try {
		cpSync(resolve("resources/gui-bridge"), join(isolated, "bridge"), { recursive: true });
		const extension = join(isolated, "bridge", "plan-review-probe.ts");
		writeFileSync(extension, PROBE);
		const env: Record<string, string | undefined> = { ...process.env };
		for (const key of Object.keys(env)) if (AMBIENT.test(key)) Reflect.deleteProperty(env, key);
		Object.assign(env, {
			HOME: isolated,
			PI_CODING_AGENT_DIR: isolated,
			PI_CONFIG_DIR: isolated,
			OMP_PROFILE: "",
			PI_PROFILE: "",
			OMP_GUI_OMPDESK_ROLES: join(isolated, "ompdesk-roles.json"),
			ROLE_PLAN: resolve("src/shared/role-plan.ts"),
			PLAN_SEED: JSON.stringify(providers.map(provider => [provider, [oauth(provider)]])),
		});
		const seeder = join(isolated, "seed.ts");
		writeFileSync(seeder, SEED);
		const seeded = spawnSync(bun, [seeder, isolated], { cwd: isolated, env, encoding: "utf8", timeout: 60_000 });
		expect(seeded.status, seeded.stderr).toBe(0);
		const result = spawnSync(
			omp,
			["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-rules", "-e", extension],
			{ cwd: isolated, env, encoding: "utf8", timeout: 150_000, maxBuffer: 16 * 1024 * 1024, input: "" },
		);
		const line = result.stderr.split("\n").find(value => value.startsWith("PLAN_PROBE"));
		expect(line, result.stderr.slice(-2500)).toMatch(/^PLAN_PROBE=/);
		const configFile = join(isolated, "config.yml");
		return {
			...(JSON.parse(line?.slice("PLAN_PROBE=".length) ?? "{}") as Omit<PlanProbe, "config">),
			config: existsSync(configFile)
				? ((parse(readFileSync(configFile, "utf8")) ?? {}) as Record<string, unknown>)
				: {},
		};
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
}

describe.skipIf(!existsSync(omp))("model setup plan → apply → @review", () => {
	for (const providers of [["anthropic"], ["anthropic", "openai-codex"]])
		it(`runs review on the planned model without touching config.yml (${providers.join(" + ")})`, () => {
			const probe = runPlan(providers);
			expect(probe.review?.model, JSON.stringify(probe.review)).toBeTruthy();
			expect(providers).toContain(probe.review?.model?.split("/")[0]);
			expect(probe.resolved).toBe(probe.review?.model);
			expect(probe.unchanged).toBe(true);
			expect(probe.rowsApplied).toContain("review");
			expect(Object.keys((probe.config.modelRoles as Record<string, string> | undefined) ?? {})).not.toContain(
				"review",
			);
		}, 160_000);
});
