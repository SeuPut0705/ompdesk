import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { ModelSetupFacts } from "../../resources/gui-bridge/model-setup-contracts";
import { billingOf, fullAutoAllows, type PlanRoleInput, type PlanRow, planRoles } from "../shared/role-plan";

/**
 * Pins the model setup's billing classification to stock's own auth data, on the installed omp in a private agent
 * dir (fake tokens only: nothing is prompted, no model is called, no user data is read). Each fixture is a real
 * stock credential or models.yml entry; the probe runs the bridge's `model_roles` and `model_setup_facts` and
 * `planRoles` then plans over exactly what the bridge reported:
 *
 * - full auto never reaches a metered model (API key, OpenRouter, OAuth + key, a models.yml endpoint on any host,
 *   a catalog runtime whose endpoint moved); the one exception is a stock judge model pinned by stock's defaults;
 * - a keyless local runtime on its stock endpoint is free, a stock OAuth login alone is a subscription;
 * - picked mode may use what the person ticked, metered included.
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
import { methods, providerBillings } from "./model-setup-facts";
import { methods as settingsMethods } from "./settings";
export default function (pi) {
 pi.on("session_start", async () => {
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = { pi, session: () => session, context: () => undefined, emit: () => {} };
   const roles = (await settingsMethods.model_roles({}, env)).roles;
   const started = performance.now();
   const facts = await methods.model_setup_facts({}, env);
   const factsMs = performance.now() - started;
   const extra = providerBillings(session, JSON.parse(process.env.METERING_EXTRA));
   fs.writeFileSync(process.env.METERING_OUT, JSON.stringify({
    roles: roles.map(role => ({
     id: role.id,
     section: role.section,
     hidden: role.hidden,
     model: role.model,
     candidates: role.candidates.map(candidate => ({ provider: candidate.provider, id: candidate.id, kind: candidate.kind })),
    })),
    facts,
    extra,
    factsMs,
   }));
   process.exit(0);
  } catch (error) {
   console.error("METERING_PROBE_FAILED " + (error instanceof Error ? error.stack : String(error)));
   process.exit(1);
  }
 });
}
`;

/** Stock's own AuthStorage writes the fixtures into the private dir's agent.db before omp starts (no session exists without a credential). */
const SEED = `
import { discoverAuthStorage } from ${JSON.stringify(sdk)};
const auth = await discoverAuthStorage(process.argv[2]);
for (const [provider, credentials] of JSON.parse(process.env.METERING_SEED)) await auth.credentials.set(provider, credentials);
process.exit(0);
`;

interface ProbeRole {
	id: string;
	section: "chat" | "kind";
	hidden?: boolean;
	model?: string;
	candidates: { provider: string; id: string; kind: string }[];
}

interface ProbeOutput {
	roles: ProbeRole[];
	facts: ModelSetupFacts;
	extra: Record<string, { billing: string; basis: string }>;
	factsMs: number;
}

type Seed = [provider: string, credentials: unknown][];

const FAKE_EXPIRY = Date.now() + 30 * 86_400_000;
const oauth = (name: string) => ({
	type: "oauth",
	access: `fake-access-${name}`,
	refresh: `fake-refresh-${name}`,
	expires: FAKE_EXPIRY,
});
const apiKey = (name: string) => ({ type: "api_key", key: `fake-key-${name}` });

/** Env vars stock reads a key, a token or an endpoint from: the user's own must never reach a fixture. */
const AMBIENT =
	/(_API_KEY|_TOKEN|_BASE_URL|_ENDPOINT|_HOST|_URL)$|^(OLLAMA_HOST|AWS_PROFILE|GOOGLE_APPLICATION_CREDENTIALS)$/;

function runProbe(options: {
	seed?: Seed;
	extra?: string[];
	modelsYml?: string;
	env?: Record<string, string>;
}): ProbeOutput {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-metering-"));
	chmodSync(isolated, 0o700);
	try {
		cpSync(resolve("resources/gui-bridge"), join(isolated, "bridge"), { recursive: true });
		const extension = join(isolated, "bridge", "model-setup-metering-probe.ts");
		writeFileSync(extension, PROBE);
		if (options.modelsYml) writeFileSync(join(isolated, "models.yml"), options.modelsYml);
		const spawnEnv: Record<string, string | undefined> = { ...process.env };
		for (const key of Object.keys(spawnEnv)) if (AMBIENT.test(key)) Reflect.deleteProperty(spawnEnv, key);
		Object.assign(spawnEnv, {
			HOME: isolated,
			PI_CODING_AGENT_DIR: isolated,
			PI_CONFIG_DIR: isolated,
			OMP_PROFILE: "",
			PI_PROFILE: "",
			METERING_SEED: JSON.stringify(options.seed ?? []),
			METERING_EXTRA: JSON.stringify(options.extra ?? []),
			METERING_OUT: join(isolated, "probe-out.json"),
			...options.env,
		});
		if (options.seed?.length) {
			const seeder = join(isolated, "seed.ts");
			writeFileSync(seeder, SEED);
			const seeded = spawnSync(bun, [seeder, isolated], {
				cwd: isolated,
				env: spawnEnv,
				encoding: "utf8",
				timeout: 60_000,
			});
			expect(seeded.status, seeded.stderr).toBe(0);
		}
		const result = spawnSync(
			omp,
			["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-rules", "-e", extension],
			{ cwd: isolated, env: spawnEnv, encoding: "utf8", timeout: 150_000, maxBuffer: 16 * 1024 * 1024, input: "" },
		);
		expect(existsSync(join(isolated, "probe-out.json")), result.stderr.slice(-2500)).toBe(true);
		return JSON.parse(readFileSync(join(isolated, "probe-out.json"), "utf8")) as ProbeOutput;
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
}

const MODELS_YML = `providers:
  acme-gateway:
    baseUrl: https://llm.example.com/v1
    apiKey: fake-acme-key
    api: openai-completions
    models:
      - id: acme-large
  loopback-proxy:
    baseUrl: http://127.0.0.1:4000/v1
    auth: none
    api: openai-completions
    models:
      - id: proxied-paid
  lm-studio:
    baseUrl: http://192.168.7.20:1234/v1
    auth: none
    api: openai-completions
    models:
      - id: moved-local
`;

function toPlanRoles(probe: ProbeOutput): PlanRoleInput[] {
	return probe.roles.map(role => ({
		id: role.id,
		section: role.section,
		...(role.hidden ? { hidden: true } : {}),
		candidates: role.candidates.map(candidate => `${candidate.provider}/${candidate.id}`),
		...(role.model ? { current: role.model } : {}),
	}));
}

const withModel = (rows: PlanRow[]) => rows.flatMap(row => (row.model ? [{ ...row, model: row.model }] : []));

describe.skipIf(!existsSync(omp))("model setup billing and metering on stock's auth data", () => {
	let probe: ProbeOutput;
	let moved: ProbeOutput;
	let full: PlanRow[];
	let picked: PlanRow[];
	let pickedModel: string;

	beforeAll(() => {
		probe = runProbe({
			seed: [
				["anthropic", [oauth("anthropic")]],
				["openai-codex", [oauth("codex")]],
				["openrouter", [apiKey("openrouter")]],
				["github-copilot", [oauth("copilot"), apiKey("copilot")]],
			],
			extra: ["apple", "llama.cpp", "ollama", "lm-studio", "local", "web", "no-such-provider"],
			modelsYml: MODELS_YML,
		});
		moved = runProbe({
			seed: [["anthropic", [oauth("anthropic")]]],
			extra: ["lm-studio", "ollama", "llama.cpp", "apple"],
			env: { LM_STUDIO_BASE_URL: "http://10.0.0.9:1234/v1", OLLAMA_HOST: "10.0.0.8:11434" },
		});
		const roles = toPlanRoles(probe);
		full = planRoles({ mode: "full", roles, facts: probe.facts });
		const openrouterChat = Object.entries(probe.facts.models).find(
			([selector, model]) => selector.startsWith("openrouter/") && model.kind === "chat",
		);
		pickedModel = openrouterChat?.[0] ?? "";
		picked = planRoles({ mode: "picked", roles, facts: probe.facts, picked: [pickedModel] });
	}, 300_000);

	it("sees OpenRouter chat models, so the metering checks are not vacuous", () => {
		expect(pickedModel).toMatch(/^openrouter\//);
		const pool = probe.roles.find(role => role.id === "default")?.candidates ?? [];
		expect(pool.some(candidate => candidate.provider === "openrouter" && candidate.kind === "chat")).toBe(true);
		expect(probe.facts.providers.anthropic).toBeDefined();
		expect(probe.facts.providers["acme-gateway"]).toBeDefined();
		expect(probe.facts.providers["loopback-proxy"]).toBeDefined();
		expect(Object.keys(probe.facts.roles).sort()).toEqual(probe.roles.map(role => role.id).sort());
	});

	it("classifies each account the way stock holds it", () => {
		const providers = probe.facts.providers;
		expect(providers.anthropic).toEqual({ billing: "subscription", basis: "oauth" });
		expect(providers["openai-codex"]).toEqual({ billing: "subscription", basis: "oauth" });
		expect(providers.openrouter).toEqual({ billing: "metered", basis: "api-key" });
		expect(providers["github-copilot"]).toEqual({ billing: "metered", basis: "oauth-and-key" });
		expect(providers["acme-gateway"]).toEqual({ billing: "metered", basis: "custom-endpoint" });
		expect(providers["loopback-proxy"]).toEqual({ billing: "metered", basis: "custom-endpoint" });
		expect(providers["lm-studio"]?.billing).toBe("metered");
		expect(["base-url-changed", "custom-endpoint"]).toContain(providers["lm-studio"]?.basis);
	});

	it("counts a keyless catalog runtime free only on its stock endpoint", () => {
		for (const provider of ["apple", "llama.cpp", "ollama", "local"]) {
			expect(probe.extra[provider], provider).toEqual({ billing: "free", basis: "local-keyless" });
		}
		// Stock's keyless `web` search routes to search APIs that may bill: never free.
		expect(probe.extra.web?.billing).toBe("metered");
		// A models.yml entry moves lm-studio in the first run, the stock endpoint env vars in the second.
		expect(probe.extra["lm-studio"]?.billing).toBe("metered");
		expect(moved.extra["lm-studio"]).toEqual({ billing: "metered", basis: "base-url-changed" });
		expect(moved.extra.ollama).toEqual({ billing: "metered", basis: "base-url-changed" });
		expect(moved.extra["llama.cpp"]).toEqual({ billing: "free", basis: "local-keyless" });
		expect(moved.extra.apple).toEqual({ billing: "free", basis: "local-keyless" });
	});

	it("fails closed on a provider the facts do not name", () => {
		expect(probe.extra["no-such-provider"]?.billing).toBe("metered");
		expect(billingOf(probe.facts, "no-such-provider/model")).toBe("metered");
		expect(fullAutoAllows(probe.facts, "no-such-provider/model")).toBe(false);
		expect(billingOf(probe.facts, "acme-gateway/not-listed-either")).toBe("metered");
	});

	it("plans full auto over subscription and free models only", () => {
		const assigned = withModel(full);
		expect(assigned.length).toBeGreaterThan(0);
		for (const row of assigned) {
			const judgeException =
				row.role === "judge" &&
				probe.facts.models[row.model]?.kind === "judge" &&
				probe.facts.judgePins.includes(row.model);
			if (!judgeException) {
				expect(billingOf(probe.facts, row.model), `${row.role} → ${row.model}`).not.toBe("metered");
			}
		}
		// The assigned models really come from the subscription accounts.
		for (const row of assigned) expect(row.model).toMatch(/^(anthropic|openai-codex|apple|ollama|llama\.cpp)\//);
	});

	it("never writes a model kind role or a jev-latest alias in full auto", () => {
		for (const row of full) {
			if (probe.roles.find(role => role.id === row.role)?.section === "kind") expect(row.model, row.role).toBeNull();
			expect(row.model ?? "").not.toContain("jev-latest");
		}
		expect(probe.facts.judgePins.length).toBeGreaterThan(0);
		for (const pin of probe.facts.judgePins) {
			expect(pin).not.toContain("jev-latest");
			expect(probe.facts.models[pin]?.kind, pin).toBe("judge");
		}
		expect(new Set(probe.facts.judgePins).size).toBe(probe.facts.judgePins.length);
	});

	it("keeps the loopback proxy, the custom endpoint and the moved local runtime out of full auto", () => {
		const assigned = withModel(full).map(row => row.model);
		for (const model of assigned) {
			expect(model).not.toMatch(/^(loopback-proxy|acme-gateway|lm-studio|openrouter|github-copilot)\//);
		}
		for (const selector of ["loopback-proxy/proxied-paid", "lm-studio/moved-local", "acme-gateway/acme-large"]) {
			expect(probe.facts.models[selector], selector).toBeDefined();
			expect(assigned).not.toContain(selector);
		}
	});

	it("lets picked mode assign the OpenRouter model the person ticked", () => {
		const chat = picked.filter(row => probe.roles.find(role => role.id === row.role)?.section === "chat");
		expect(chat.some(row => row.model === pickedModel)).toBe(true);
		for (const row of withModel(picked)) expect(row.model).toBe(pickedModel);
	});

	it("reports each model with the facts the planner ranks by", () => {
		const model = probe.facts.models[pickedModel];
		expect(model?.provider).toBe("openrouter");
		expect(model?.kind).toBe("chat");
		expect(typeof model?.image).toBe("boolean");
		const anthropic = Object.values(probe.facts.models).filter(entry => entry.provider === "anthropic");
		expect(anthropic.length).toBeGreaterThan(0);
		expect(anthropic.some(entry => entry.int !== undefined && entry.outputPrice !== undefined)).toBe(true);
		expect(anthropic.every(entry => entry.family === undefined || typeof entry.family === "string")).toBe(true);
	});

	it("answers within the full auto budget", () => {
		expect(probe.factsMs).toBeLessThan(2000);
	});
});
