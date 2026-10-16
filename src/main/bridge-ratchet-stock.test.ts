import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Pins Ratchet to the installed omp, in an empty private agent dir (no model is called):
 * - the bridge's `ratchet` feature is available (`tools/settings` `cfgRatchetEnabled` get/override, `getEvalPreludes`);
 * - `modes.get_ratchet` reads stock's `ratchet.enabled` (off by default) and names the required tools (`eval`, `task`)
 *   that are not active, which is exactly stock `prepareRatchet`'s refusal;
 * - `modes.set_ratchet` turns it on only when those tools are active and the `ratchet` eval prelude exists, otherwise
 *   it refuses with stock's wording, and turning it off writes `ratchet.enabled` false for the session only;
 * - the automatic mode choice counts Ratchet as a mode the user picked (never auto-enabled).
 */
const omp = join(homedir(), ".bun", "bin", "omp");

const PROBE = `
import { methods } from "./modes/ratchet";
import { methods as autoMode } from "./modes/auto-mode";
import { capabilitiesFor } from "./probe-helper";
export default function (pi) {
 pi.on("session_start", async () => {
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = { pi, session: () => session, context: () => undefined, emit: () => {} };
   const out = {};
   out.unavailable = await capabilitiesFor(env);
   out.tools = session.getEnabledToolNames();
   out.before = await methods["modes.get_ratchet"]({}, env);
   try { out.on = await methods["modes.set_ratchet"]({ enabled: true }, env); } catch (e) { out.onError = String(e.message || e); }
   out.afterOn = await methods["modes.get_ratchet"]({}, env);
   out.activeDecision = await autoMode["modes.auto_mode_decide"]({ message: "refactor the whole settings module across all files" }, env);
   out.off = await methods["modes.set_ratchet"]({ enabled: false }, env);
   console.error("RT_PROBE=" + JSON.stringify(out));
  } catch (err) {
   console.error("RT_PROBE_ERROR=" + String(err && err.stack || err));
  }
  process.exit(0);
 });
}
`;

const HELPER = `
import { probe } from "./health";
export async function capabilitiesFor(env) {
 return (await probe(env, ["ratchet"])).map(entry => ({ feature: entry.feature, missing: entry.missing }));
}
`;

interface State {
	enabled: boolean;
	missing: string[];
}

interface Probe {
	unavailable: Array<{ feature: string; missing: string[] }>;
	tools: string[];
	before: State;
	on?: State;
	onError?: string;
	afterOn: State;
	activeDecision: { mode: string; reason?: string };
	off: State;
}

function run(): Probe {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-rt-"));
	chmodSync(isolated, 0o700);
	try {
		cpSync(resolve("resources/gui-bridge"), join(isolated, "bridge"), { recursive: true });
		const bridge = join(isolated, "bridge");
		writeFileSync(join(bridge, "rt-probe.ts"), PROBE);
		writeFileSync(join(bridge, "probe-helper.ts"), HELPER);
		writeFileSync(join(isolated, "config.yml"), "modelRoles:\n  smol: openai/gpt-5-mini\n  default: openai/gpt-5\n");
		const project = join(isolated, "project");
		mkdirSync(project, { recursive: true });
		const env: Record<string, string | undefined> = {
			...process.env,
			PI_CODING_AGENT_DIR: isolated,
			PI_CONFIG_DIR: isolated,
			OMP_PROFILE: "",
			PI_PROFILE: "",
			OPENAI_API_KEY: "probe-not-a-real-key",
		};
		for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"])
			Reflect.deleteProperty(env, key);
		const result = spawnSync(
			omp,
			[
				"--mode",
				"rpc",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-rules",
				"-e",
				join(bridge, "rt-probe.ts"),
			],
			{ cwd: project, env, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024, input: "" },
		);
		const line = result.stderr.split("\n").find(value => value.startsWith("RT_PROBE="));
		expect(line, result.stderr.slice(-2500)).toMatch(/^RT_PROBE=/);
		return JSON.parse(line?.slice("RT_PROBE=".length) ?? "{}") as Probe;
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
}

describe.skipIf(!existsSync(omp))("Ratchet on stock omp", () => {
	it("reads stock's setting, refuses without its tools and is a mode the automatic choice never overrides", () => {
		const probe = run();
		expect(probe.unavailable).toEqual([]);
		expect(probe.before.enabled).toBe(false);
		const missing = ["eval", "task"].filter(tool => !probe.tools.includes(tool));
		expect(probe.before.missing).toEqual(missing);
		if (missing.length > 0) {
			expect(probe.onError).toBe(`Ratchet needs the ${missing.join(" and ")} tool active.`);
			expect(probe.afterOn.enabled).toBe(false);
		} else if (probe.onError === undefined) {
			expect(probe.on?.enabled).toBe(true);
			expect(probe.afterOn.enabled).toBe(true);
			// Ratchet on is a mode the user picked: the automatic choice stays out.
			expect(probe.activeDecision).toEqual({ mode: "none", reason: "mode_active", latencyMs: 0 });
		} else {
			// Tools present but stock has no ratchet prelude in this session: refused, nothing left on.
			expect(probe.onError).toBe("The ratchet eval prelude is unavailable in this session.");
			expect(probe.afterOn.enabled).toBe(false);
		}
		expect(probe.off.enabled).toBe(false);
	}, 130_000);
});
