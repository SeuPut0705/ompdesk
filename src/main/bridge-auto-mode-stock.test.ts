import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Pins the automatic mode choice to the installed omp, in an empty private agent dir (the one model request goes to
 * a key that is not real and must end as "none"):
 * - the bridge's `autoMode` feature is available (every stock internal it needs exists);
 * - the judge the classifier asks is stock's own role chain, cheap roles first (the `smol` model, never `default`);
 * - guards answer without any model: a slash command, `!` bash, a chat-length message, a mode the user picked
 *   (plan), a busy session (a turn that just ended, read from the live transcript) and a session where the user
 *   undid a decision all give "none" with their reason and latency 0;
 * - a prompt that is classified but whose model fails answers "none" within the deadline (the prompt is never held up);
 * - the user's own rejection of a plan is remembered by plan.ts's approval path (`modes.plan_approval` rejects with
 *   no plan pending, so the flag is exercised through auto-mode-state directly).
 */
const omp = join(homedir(), ".bun", "bin", "omp");

const PROBE = `
import { methods } from "./modes/auto-mode";
import { capabilitiesFor } from "./probe-helper";
export default function (pi) {
 pi.on("session_start", async () => {
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = { pi, session: () => session, context: () => undefined, emit: () => {} };
   const out = {};
   out.unavailable = await capabilitiesFor(env);
   const { resolveJudge } = await import("@oh-my-pi/pi-coding-agent/judgment");
   const judge = resolveJudge({ settings: session.settings, registry: session.modelRegistry, sessionModel: session.model, sessionId: session.sessionId, purpose: "auto-mode" });
   const primary = judge.primaryModel();
   out.judgeModel = primary ? primary.provider + "/" + primary.id : null;
   const decide = message => methods["modes.auto_mode_decide"]({ message }, env);
   out.slash = await decide("/compact now please");
   out.bash = await decide("!ls -la /tmp");
   out.short = await decide("ok thanks");
   const started = Date.now();
   out.big = await decide("refactor the whole settings module across all files and add tests");
   out.bigWallMs = Date.now() - started;
   session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
   out.planActive = await decide("refactor the whole settings module across all files");
   session.setPlanModeState(undefined);
   // A turn that just ended: the session is busy, so nothing is classified (the next prompt stays in the user's mode).
   session.agent.replaceMessages([{ role: "user", content: "fix it", timestamp: Date.now() - 1000 }, { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: Date.now() }]);
   out.busy = await decide("refactor the whole settings module across all files and add tests");
   session.agent.replaceMessages([]);
   out.undo = await methods["modes.auto_mode_undo"]({ mode: "goal" }, env);
   out.afterUndo = await decide("keep going until all the tests pass");
   console.error("AM_PROBE=" + JSON.stringify(out));
  } catch (err) {
   console.error("AM_PROBE_ERROR=" + String(err && err.stack || err));
  }
  process.exit(0);
 });
}
`;

const HELPER = `
import { probe } from "./health";
export async function capabilitiesFor(env) {
 return (await probe(env, ["autoMode"])).map(entry => ({ feature: entry.feature, missing: entry.missing }));
}
`;

interface Decision {
	mode: string;
	reason?: string;
	latencyMs: number;
}

interface Probe {
	unavailable: Array<{ feature: string; missing: string[] }>;
	judgeModel: string | null;
	slash: Decision;
	bash: Decision;
	short: Decision;
	big: Decision;
	bigWallMs: number;
	planActive: Decision;
	busy: Decision;
	undo: { suppressed: boolean };
	afterUndo: Decision;
}

function run(config: string): Probe {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-am-"));
	chmodSync(isolated, 0o700);
	try {
		cpSync(resolve("resources/gui-bridge"), join(isolated, "bridge"), { recursive: true });
		const bridge = join(isolated, "bridge");
		writeFileSync(join(bridge, "am-probe.ts"), PROBE);
		writeFileSync(join(bridge, "probe-helper.ts"), HELPER);
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
				join(bridge, "am-probe.ts"),
			],
			{ cwd: project, env, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024, input: "" },
		);
		const line = result.stderr.split("\n").find(value => value.startsWith("AM_PROBE="));
		expect(line, result.stderr.slice(-2500)).toMatch(/^AM_PROBE=/);
		return JSON.parse(line?.slice("AM_PROBE=".length) ?? "{}") as Probe;
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
}

describe.skipIf(!existsSync(omp))("automatic mode choice on stock omp", () => {
	it("is available, asks the cheap judge chain, answers guards without a model and never holds a prompt up", () => {
		const probe = run("modelRoles:\n  smol: openai/gpt-5-mini\n  default: openai/gpt-5\n");
		expect(probe.unavailable).toEqual([]);
		expect(probe.judgeModel).toBe("openai/gpt-5-mini");
		expect(probe.slash).toEqual({ mode: "none", reason: "slash", latencyMs: 0 });
		expect(probe.bash).toEqual({ mode: "none", reason: "bash", latencyMs: 0 });
		expect(probe.short).toEqual({ mode: "none", reason: "short", latencyMs: 0 });
		expect(probe.planActive).toEqual({ mode: "none", reason: "mode_active", latencyMs: 0 });
		expect(probe.busy).toEqual({ mode: "none", reason: "busy", latencyMs: 0 });
		// The model behind the fake key cannot answer: none, inside the 2 s deadline (plus a little startup).
		expect(probe.big.mode).toBe("none");
		expect(["error", "timeout"]).toContain(probe.big.reason);
		expect(probe.bigWallMs).toBeLessThan(4000);
		// Undoing a decision stops them for the session.
		expect(probe.undo).toEqual({ suppressed: true });
		expect(probe.afterUndo).toEqual({ mode: "none", reason: "suppressed", latencyMs: 0 });
	}, 130_000);
});
