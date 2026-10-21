import { spawnSync } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { titleLanguageLine } from "../../resources/gui-bridge/modes/auto-title-core";
import { wrapAgentMessage } from "../shared/agent-control";

/**
 * Pins the automatic session titles to the installed omp, in an empty private agent dir (no model is called):
 * - the bridge's `autoTitle` feature is available (every stock internal it needs exists);
 * - stock's session manager refuses an "auto" write over a typed name, which is why a regenerated title is written as
 *   source "user" with the bridge's trigger stamp, and its own `title_change` journal is the origin record the engine reads;
 * - stock's `operatorTitleText` names an operator message and nothing else;
 * - the title model is stock's cheap role chain (`tiny`, `commit`, `smol`), not the session's default model;
 * - `regenerate_title` on the real session with nothing to name answers "none" without writing a name;
 * - the title prompt override every title path reads is stock's own `title-system.md` plus the language line for a
 *   non-English reply language (at attach and after `reply_language_set`), the same line without the language
 *   fallback for English or off, and a person's own TITLE_SYSTEM.md stays as stock resolved it.
 */
const omp = join(homedir(), ".bun", "bin", "omp");

/** Two briefs another session's agent sends (`ompdesk_session_open`): one with a `Title:` line, one without. */
const BRIEFS = [
	wrapAgentMessage("Title: 로그인 오류를 고치고 회귀 테스트 추가\n# Target\nauth.ts", "Parent"),
	wrapAgentMessage("Fix the login bug in auth.ts.\nAdd a regression test.", "Parent"),
];

const PROBE = `
import { methods } from "./modes/auto-title";
import { methods as replyLanguage } from "./modes/reply-language";
import { capabilitiesFor } from "./probe-helper";
import { TITLE_TRIGGER } from "./modes/auto-title-contracts";
import { titleIsAuto, titleInput } from "./modes/auto-title-core";
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
   out.promptAtAttach = session.titleSystemPrompt ?? null;
   await replyLanguage.reply_language_set({ language: "Japanese" });
   out.promptJapanese = session.titleSystemPrompt ?? null;
   await replyLanguage.reply_language_set({ language: "English" });
   out.promptEnglish = session.titleSystemPrompt ?? null;
   await replyLanguage.reply_language_set({ language: "Korean" });
   await replyLanguage.reply_language_set({ language: null });
   out.promptOff = session.titleSystemPrompt ?? null;
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
   const { isLowSignalTitleInput } = await import("@oh-my-pi/pi-coding-agent/tiny/text");
   const briefs = ${JSON.stringify(BRIEFS)};
   out.briefs = briefs.map(brief => ({ wrapped: isLowSignalTitleInput(brief), input: titleInput(brief) ?? null, inputLowSignal: isLowSignalTitleInput(titleInput(brief) ?? "") }));
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
	promptAtAttach: string | null;
	promptJapanese: string | null;
	promptEnglish: string | null;
	promptOff: string | null;
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
	briefs: Array<{ wrapped: boolean; input: string | null; inputLowSignal: boolean }>;
}

/** Stock's own title prompt, read from the omp install the probe runs (`dist/cli.js` → `src/prompts`). */
function stockTitlePrompt(): string {
	return readFileSync(join(dirname(dirname(realpathSync(omp))), "src/prompts/system/title-system.md"), "utf8");
}

function run(config: string, options: { replyLanguage?: string; titleSystem?: string } = {}): Probe {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-at-"));
	chmodSync(isolated, 0o700);
	try {
		cpSync(resolve("resources/gui-bridge"), join(isolated, "bridge"), { recursive: true });
		const bridge = join(isolated, "bridge");
		writeFileSync(join(bridge, "at-probe.ts"), PROBE);
		writeFileSync(join(bridge, "probe-helper.ts"), HELPER);
		writeFileSync(join(isolated, "config.yml"), config);
		// A project's own TITLE_SYSTEM.md (`.omp/TITLE_SYSTEM.md`, stock's `discoverTitleSystemPromptFile`).
		const project = join(isolated, "project");
		mkdirSync(join(project, ".omp"), { recursive: true });
		if (options.titleSystem !== undefined)
			writeFileSync(join(project, ".omp", "TITLE_SYSTEM.md"), options.titleSystem);
		const env: Record<string, string | undefined> = {
			...process.env,
			PI_CODING_AGENT_DIR: isolated,
			PI_CONFIG_DIR: isolated,
			OMP_PROFILE: "",
			PI_PROFILE: "",
			OPENAI_API_KEY: "probe-not-a-real-key",
			OMP_GUI_REPLY_LANGUAGE: options.replyLanguage,
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
			{ cwd: project, env, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024, input: "" },
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
		// Stock declines another agent's wrapped brief as low-signal; the engine names the session from its words.
		expect(probe.briefs).toEqual([
			{ wrapped: true, input: "로그인 오류를 고치고 회귀 테스트 추가", inputLowSignal: false },
			{ wrapped: true, input: "Fix the login bug in auth.ts.\nAdd a regression test.", inputLowSignal: false },
		]);
	}, 130_000);

	it("asks the cheap role chain for a title, never the default model first", () => {
		const probe = run("modelRoles:\n  smol: openai/gpt-5-mini\n  default: openai/gpt-5\n");
		expect(probe.titleModels[0]).toEqual({ role: "smol", model: "openai/gpt-5-mini" });
		expect(probe.titleModels.map(candidate => candidate.model)).not.toContain("openai/gpt-5");
	}, 130_000);

	it("gives the title paths stock's own prompt plus the line, with no language fallback for English and off, and leaves a person's TITLE_SYSTEM.md alone", () => {
		const config = "modelRoles:\n  smol: openai/gpt-5-mini\n  default: openai/gpt-5\n";
		const probe = run(config, { replyLanguage: "Korean" });
		expect(probe.unavailable).toEqual([]);
		const stockLines = stockTitlePrompt()
			.split("\n")
			.map(line => line.trim())
			.filter(Boolean);
		expect(stockLines.length).toBeGreaterThan(5);
		for (const [prompt, language] of [
			[probe.promptAtAttach, "Korean"],
			[probe.promptJapanese, "Japanese"],
			[probe.promptEnglish, undefined],
			[probe.promptOff, undefined],
		] as const) {
			for (const line of stockLines) expect(prompt).toContain(line);
			expect(prompt?.endsWith(`\n\n${titleLanguageLine(language)}`)).toBe(true);
		}

		const own = "Name the session in exactly two words.";
		const custom = run(config, { replyLanguage: "Korean", titleSystem: own });
		expect(custom.unavailable).toEqual([]);
		for (const prompt of [custom.promptAtAttach, custom.promptJapanese, custom.promptEnglish, custom.promptOff])
			expect(prompt?.trim()).toBe(own);
	}, 260_000);
});
