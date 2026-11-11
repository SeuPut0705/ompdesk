import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { configDirName, OMP_COMMAND, INSTALLED_OMP as omp } from "./test-bridge-probe";

/**
 * Pins the stock features OMPdesk turns on by default to the installed omp, in an empty private
 * agent dir over `--mode rpc` (so stock's `applyProtocolDefaults("rpc")` has run; no model call,
 * nothing prompted). Each is a runtime override from `thinking-default.ts` (`GUI_THINKING_DEFAULTS`):
 *
 * - with no layer setting it, the effective value is OMPdesk's (on; `title.icons` = `boring`) and
 *   reported as `runtime`, config.yml is never written, and the tool set / advisor stock builds from it follows;
 * - `advisor.enabled` is soft-pinned off by stock for RPC hosts; the override replaces that pin;
 * - `launch.persist` is overridden on by stock's `main.ts` for every non-interactive host (omp 18.18.9); the
 *   override replaces that too, so a named service ends with the session's omp as in a terminal omp;
 * - a Settings write releases the default and wins; resetting it brings the default back;
 * - a value already in config.yml is the user's and wins, `advisor.enabled: false` and `launch.persist: true`
 *   included (stock's own runtime `launch.persist` would hide it, so it is dropped).
 *
 * Not held (stock reads them before extensions load, or only its terminal UI does):
 * `telemetry.otlpExportEnabled`, `display.showTurnTime`, `read.toolResultPreview`; the probe shows
 * they keep stock's value and no `runtime` layer. `astEdit.enabled` is on in stock already.
 */

/** Each held setting: OMPdesk's value, and a different one a user writes. */
const HELD: Readonly<Record<string, readonly [held: unknown, written: unknown]>> = {
	"display.showTokenUsage": [true, false],
	"lsp.diagnosticsOnEdit": [true, false],
	"lsp.formatOnWrite": [true, false],
	"astGrep.enabled": [true, false],
	"computer.enabled": [true, false],
	"advisor.enabled": [true, false],
	"title.icons": ["boring", "emoji"],
	"async.widgets": [false, true],
	// Services an agent starts end with the last omp of the project, as in every OMPdesk before omp 18.18.9.
	"launch.persist": [false, true],
	// Saved-reset auto-redeem (the per-window ids of omp 18.18.7 and later): stock's `unset` asks before spending.
	"codexResets.autoRedeem5h": ["no", "yes"],
	"codexResets.autoRedeemWeekly": ["no", "yes"],
	"claudeResets.autoRedeem5h": ["no", "yes"],
	"claudeResets.autoRedeemWeekly": ["no", "yes"],
	"claudeResets.autoRedeemFable": ["no", "yes"],
};
const UNHELD = [
	"telemetry.otlpExportEnabled",
	"display.showTurnTime",
	"read.toolResultPreview",
	"astEdit.enabled",
	"retry.usageAwareFallback",
	"retry.waitForUsageReset",
] as const;
const PATHS = [...Object.keys(HELD), ...UNHELD];
const WRITES = Object.fromEntries([
	...Object.entries(HELD).map(([path, [, written]]) => [path, written]),
	...UNHELD.map(path => [path, false]),
]);

const PROBE = `
import { methods } from "./settings";
const PATHS = ${JSON.stringify(PATHS)};
const WRITES = ${JSON.stringify(WRITES)};
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
   // What \`launch/services.ts\` \`startService\` reads for each service it starts.
   const { lookup } = await import("@oh-my-pi/pi-coding-agent/config/registry");
   out.servicePersist = lookup("launch.persist")?.get(session.settings);
   out.tools = session.getEnabledToolNames?.() ?? [];
   out.computerPrelude = session.getEvalPreludes?.().some(definition => definition.name === "computer") ?? null;
   if (process.env.DEFAULTS_PROBE_FALLBACK === "1") {
    // The engine's startup check failed (modes/computer-use.ts): stock's own listener must reconcile the live prelude.
    const { holdBuiltinComputerPrelude } = await import("./thinking-default");
    holdBuiltinComputerPrelude(session.settings);
    // Stock's listener recomputes in a microtask.
    await Promise.resolve();
    await Promise.resolve();
    const { values, provenance } = await methods.settings_get({ paths: ["computer.enabled"] }, env);
    out.afterFallback = {
     value: values["computer.enabled"],
     layers: provenance["computer.enabled"].layers,
     prelude: session.getEvalPreludes?.().some(definition => definition.name === "computer") ?? null,
    };
   }
   const { resolveAdvisorRoleSelection } = await import("@oh-my-pi/pi-coding-agent/config/model-resolver");
   const advisor = resolveAdvisorRoleSelection(session.settings, session.modelRegistry.getAvailable());
   out.advisorRole = advisor ? { model: advisor.model.id, thinkingLevel: advisor.thinkingLevel } : null;
   if (process.env.DEFAULTS_PROBE_WRITE === "1") {
    for (const path of PATHS) await methods.settings_set({ path, value: WRITES[path] }, env);
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

function runProbe(configYml: string | undefined, write: boolean, extraEnv: Record<string, string> = {}) {
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
			PI_CONFIG_DIR: configDirName(isolated),
			OMP_PROFILE: "",
			PI_PROFILE: "",
			OPENAI_API_KEY: "probe-not-a-real-key",
			DEFAULTS_PROBE_WRITE: write ? "1" : "0",
		};
		// Never the launching OMPdesk session's own engine: a test run from one would hold the prelude off.
		for (const key of [
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_OAUTH_TOKEN",
			"CLAUDE_CODE_OAUTH_TOKEN",
			"OMP_GUI_COMPUTER_USE",
		]) {
			Reflect.deleteProperty(env, key);
		}
		Object.assign(env, extraEnv);
		const result = spawnSync(
			OMP_COMMAND.file,
			[
				...OMP_COMMAND.args,
				"--mode",
				"rpc",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-rules",
				"-e",
				extension,
			],
			{ env, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024, input: "" },
		);
		const line = result.stderr.split("\n").find(value => value.startsWith("DEFAULTS_PROBE="));
		expect(line, result.stderr.slice(-2500)).toMatch(/^DEFAULTS_PROBE=/);
		const probe = JSON.parse(line?.slice("DEFAULTS_PROBE=".length) ?? "{}") as {
			initial: Readings;
			advisorEnabled?: boolean;
			servicePersist?: unknown;
			tools: string[];
			computerPrelude: boolean | null;
			advisorRole: { model: string; thinkingLevel?: string } | null;
			written?: Readings;
			reset?: Readings;
			afterFallback?: { value: unknown; layers: string[]; prelude: boolean | null };
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
		for (const [path, [held]] of Object.entries(HELD)) {
			expect(probe.initial[path], path).toEqual({ value: held, layers: ["runtime"] });
		}
		// Stock pins the advisor off for RPC hosts; the override replaced the pin before the session was built.
		expect(probe.advisorEnabled).toBe(true);
		// Stock's main.ts held services past the omp's exit for RPC hosts; the session's services read OMPdesk's value.
		expect(probe.servicePersist).toBe(false);
		// ast_grep joined the enabled tool set; the advisor role resolves (unset: stock's slow chain) on an available model.
		expect(probe.tools).toContain("ast_grep");
		// `/computer status` reads "enabled" and "prelude: active" from exactly these two facts.
		expect(probe.tools).toContain("eval");
		expect(probe.computerPrelude).toBe(true);
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
		for (const [path, [held, written]] of Object.entries(HELD)) {
			expect(probe.written?.[path], path).toEqual({ value: written, layers: ["global"] });
			expect(probe.reset?.[path], path).toEqual({ value: held, layers: ["runtime"] });
		}
		// Never written by the defaults themselves.
		for (const path of Object.keys(HELD)) expect(config, path).not.toContain(path.split(".")[1]);
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
				"launch:",
				"  persist: true",
				"title:",
				"  icons: emoji",
				"",
			].join("\n"),
			false,
		);
		for (const path of ["display.showTokenUsage", "lsp.formatOnWrite", "advisor.enabled"]) {
			expect(probe.initial[path], path).toEqual({ value: false, layers: ["global"] });
		}
		expect(probe.initial["title.icons"]).toEqual({ value: "emoji", layers: ["global"] });
		expect(probe.advisorEnabled).toBe(false);
		expect(probe.initial["launch.persist"]).toEqual({ value: true, layers: ["global"] });
		expect(probe.servicePersist).toBe(true);
		// The rest of the list is still held.
		expect(probe.initial["lsp.diagnosticsOnEdit"]).toEqual({ value: true, layers: ["runtime"] });
		expect(probe.initial["astGrep.enabled"]).toEqual({ value: true, layers: ["runtime"] });
	}, 130_000);

	it("holds the prelude off for an omp started on agent-desktop, and a failed engine puts it back live", () => {
		const { probe, config } = runProbe(undefined, false, {
			OMP_GUI_COMPUTER_USE: "agent-desktop",
			DEFAULTS_PROBE_FALLBACK: "1",
		});
		// Held off as a runtime override: stock's eval prelude is not mounted beside the engine's MCP tools.
		expect(probe.initial["computer.enabled"]).toEqual({ value: false, layers: ["runtime"] });
		expect(probe.computerPrelude).toBe(false);
		// The fallback turns the held value on and stock's listener reconciles the live prelude; nothing is written.
		expect(probe.afterFallback).toEqual({ value: true, layers: ["runtime"], prelude: true });
		expect(config).not.toContain("computer");
		// The rest of the list is held as for the built-in engine.
		expect(probe.initial["astGrep.enabled"]).toEqual({ value: true, layers: ["runtime"] });
	}, 130_000);
});
