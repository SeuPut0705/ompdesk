import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Pins OMPdesk's `goal.continuationModes` default to the installed omp, in an
 * empty private agent dir (no model call, nothing prompted). Stock continues a
 * goal between turns over RPC only when the setting lists "rpc" (default
 * `["interactive"]`), so OMPdesk's sessions hold it with "rpc" added as a
 * runtime override:
 *
 * - with no layer setting it, the effective value includes "rpc", is reported as
 *   `runtime`, and config.yml is never written;
 * - a Settings write releases it and wins; resetting it brings the default back;
 * - a value already in config.yml is the user's and wins.
 */
const omp = join(homedir(), ".bun", "bin", "omp");

const PROBE = `
import { methods } from "./settings";
export default function (pi) {
 const ready = import("./thinking-default").then(module => module.applyGuiThinkingDefault(pi));
 pi.on("session_start", async () => {
  try {
   await ready;
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = { pi, session: () => session, context: () => undefined, emit: () => {} };
   const read = async () => {
    const { values, provenance } = await methods.settings_get({ paths: ["goal.continuationModes"] }, env);
    return { value: values["goal.continuationModes"], layers: provenance["goal.continuationModes"].layers };
   };
   const out = { initial: await read() };
   if (process.env.GOAL_PROBE_WRITE === "1") {
    await methods.settings_set({ path: "goal.continuationModes", value: ["interactive"] }, env);
    out.written = await read();
    await methods.settings_set({ path: "goal.continuationModes", value: undefined }, env);
    out.reset = await read();
   }
   console.error("GOAL_PROBE=" + JSON.stringify(out));
  } catch (err) {
   console.error("GOAL_PROBE_ERROR=" + String(err && err.stack || err));
  }
  process.exit(0);
 });
}
`;

interface Reading {
	value: string[];
	layers: string[];
}

function runProbe(configYml: string | undefined, write: boolean) {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-goal-"));
	chmodSync(isolated, 0o700);
	try {
		cpSync(resolve("resources/gui-bridge"), join(isolated, "bridge"), { recursive: true });
		const extension = join(isolated, "bridge", "goal-probe.ts");
		writeFileSync(extension, PROBE);
		const configPath = join(isolated, "config.yml");
		if (configYml !== undefined) writeFileSync(configPath, configYml);
		const env: Record<string, string | undefined> = {
			...process.env,
			PI_CODING_AGENT_DIR: isolated,
			PI_CONFIG_DIR: isolated,
			OMP_PROFILE: "",
			PI_PROFILE: "",
			OPENAI_API_KEY: "probe-not-a-real-key",
			GOAL_PROBE_WRITE: write ? "1" : "0",
		};
		for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) {
			Reflect.deleteProperty(env, key);
		}
		const result = spawnSync(
			omp,
			["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-rules", "-e", extension],
			{ env, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024, input: "" },
		);
		const line = result.stderr.split("\n").find(value => value.startsWith("GOAL_PROBE="));
		expect(line, result.stderr.slice(-2500)).toMatch(/^GOAL_PROBE=/);
		const probe = JSON.parse(line?.slice("GOAL_PROBE=".length) ?? "{}") as {
			initial: Reading;
			written?: Reading;
			reset?: Reading;
		};
		const config = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
		return { probe, config };
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
}

describe.skipIf(!existsSync(omp))("goal.continuationModes default on stock omp", () => {
	it("holds rpc as a runtime override, released by a Settings write", () => {
		const { probe, config } = runProbe(undefined, true);
		expect(probe.initial.value).toContain("rpc");
		expect(probe.initial.value).toContain("interactive");
		expect(probe.initial.layers).toEqual(["runtime"]);
		// The user's write wins and persists; resetting it brings OMPdesk's default back.
		expect(probe.written?.value).toEqual(["interactive"]);
		expect(probe.written?.layers).toEqual(["global"]);
		expect(probe.reset?.value).toContain("rpc");
		expect(probe.reset?.layers).toEqual(["runtime"]);
		// Never written by the default itself.
		expect(config).not.toContain("rpc");
	}, 130_000);

	it("yields to a value already set in config.yml", () => {
		const { probe } = runProbe("goal:\n  continuationModes:\n    - interactive\n", false);
		expect(probe.initial.value).toEqual(["interactive"]);
		expect(probe.initial.layers).toEqual(["global"]);
	}, 130_000);
});
