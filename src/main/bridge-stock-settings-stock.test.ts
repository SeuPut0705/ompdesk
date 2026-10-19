import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The settings the bridge reads are the user's, on the installed omp.
 *
 * omp maps a bridge's `@oh-my-pi/*` import onto the running omp's module only when its bundle registers that
 * subpath; any other subpath falls back to the package's source file, a second module graph with its own settings
 * registry whose handles read other settings' slots (`goal.enabled` read `[]` on omp 18.12.2). With
 * `plan.enabled`, `goal.enabled` and `security.enabled` false in config.yml:
 * - the automatic mode choice asks no model ("unavailable", no latency);
 * - a guided goal is refused as disabled;
 * - a security scan is refused as disabled (stock's own coordinator, through its tool);
 * - every stock module the bridge loads is this omp's own, except the copies capabilities.ts `COPY_SAFE` lists
 *   (each one loaded, none stale), and no feature is refused for a copy.
 */
const omp = join(homedir(), ".bun", "bin", "omp");

const PROBE = `
import { methods as autoMode } from "./modes/auto-mode";
import { methods as goal } from "./modes/goal";
import { methods as security } from "./security";
import { probe, stockCopies } from "./health";
import { COPY_SAFE } from "./capabilities";
export default function (pi) {
 pi.on("session_start", async () => {
  const out = {};
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = { pi, session: () => session, context: () => undefined, emit: () => {} };
   out.decision = await autoMode["modes.auto_mode_decide"]({ message: "refactor the whole settings module across all files and add tests" }, env);
   try {
    await goal["modes.guided_goal"]({}, env);
    out.guided = "started";
   } catch (error) {
    out.guided = String(error && error.message || error);
   }
   try {
    await security.security_start({ target: { kind: "repository" } }, env);
    out.security = "started";
   } catch (error) {
    out.security = String(error && error.message || error);
   }
   out.copies = stockCopies().sort();
   out.copySafe = Object.keys(COPY_SAFE).sort();
   out.refusedForCopy = (await probe(env)).filter(entry => entry.missing.some(label => label.includes("separate copy")));
  } catch (err) {
   out.error = String(err && err.stack || err);
  }
  console.error("SETTINGS_PROBE=" + JSON.stringify(out));
  process.exit(0);
 });
}
`;

interface Probe {
	decision?: { mode: string; reason?: string; latencyMs: number };
	guided?: string;
	security?: string;
	copies?: string[];
	copySafe?: string[];
	refusedForCopy?: unknown[];
	error?: string;
}

function run(config: string): Probe {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-settings-"));
	chmodSync(isolated, 0o700);
	try {
		cpSync(resolve("resources/gui-bridge"), join(isolated, "bridge"), { recursive: true });
		const bridge = join(isolated, "bridge");
		writeFileSync(join(bridge, "settings-probe.ts"), PROBE);
		writeFileSync(join(isolated, "config.yml"), config);
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
		for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENROUTER_API_KEY"])
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
				join(bridge, "settings-probe.ts"),
			],
			{ cwd: project, env, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024, input: "" },
		);
		const line = result.stderr.split("\n").find(value => value.startsWith("SETTINGS_PROBE="));
		expect(line, result.stderr.slice(-2500)).toMatch(/^SETTINGS_PROBE=/);
		return JSON.parse(line?.slice("SETTINGS_PROBE=".length) ?? "{}") as Probe;
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
}

describe.skipIf(!existsSync(omp))("stock settings the bridge reads", () => {
	it("are the user's, read through this omp's own modules", () => {
		const probe = run("plan:\n  enabled: false\ngoal:\n  enabled: false\nsecurity:\n  enabled: false\n");
		expect(probe.error).toBeUndefined();
		expect(probe.decision).toEqual({ mode: "none", reason: "unavailable", latencyMs: 0 });
		expect(probe.guided).toMatch(/Goal mode is disabled/);
		expect(probe.security).toMatch(/Security is disabled/);
		expect(probe.copies).toEqual(probe.copySafe);
		expect(probe.refusedForCopy).toEqual([]);
	}, 130_000);
});
