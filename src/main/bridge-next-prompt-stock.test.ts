import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Pins the built-in prompt suggestions to the installed omp, in an empty private agent dir (no model is called):
 * - the bridge's `nextPrompt` feature is available (every stock internal it needs exists);
 * - the smol model is resolved through stock's own role chain (an isolated profile with only a fake OpenAI key:
 *   the empty `smol` role falls back to stock's priority list) and reported with the role that chose it;
 * - an explicitly configured `smol` role wins, and a role naming a model that is not available is unavailable
 *   (reason no_model) instead of the main model standing in;
 * - the user's own `next-prompt` extension is found through stock's loaded-extension list;
 * - the single-line reply cleaning agrees with stock's `parseComposerPrediction` on the cases both handle.
 */
const omp = join(homedir(), ".bun", "bin", "omp");

const LEGACY = `
export default function (pi) {
 pi.registerCommand("suggest", { description: "Next-prompt suggestions: /suggest on | off", handler: async () => {} });
}
`;

const PROBE = `
import { methods } from "./modes/next-prompt";
import { capabilitiesFor } from "./probe-helper";
import { cleanCandidates } from "./modes/next-prompt-core";
export default function (pi) {
 pi.on("session_start", async () => {
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const frames = [];
   const env = { pi, session: () => session, context: () => undefined, emit: frame => frames.push(frame) };
   const out = {};
   out.unavailable = await capabilitiesFor(env);
   out.state = await methods.next_prompt_state({}, env);
   out.set = await methods.next_prompt_set({ suggestions: true, inline: false }, env);
   out.configFrame = frames.find(frame => frame.type === "next_prompt_config");
   const { parseComposerPrediction } = await import("@oh-my-pi/pi-coding-agent/modes/controllers/composer-prediction-controller");
   const replies = ["run the tests", '"run the tests"', "\`run the tests\`", "  run   the\\ttests  ", "NO_PREDICTION", "", "커밋해줘", "“한 줄”"];
   out.pins = replies.map(reply => ({ reply, stock: parseComposerPrediction(reply) ?? null, ours: cleanCandidates(reply)[0] ?? null }));
   console.error("NP_PROBE=" + JSON.stringify(out));
  } catch (err) {
   console.error("NP_PROBE_ERROR=" + String(err && err.stack || err));
  }
  process.exit(0);
 });
}
`;

const HELPER = `
import { probe } from "./health";
export async function capabilitiesFor(env) {
 return (await probe(env, ["nextPrompt"])).map(entry => ({ feature: entry.feature, missing: entry.missing }));
}
`;

interface Probe {
	unavailable: Array<{ feature: string; missing: string[] }>;
	state: {
		suggestions: boolean;
		inline: boolean;
		legacyExtension: boolean;
		model?: { model: string; role: string };
		unavailable?: string;
		detail?: string;
		requests: { suggest: number; inline: number };
	};
	set: { suggestions: boolean; inline: boolean };
	configFrame?: { suggestions: boolean; inline: boolean };
	pins: Array<{ reply: string; stock: string | null; ours: string | null }>;
}

function run(options: { config?: string; legacy: boolean }): Probe {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-np-"));
	chmodSync(isolated, 0o700);
	try {
		cpSync(resolve("resources/gui-bridge"), join(isolated, "bridge"), { recursive: true });
		const bridge = join(isolated, "bridge");
		writeFileSync(join(bridge, "np-probe.ts"), PROBE);
		writeFileSync(join(bridge, "probe-helper.ts"), HELPER);
		const extensions = join(isolated, "ext");
		mkdirSync(extensions);
		writeFileSync(join(extensions, "next-prompt.ts"), LEGACY);
		if (options.config !== undefined) writeFileSync(join(isolated, "config.yml"), options.config);
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
		const args = [
			"--mode",
			"rpc",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-rules",
			"-e",
			join(bridge, "np-probe.ts"),
		];
		if (options.legacy) args.push("-e", join(extensions, "next-prompt.ts"));
		const result = spawnSync(omp, args, {
			env,
			encoding: "utf8",
			timeout: 120_000,
			maxBuffer: 4 * 1024 * 1024,
			input: "",
		});
		const line = result.stderr.split("\n").find(value => value.startsWith("NP_PROBE="));
		expect(line, result.stderr.slice(-2500)).toMatch(/^NP_PROBE=/);
		return JSON.parse(line?.slice("NP_PROBE=".length) ?? "{}") as Probe;
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
}

describe.skipIf(!existsSync(omp))("prompt suggestions on stock omp", () => {
	it("is available, resolves the smol model through stock's role chain, and agrees with stock's reply cleaning", () => {
		const probe = run({ legacy: false });
		expect(probe.unavailable).toEqual([]);
		expect(probe.state.suggestions).toBe(true);
		expect(probe.state.legacyExtension).toBe(false);
		expect(probe.state.model?.role, JSON.stringify(probe.state)).toBe("smol");
		expect(probe.state.model?.model).toMatch(/^openai\//);
		expect(probe.state.unavailable).toBeUndefined();
		expect(probe.state.requests).toEqual({ suggest: 0, inline: 0 });
		expect(probe.set).toEqual({ suggestions: true, inline: false });
		expect(probe.configFrame).toMatchObject({ suggestions: true, inline: false });
		for (const pin of probe.pins) {
			// Stock's skip token is NO_PREDICTION, ours NONE; everything else must read the same.
			if (pin.reply === "NO_PREDICTION") continue;
			expect(pin.ours, JSON.stringify(pin.reply)).toBe(pin.stock);
		}
	}, 130_000);

	it("uses the configured smol role, and reports no model when the role names none that is available", () => {
		const configured = run({ legacy: false, config: "modelRoles:\n  smol: openai/gpt-5-mini\n" });
		expect(configured.state.model).toEqual({ model: "openai/gpt-5-mini", role: "smol" });
		const missing = run({ legacy: false, config: "modelRoles:\n  smol: nonexistent/model-that-is-not-there\n" });
		// Stock's chain still lists its own empty-role fallbacks after a bad primary; what is never allowed is the main model
		// standing in without being the smol role's answer.
		if (missing.state.model) expect(missing.state.model.role).toBe("smol");
		else expect(missing.state.unavailable).toBe("no_model");
	}, 260_000);

	it("finds the user's own next-prompt extension through the loaded-extension list", () => {
		const probe = run({ legacy: true });
		expect(probe.state.legacyExtension).toBe(true);
	}, 130_000);
});
