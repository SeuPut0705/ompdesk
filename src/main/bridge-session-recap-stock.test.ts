import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Pins the bridge's idle recap (resources/gui-bridge/session-recap.ts) to the installed omp, in an empty
 * private agent dir (no model call: `runEphemeralTurn` is replaced by a stub that records the prompt):
 *
 * - the recap prompt is stock's own `prompts/system/recap-user.md` rendered with stock's `prompt.render`;
 * - the reply is cut to stock's display length the way the TUI does (`previewLine`, `TRUNCATE_LENGTHS.RECAP`);
 * - delivery journals the reply with stock's `recordRecap` and appends a displayed `recap` custom message that
 *   stock's transcript replay returns, while the `context` hook keeps it out of what a model is sent;
 * - `recap.enabled` (default on) and `recap.idleSeconds` (240) are stock's settings, read through `lookup`.
 */
const omp = join(homedir(), ".bun", "bin", "omp");

const PROBE = `
import { methods } from "./settings";
import { deliverRecap, generateRecap, install } from "./session-recap";
import { buildTranscript } from "./session-display";
export default function (pi) {
 pi.on("session_start", async () => {
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = { pi, session: () => session, context: () => undefined, emit: () => {} };
   const out = {};
   const { values } = await methods.settings_get({ paths: ["recap.enabled", "recap.idleSeconds"] }, env);
   out.settings = values;
   const handlers = {};
   install({ on: (name, handler) => { handlers[name] = handler; } });
   out.hooks = Object.keys(handlers);
   out.hasModel = Boolean(session.model);
   session.agent.appendMessage({ role: "user", content: [{ type: "text", text: "Build the thing" }], timestamp: Date.now() });
   let promptText;
   session.runEphemeralTurn = async args => {
    promptText = args.promptText;
    return { replyText: "  You are building the thing.\\n Next: run the tests.  " };
   };
   const recap = await generateRecap(session, new AbortController().signal);
   out.promptText = promptText;
   out.recap = recap;
   if (recap) await deliverRecap(session, recap);
   const entry = session.sessionManager.getEntries().find(item => item.type === "custom_message" && item.customType === "recap");
   out.entry = entry && { content: entry.content, display: entry.display, details: entry.details };
   const recaps = buildTranscript(session.sessionManager).messages.filter(m => m.role === "custom" && m.customType === "recap");
   out.transcript = recaps.map(m => ({ content: m.content, display: m.display }));
   const user = { role: "user", content: [{ type: "text", text: "x" }], timestamp: 1 };
   out.sent = handlers.context({ messages: [user, ...recaps] })?.messages.map(m => m.role);
   out.untouched = handlers.context({ messages: [user] });
   console.error("RECAP_PROBE=" + JSON.stringify(out));
  } catch (err) {
   console.error("RECAP_PROBE_ERROR=" + String(err && err.stack || err));
  }
  process.exit(0);
 });
}
`;

interface Probe {
	settings: Record<string, unknown>;
	hooks: string[];
	hasModel: boolean;
	promptText?: string;
	recap?: { reply: string; preview: string };
	entry?: { content: unknown; display: unknown; details: unknown };
	transcript: Array<{ content: unknown; display: unknown }>;
	sent?: string[];
	untouched?: unknown;
}

function runProbe(): Probe {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-recap-"));
	chmodSync(isolated, 0o700);
	try {
		cpSync(resolve("resources/gui-bridge"), join(isolated, "bridge"), { recursive: true });
		const extension = join(isolated, "bridge", "recap-probe.ts");
		writeFileSync(extension, PROBE);
		const env: Record<string, string | undefined> = {
			...process.env,
			PI_CODING_AGENT_DIR: isolated,
			PI_CONFIG_DIR: isolated,
			OMP_PROFILE: "",
			PI_PROFILE: "",
			OPENAI_API_KEY: "probe-not-a-real-key",
		};
		for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) {
			Reflect.deleteProperty(env, key);
		}
		const result = spawnSync(
			omp,
			["--mode", "rpc", "--no-extensions", "--no-skills", "--no-rules", "-e", extension],
			{
				env,
				encoding: "utf8",
				timeout: 120_000,
				maxBuffer: 4 * 1024 * 1024,
				input: "",
			},
		);
		const line = result.stderr.split("\n").find(value => value.startsWith("RECAP_PROBE="));
		expect(line, result.stderr.slice(-2500)).toMatch(/^RECAP_PROBE=/);
		return JSON.parse(line?.slice("RECAP_PROBE=".length) ?? "{}") as Probe;
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
}

describe.skipIf(!existsSync(omp))("idle recap on stock omp", () => {
	it("makes the recap from stock's prompt and delivers it as a quiet custom message the model never sees", () => {
		const probe = runProbe();
		// Stock's own settings: on by default, 4 minutes.
		expect(probe.settings).toEqual({ "recap.enabled": true, "recap.idleSeconds": 240 });
		expect(probe.hasModel).toBe(true);
		// Stock's template (prompts/system/recap-user.md), rendered with its renderer.
		expect(probe.promptText).toContain("<recap>");
		expect(probe.promptText).toContain("User stepped away; returning.");
		expect(probe.recap?.preview).toBe("You are building the thing. Next: run the tests.");
		// Journaled in full by stock's recordRecap (history.db); the card carries the one-line preview.
		expect(probe.entry).toEqual({
			content: "You are building the thing. Next: run the tests.",
			display: true,
			details: { recap: probe.recap?.reply },
		});
		expect(probe.transcript).toEqual([{ content: probe.entry?.content, display: true }]);
		// The context hook drops it from a model request, and leaves other requests untouched.
		expect(probe.hooks).toContain("context");
		expect(probe.sent).toEqual(["user"]);
		expect(probe.untouched).toBeUndefined();
	}, 130_000);
});
