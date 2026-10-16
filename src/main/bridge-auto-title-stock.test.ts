import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Pins the automatic session titles to the installed omp, in an empty private agent dir (no model is called):
 * - the bridge's `autoTitle` feature is available (every stock internal it needs exists);
 * - stock's session manager refuses an "auto" write over a typed name, which is why a regenerated title is written as
 *   source "user" with the bridge's trigger stamp, and its own `title_change` journal is the origin record the engine reads;
 * - stock's `operatorTitleText` names an operator message and nothing else;
 * - the title model is stock's cheap role chain (`tiny`, `commit`, `smol`), not the session's default model;
 * - `regenerate_title` on the real session with nothing to name answers "none" without writing a name.
 */
const omp = join(homedir(), ".bun", "bin", "omp");

const PROBE = `
import { methods } from "./modes/auto-title";
import { capabilitiesFor } from "./probe-helper";
import { TITLE_TRIGGER } from "./auto-title-contracts";
import { titleIsAuto } from "./auto-title-core";
export default function (pi) {
 pi.on("session_start", async () => {
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const frames = [];
   const env = { pi, session: () => session, context: () => undefined, emit: frame => frames.push(frame) };
   const out = {};
   out.unavailable = await capabilitiesFor(env);
   const manager = session.sessionManager;
   out.set = await methods.auto_title_set({ enabled: true, evolve: true, suppressed: false }, env);
   out.regenerateEmpty = await methods.regenerate_title({}, env);
   out.nameAfterEmpty = session.sessionName ?? null;
   out.typed = await manager.setSessionName("Typed name", "user");
   out.autoOverTyped = await manager.setSessionName("Generated", "auto");
   out.originTyped = titleIsAuto(session.sessionName, manager.titleSource, manager.getEntries());
   out.stamped = await manager.setSessionName("Regenerated", "user", TITLE_TRIGGER);
   out.originStamped = titleIsAuto(session.sessionName, manager.titleSource, manager.getEntries());
   out.titleSource = manager.titleSource;
   out.lastEntry = manager.getEntries().filter(entry => entry.type === "title_change").at(-1);
   const { operatorTitleText } = await import("@oh-my-pi/pi-coding-agent/session/messages");
   out.operator = operatorTitleText({ role: "user", attribution: "user", content: [{ type: "text", text: "fix the login bug" }] }) ?? null;
   out.agentAttributed = operatorTitleText({ role: "user", attribution: "agent", content: [{ type: "text", text: "x" }] }) ?? null;
   out.assistant = operatorTitleText({ role: "assistant", content: [{ type: "text", text: "x" }] }) ?? null;
   const { roleCandidatePool } = await import("@oh-my-pi/pi-coding-agent/config/model-roles");
   const { collectOnlineTinyCandidates } = await import("@oh-my-pi/pi-coding-agent/tiny/online-candidates");
   const pool = roleCandidatePool("tiny", session.settings, session.modelRegistry);
   out.titleModels = collectOnlineTinyCandidates(["tiny", "commit", "smol"], session.settings, pool).map(c => ({ role: c.role, model: c.model.provider + "/" + c.model.id }));
   console.error("AT_PROBE=" + JSON.stringify(out));
  } catch (err) {
   console.error("AT_PROBE_ERROR=" + String(err && err.stack || err));
  }
  process.exit(0);
 });
}
`;

const HELPER = `
import { probe } from "./health";
export async function capabilitiesFor(env) {
 return (await probe(env, ["autoTitle"])).map(entry => ({ feature: entry.feature, missing: entry.missing }));
}
`;

interface Probe {
	unavailable: Array<{ feature: string; missing: string[] }>;
	set: { enabled: boolean; evolve: boolean; suppressed: boolean; requests: number };
	regenerateEmpty: { title: string | null; reason?: string };
	nameAfterEmpty: string | null;
	typed: boolean;
	autoOverTyped: boolean;
	originTyped: boolean;
	stamped: boolean;
	originStamped: boolean;
	titleSource: string;
	lastEntry: { title: string; source: string; trigger?: string };
	operator: string | null;
	agentAttributed: string | null;
	assistant: string | null;
	titleModels: Array<{ role: string; model: string }>;
}

function run(config: string): Probe {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-at-"));
	chmodSync(isolated, 0o700);
	try {
		cpSync(resolve("resources/gui-bridge"), join(isolated, "bridge"), { recursive: true });
		const bridge = join(isolated, "bridge");
		writeFileSync(join(bridge, "at-probe.ts"), PROBE);
		writeFileSync(join(bridge, "probe-helper.ts"), HELPER);
		writeFileSync(join(isolated, "config.yml"), config);
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
				join(bridge, "at-probe.ts"),
			],
			{ env, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024, input: "" },
		);
		const line = result.stderr.split("\n").find(value => value.startsWith("AT_PROBE="));
		expect(line, result.stderr.slice(-2500)).toMatch(/^AT_PROBE=/);
		return JSON.parse(line?.slice("AT_PROBE=".length) ?? "{}") as Probe;
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
}

describe.skipIf(!existsSync(omp))("automatic session titles on stock omp", () => {
	it("is available, keeps the origin in stock's own journal, and names nothing for an empty conversation", () => {
		const probe = run("modelRoles:\n  smol: openai/gpt-5-mini\n  default: openai/gpt-5\n");
		expect(probe.unavailable).toEqual([]);
		expect(probe.set).toEqual({ enabled: true, evolve: true, suppressed: false, requests: 0 });
		// Nothing to name yet: the answer says so and no name is written.
		expect(probe.regenerateEmpty).toEqual({ title: null, reason: "none" });
		expect(probe.nameAfterEmpty).toBeNull();
		// A typed name wins over an automatic write (stock's rule), so a regenerated title is stamped instead.
		expect(probe.typed).toBe(true);
		expect(probe.autoOverTyped).toBe(false);
		expect(probe.originTyped).toBe(false);
		expect(probe.stamped).toBe(true);
		expect(probe.originStamped).toBe(true);
		expect(probe.titleSource).toBe("user");
		expect(probe.lastEntry).toMatchObject({ title: "Regenerated", source: "user", trigger: "ompdesk-auto" });
		expect(probe.operator).toBe("fix the login bug");
		expect(probe.agentAttributed).toBeNull();
		expect(probe.assistant).toBeNull();
	}, 130_000);

	it("asks the cheap role chain for a title, never the default model first", () => {
		const probe = run("modelRoles:\n  smol: openai/gpt-5-mini\n  default: openai/gpt-5\n");
		expect(probe.titleModels[0]).toEqual({ role: "smol", model: "openai/gpt-5-mini" });
		expect(probe.titleModels.map(candidate => candidate.model)).not.toContain("openai/gpt-5");
	}, 130_000);
});
