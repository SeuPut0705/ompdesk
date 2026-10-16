import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Pins the stock features OMPdesk turns on by default to the installed omp, in an empty private
 * agent dir over `--mode rpc` (so stock's `applyProtocolDefaults("rpc")` has run; no model call,
 * nothing prompted). Each is a runtime override from `thinking-default.ts` (`GUI_THINKING_DEFAULTS`):
 *
 * - with no layer setting it, the effective value is on and reported as `runtime`, config.yml is
 *   never written, and the tool set / advisor stock builds from it follows;
 * - `advisor.enabled` is soft-pinned off by stock for RPC hosts; the override replaces that pin;
 * - a Settings write releases the default and wins; resetting it brings the default back;
 * - a value already in config.yml is the user's and wins, `advisor.enabled: false` included.
 *
 * Not held (stock reads them before extensions load, or only its terminal UI does):
 * `telemetry.otlpExportEnabled`, `display.showTurnTime`, `read.toolResultPreview`; the probe shows
 * they keep stock's value and no `runtime` layer. `astEdit.enabled` is on in stock already.
 */
const omp = join(homedir(), ".bun", "bin", "omp");

const HELD = [
	"display.showTokenUsage",
	"lsp.diagnosticsOnEdit",
	"lsp.formatOnWrite",
	"astGrep.enabled",
	"advisor.enabled",
] as const;
const UNHELD = [
	"telemetry.otlpExportEnabled",
	"display.showTurnTime",
	"read.toolResultPreview",
	"astEdit.enabled",
	"retry.usageAwareFallback",
	"retry.waitForUsageReset",
] as const;
const PATHS = [...HELD, ...UNHELD];

const PROBE = `
import { methods } from "./settings";
const PATHS = ${JSON.stringify(PATHS)};
export default function (pi) {
 const ready = import("./thinking-default").then(module => module.applyGuiThinkingDefault(pi));
 pi.on("session_start", async () => {
  try {
   await ready;
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = { pi, session: () => session, context: () => undefined, emit: () => {} };
   const read = async () => {
    const { values, provenance } = await methods.settings_get({ paths: PATHS }, env);
    return Object.fromEntries(PATHS.map(path => [path, { value: values[path], layers: provenance[path].layers }]));
   };
   const out = { initial: await read() };
   out.advisorEnabled = session.isAdvisorEnabled?.();
   out.tools = session.getEnabledToolNames?.() ?? [];
   const { resolveAdvisorRoleSelection } = await import("@oh-my-pi/pi-coding-agent/config/model-resolver");
   const advisor = resolveAdvisorRoleSelection(session.settings, session.modelRegistry.getAvailable());
   out.advisorRole = advisor ? { model: advisor.model.id, thinkingLevel: advisor.thinkingLevel } : null;
   if (process.env.DEFAULTS_PROBE_WRITE === "1") {
    for (const path of PATHS) await methods.settings_set({ path, value: false }, env);
    out.written = await read();
    for (const path of PATHS) await methods.settings_set({ path, value: undefined }, env);
    out.reset = await read();
   }
   console.error("DEFAULTS_PROBE=" + JSON.stringify(out));
  } catch (err) {
   console.error("DEFAULTS_PROBE_ERROR=" + String(err && err.stack || err));
  }
  process.exit(0);
 });
}
`;

interface Reading {
	value: unknown;
	layers: string[];
}
type Readings = Record<string, Reading>;

function runProbe(configYml: string | undefined, write: boolean) {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-defaults-"));
	chmodSync(isolated, 0o700);
	try {
		cpSync(resolve("resources/gui-bridge"), join(isolated, "bridge"), { recursive: true });
		const extension = join(isolated, "bridge", "defaults-probe.ts");
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
			DEFAULTS_PROBE_WRITE: write ? "1" : "0",
		};
		for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) {
			Reflect.deleteProperty(env, key);
		}
		const result = spawnSync(
			omp,
			["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-rules", "-e", extension],
			{ env, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024, input: "" },
		);
		const line = result.stderr.split("\n").find(value => value.startsWith("DEFAULTS_PROBE="));
		expect(line, result.stderr.slice(-2500)).toMatch(/^DEFAULTS_PROBE=/);
		const probe = JSON.parse(line?.slice("DEFAULTS_PROBE=".length) ?? "{}") as {
			initial: Readings;
			advisorEnabled?: boolean;
			tools: string[];
			advisorRole: { model: string; thinkingLevel?: string } | null;
			written?: Readings;
			reset?: Readings;
		};
		const config = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
		return { probe, config };
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
}

describe.skipIf(!existsSync(omp))("OMPdesk's held stock defaults on stock omp", () => {
	it("holds each as a runtime override over RPC, replacing stock's advisor pin, and releases it on a Settings write", () => {
		const { probe, config } = runProbe(undefined, true);
		for (const path of HELD) {
			expect(probe.initial[path], path).toEqual({ value: true, layers: ["runtime"] });
		}
		// Stock pins the advisor off for RPC hosts; the override replaced the pin before the session was built.
		expect(probe.advisorEnabled).toBe(true);
		// ast_grep joined the enabled tool set; the advisor role resolves (unset: stock's slow chain) on an available model.
		expect(probe.tools).toContain("ast_grep");
		expect(probe.advisorRole?.model).toBeTruthy();
		// Everything else keeps stock's value, with no runtime layer.
		for (const path of UNHELD) {
			expect(probe.initial[path].layers, path).not.toContain("runtime");
		}
		expect(probe.initial["telemetry.otlpExportEnabled"].value).toBe(true);
		expect(probe.initial["astEdit.enabled"].value).toBe(true);
		for (const path of ["retry.usageAwareFallback", "retry.waitForUsageReset"]) {
			expect(probe.initial[path].value, path).toBe(false);
		}
		// The user's write wins and persists; resetting brings OMPdesk's default back.
		for (const path of HELD) {
			expect(probe.written?.[path], path).toEqual({ value: false, layers: ["global"] });
			expect(probe.reset?.[path], path).toEqual({ value: true, layers: ["runtime"] });
		}
		// Never written by the defaults themselves.
		for (const path of HELD) expect(config, path).not.toContain(path.split(".")[1]);
	}, 130_000);

	it("yields to values already in config.yml, advisor.enabled: false included", () => {
		const { probe } = runProbe(
			[
				"display:",
				"  showTokenUsage: false",
				"lsp:",
				"  formatOnWrite: false",
				"advisor:",
				"  enabled: false",
				"",
			].join("\n"),
			false,
		);
		for (const path of ["display.showTokenUsage", "lsp.formatOnWrite", "advisor.enabled"]) {
			expect(probe.initial[path], path).toEqual({ value: false, layers: ["global"] });
		}
		expect(probe.advisorEnabled).toBe(false);
		// The rest of the list is still held.
		expect(probe.initial["lsp.diagnosticsOnEdit"]).toEqual({ value: true, layers: ["runtime"] });
		expect(probe.initial["astGrep.enabled"]).toEqual({ value: true, layers: ["runtime"] });
	}, 130_000);
});
