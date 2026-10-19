import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * OMPdesk's own model roles and agent tiers on the installed omp, in an empty private agent dir (a throwaway
 * OpenAI key only gives the catalog models; nothing is prompted):
 *
 * - `review` is listed with origin `ompdesk`, `@review` resolves through stock for an agent, a subagent's overlay
 *   settings and stock's role list, and follows the advisor while nothing is picked;
 * - a pick through `model_role_set` is held at runtime and stored in the shared picks file: config.yml keeps its
 *   bytes, a runtime role set by someone else (a CLI flag) survives, clearing the pick returns to the chain;
 * - a value the user's config.yml sets for `review` or for the security reviewer's model wins and is not overridden;
 * - stock's bundled `security-reviewer` (no `model:` line) runs on `@review` instead of the parent's model, and a
 *   user's own agent file of that name keeps its model line.
 */
const omp = join(homedir(), ".bun", "bin", "omp");

const PROBE = `
import * as fs from "node:fs";
import * as path from "node:path";
import { methods } from "./settings";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import { getKnownRoleIds } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { resolveAgentModelSelection, resolveConfiguredModelPatterns, resolveModelOverride } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
export default function (pi) {
 pi.on("session_start", async () => {
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = { pi, session: () => session, context: () => undefined, emit: () => {} };
   const { settings, modelRegistry } = session;
   const sel = model => model.provider + "/" + model.id;
   const config = path.join(process.env.PI_CODING_AGENT_DIR, "config.yml");
   const bytes = () => (fs.existsSync(config) ? fs.readFileSync(config, "utf8") : null);
   const chat = modelRegistry.getAvailable().filter(model => modelKind(model) === "chat");
   const A = sel(chat[0]);
   const B = sel(chat.find(model => sel(model) !== A));
   const PARENT = sel(chat.find(model => sel(model) !== A && sel(model) !== B));
   const resolve = patterns => {
    const { model } = resolveModelOverride(patterns, modelRegistry, settings);
    return model ? sel(model) : null;
   };
   const roles = async () => Object.fromEntries((await methods.model_roles({}, env)).roles.map(role => [role.id, role]));
   const set = (role, value) => methods.model_role_set({ role, modelId: value }, env);
   const picks = () => (fs.existsSync(process.env.OMP_GUI_OMPDESK_ROLES) ? JSON.parse(fs.readFileSync(process.env.OMP_GUI_OMPDESK_ROLES, "utf8")) : null);
   const security = () => {
    const overrides = lookup("task.agentModelOverrides").get(settings);
    const { patterns, role } = resolveAgentModelSelection({
     agentModel: getBundledAgent("security-reviewer").model,
     settingsOverride: overrides["security-reviewer"],
     settings,
     activeModelPattern: PARENT,
    });
    return { model: resolve(patterns), role: role ?? null };
   };
   const row = all => all.review ? { origin: all.review.origin, model: all.review.model ?? null, effective: all.review.effective } : null;
   const out = { A, B, PARENT, chat: chat.map(sel) };
   const configBefore = bytes();
   // A runtime role from someone else (stock's --plan flag does this): must survive every OMPdesk write.
   settings.overrideModelRoles({ plan: B });

   let all = await roles();
   out.ids = Object.keys(all);
   out.empty = row(all);
   out.advisor = all.advisor.effective.model ?? null;
   out.emptyReview = resolve(["@review"]);
   out.emptyAgent = resolve(resolveConfiguredModelPatterns(["@review", "@slow", "@task"], settings));
   out.knownHasReview = getKnownRoleIds(settings).includes("review");
   out.securityEmpty = security();

   await set("review", A);
   all = await roles();
   out.picked = row(all);
   out.pickedReview = resolve(["@review"]);
   out.pickedChild = resolve(resolveConfiguredModelPatterns(["@review"], settings.overlay({})));
   out.securityPicked = security();
   out.picks = picks();
   out.plan = settings.getModelRole("plan") ?? null;
   // Any save stock queued has landed once flush settles.
   await settings.flush();
   out.configUnchanged = bytes() === configBefore;
   out.globalReview = settings.getGlobalModelRole("review") ?? null;

   await set("review", null);
   all = await roles();
   out.cleared = row(all);
   out.clearedReview = resolve(["@review"]);
   out.clearedPicks = picks();

   // A user's own security-reviewer agent with a model line keeps it (the held tier outranks agent files).
   out.hook = "missing";
   try {
    const module = await import("./ompdesk-roles");
    const handlers = {};
    module.install({ ...pi, pi: pi.pi, on: (name, handler) => { handlers[name] = handler; } });
    const project = fs.mkdtempSync(path.join(process.env.ROLES_PROBE_TMP, "project-"));
    const event = { type: "before_subagent_spawn", agent: "security-reviewer", invocationKind: "task", patterns: [] };
    out.hookBundled = (await handlers.before_subagent_spawn(event, { cwd: project })) ?? null;
    fs.mkdirSync(path.join(project, ".omp", "agents"), { recursive: true });
    fs.writeFileSync(path.join(project, ".omp", "agents", "security-reviewer.md"), "---\\nname: security-reviewer\\ndescription: mine\\nmodel: " + B + "\\n---\\nReview.\\n");
    out.hookOwn = (await handlers.before_subagent_spawn(event, { cwd: project })) ?? null;
    out.hook = "installed";
   } catch (error) {
    out.hookError = String(error);
   }
   console.error("OMPDESK_ROLES_PROBE=" + JSON.stringify(out));
   process.exit(0);
  } catch (error) {
   console.error("OMPDESK_ROLES_PROBE_FAILED " + (error instanceof Error ? error.stack : String(error)));
   process.exit(1);
  }
 });
}
`;

interface Row {
	origin: string;
	model: string | null;
	effective: { model?: string; source: string; via?: string };
}

interface Probe {
	A: string;
	B: string;
	PARENT: string;
	chat: string[];
	ids: string[];
	empty: Row | null;
	advisor: string | null;
	emptyReview: string | null;
	emptyAgent: string | null;
	knownHasReview: boolean;
	securityEmpty: { model: string | null; role: string | null };
	picked: Row | null;
	pickedReview: string | null;
	pickedChild: string | null;
	securityPicked: { model: string | null; role: string | null };
	picks: Record<string, string> | null;
	plan: string | null;
	configUnchanged: boolean;
	globalReview: string | null;
	cleared: Row | null;
	clearedReview: string | null;
	clearedPicks: Record<string, string> | null;
	hook: string;
	hookBundled: unknown;
	hookOwn: unknown;
}

function runProbe(config: string): Probe {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-own-roles-"));
	chmodSync(isolated, 0o700);
	try {
		cpSync(resolve("resources/gui-bridge"), join(isolated, "bridge"), { recursive: true });
		const extension = join(isolated, "bridge", "ompdesk-roles-probe.ts");
		writeFileSync(extension, PROBE);
		if (config) writeFileSync(join(isolated, "config.yml"), config);
		const env: Record<string, string | undefined> = {
			...process.env,
			PI_CODING_AGENT_DIR: isolated,
			PI_CONFIG_DIR: isolated,
			OMP_PROFILE: "",
			PI_PROFILE: "",
			OPENAI_API_KEY: "probe-not-a-real-key",
			OMP_GUI_OMPDESK_ROLES: join(isolated, "ompdesk-roles.json"),
			ROLES_PROBE_TMP: isolated,
		};
		for (const key of [
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_OAUTH_TOKEN",
			"CLAUDE_CODE_OAUTH_TOKEN",
			"OPENROUTER_API_KEY",
			"TYPESAFE_API_KEY",
		])
			Reflect.deleteProperty(env, key);
		const result = spawnSync(
			omp,
			["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-rules", "-e", extension],
			{ env, cwd: isolated, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024, input: "" },
		);
		const line = result.stderr.split("\n").find(value => value.startsWith("OMPDESK_ROLES_PROBE"));
		expect(line, result.stderr.slice(-2500)).toMatch(/^OMPDESK_ROLES_PROBE=/);
		return JSON.parse(line?.slice("OMPDESK_ROLES_PROBE=".length) ?? "{}") as Probe;
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
}

describe.skipIf(!existsSync(omp))("OMPdesk roles on stock omp", () => {
	it("holds review at runtime, resolves it for agents and subagents, and gives the security reviewer a tier", () => {
		const probe = runProbe("");
		const { A, B, PARENT } = probe;
		expect(new Set([A, B, PARENT]).size).toBe(3);

		// Listed after stock's roles, following the advisor while nothing is picked.
		expect(probe.ids.at(-1)).toBe("review");
		expect(probe.empty).toMatchObject({ origin: "ompdesk", model: null });
		expect(probe.empty?.effective).toMatchObject({ source: "fallback", via: "advisor" });
		// Empty, it runs on the model stock's advisor selection picks (the distinct strong model).
		expect(probe.emptyReview).not.toBeNull();
		expect(probe.emptyReview).toBe(probe.advisor);
		expect(probe.empty?.effective.model).toBe(probe.emptyReview);
		expect(probe.emptyAgent).toBe(probe.emptyReview);
		expect(probe.knownHasReview).toBe(true);
		// Bundled security-reviewer: before, the parent's model; now `@review`.
		expect(probe.securityEmpty).toEqual({ model: probe.emptyReview, role: "review" });
		expect(probe.securityEmpty.model).not.toBe(PARENT);

		// A pick: held at runtime, seen by a subagent's overlay, stored in the picks file, config.yml untouched.
		expect(probe.picked).toMatchObject({
			origin: "ompdesk",
			model: A,
			effective: { model: A, source: "configured" },
		});
		expect(probe.pickedReview).toBe(A);
		expect(probe.pickedChild).toBe(A);
		expect(probe.securityPicked).toEqual({ model: A, role: "review" });
		expect(probe.picks).toEqual({ review: A });
		expect(probe.configUnchanged).toBe(true);
		expect(probe.globalReview).toBeNull();
		expect(probe.plan).toBe(B);

		// Cleared: back on the chain, the pick gone from the file.
		expect(probe.cleared).toMatchObject({ model: null, effective: { source: "fallback", via: "advisor" } });
		expect(probe.clearedReview).toBe(probe.emptyReview);
		expect(probe.clearedPicks).toEqual({});

		// The held tier yields to a user's own agent file of that name.
		expect(probe.hook).toBe("installed");
		expect(probe.hookBundled).toBeNull();
		expect(probe.hookOwn).toEqual({ model: [B] });
	}, 130_000);

	it("leaves review and the security reviewer's model to the user's config", () => {
		const first = runProbe("");
		const own = first.chat.find(model => ![first.A, first.emptyReview].includes(model)) ?? first.B;
		const probe = runProbe(
			`modelRoles:\n  review: ${own}\ntask:\n  agentModelOverrides:\n    security-reviewer: ${own}\n`,
		);
		expect(probe.empty).toMatchObject({
			origin: "ompdesk",
			model: own,
			effective: { model: own, source: "configured" },
		});
		expect(probe.emptyReview).toBe(own);
		expect(probe.securityEmpty.model).toBe(own);
		// The pick for a role the user's config owns is written where they keep it.
		expect(probe.globalReview).toBe(probe.A);
		expect(probe.picks).toBeNull();
	}, 260_000);
});
