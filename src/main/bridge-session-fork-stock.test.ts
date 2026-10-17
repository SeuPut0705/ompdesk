import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * "Branch from here" (bridge `sessions.fork_from`, resources/gui-bridge/sessions.ts) on the installed omp, in an
 * empty private agent dir (no model call). Reported on v0.35.1: a branch from the user's own prompt copied the
 * conversation through that prompt, so the new session ended on a prompt nobody ever sent. Stock reads such a
 * tail as a turn its process never finished: the next omp that opened it journaled "Previous OMP process exited
 * before completing the turn." and `omp --restore` would run it, although the prompt was answered in the
 * session it came from. A branch from a prompt now starts over like stock `branch`: the copy ends before the
 * prompt and the prompt comes back as the new session's draft.
 */
const omp = join(homedir(), ".bun", "bin", "omp");

const PROBE = `
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { hasRestorableTurn } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { methods } from "./sessions";
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = content => ({ role: "user", content, timestamp: Date.now() });
const reply = text => ({ role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "openai", model: "gpt-probe", usage, stopReason: "stop", timestamp: Date.now() });
const call = id => ({ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: "." } }], api: "openai-responses", provider: "openai", model: "gpt-probe", usage, stopReason: "toolUse", timestamp: Date.now() });
const result = (id, text) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: Date.now() });
async function describeFork(result) {
 const copy = await SessionManager.open(result.sessionPath, undefined, undefined, { throwIfMissing: true });
 try {
  const branch = copy.getBranch();
  const messages = branch.filter(entry => entry.type === "message").map(entry => entry.message);
  const last = messages.at(-1);
  // What a relaunch's restore (stock omp --restore) would find on this branch once its writer is gone.
  return {
   texts: messages.map(message => message.content.filter(block => block.type === "text").map(block => block.text).join("")),
   lastRole: last?.role,
   restorable: hasRestorableTurn(branch),
   // Tool calls in the copy whose result it does not hold: work nothing would ever answer.
   unanswered: messages.flatMap(message => message.role === "assistant" ? message.content.filter(block => block.type === "toolCall").map(block => block.id) : []).filter(id => !messages.some(message => message.role === "toolResult" && message.toolCallId === id)).length,
   draft: result.draft,
  };
 } finally {
  await copy.close();
 }
}
export default function (pi) {
 pi.on("session_start", async () => {
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = { pi, session: () => session, context: () => undefined, emit: () => {} };
   const sm = session.sessionManager;
   sm.appendMessage(user([{ type: "text", text: "first question" }]));
   const firstReply = sm.appendMessage(reply("first answer"));
   const prompt = sm.appendMessage(user([{ type: "text", text: "second question" }, { type: "image", data: "aGk=", mimeType: "image/png" }]));
   sm.appendMessage(reply("second answer"));
   const answeredCall = sm.appendMessage(call("c1"));
   sm.appendMessage(result("c1", "listing"));
   const openCall = sm.appendMessage(call("c2"));
   await sm.flush();
   const fork = methods["sessions.fork_from"];
   const out = {
    atPrompt: await describeFork(await fork({ entryId: prompt }, env)),
    atReply: await describeFork(await fork({ entryId: firstReply }, env)),
    atAnsweredCall: await describeFork(await fork({ entryId: answeredCall }, env)),
    atOpenCall: await describeFork(await fork({ entryId: openCall }, env)),
   };
   console.error("FORK_PROBE=" + JSON.stringify(out));
  } catch (err) {
   console.error("FORK_PROBE_ERROR=" + String((err && err.stack) || err));
  }
  process.exit(0);
 });
}
`;

interface ForkReport {
	texts: string[];
	lastRole?: string;
	restorable: boolean;
	unanswered: number;
	draft?: { text: string; images: Array<{ type: string; data: string; mimeType: string }> };
}

function runProbe(): Record<"atPrompt" | "atReply" | "atAnsweredCall" | "atOpenCall", ForkReport> {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-fork-"));
	chmodSync(isolated, 0o700);
	try {
		cpSync(resolve("resources/gui-bridge"), join(isolated, "bridge"), { recursive: true });
		const extension = join(isolated, "bridge", "fork-probe.ts");
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
		const line = result.stderr.split("\n").find(value => value.startsWith("FORK_PROBE="));
		expect(line, result.stderr.slice(-2500)).toMatch(/^FORK_PROBE=/);
		return JSON.parse(line?.slice("FORK_PROBE=".length) ?? "{}");
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
}

describe.skipIf(!existsSync(omp))("branch from here on stock omp", () => {
	it("starts a branch from a prompt before it, with the prompt as the draft, and never leaves an unsent prompt", () => {
		const { atPrompt, atReply } = runProbe();
		// From the user's prompt: the conversation up to the reply before it, nothing a relaunch would run.
		expect(atPrompt.texts).toEqual(["first question", "first answer"]);
		expect(atPrompt.lastRole).toBe("assistant");
		expect(atPrompt.restorable).toBe(false);
		expect(atPrompt.draft).toEqual({
			text: "second question",
			images: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
		});
		// From a reply: through that reply, as before, with no draft.
		expect(atReply.texts).toEqual(["first question", "first answer"]);
		expect(atReply.restorable).toBe(false);
		expect(atReply.draft).toBeUndefined();
	}, 130_000);

	it("keeps a tool batch through its recorded results, and cuts before a call still awaiting its result", () => {
		const { atAnsweredCall, atOpenCall } = runProbe();
		// Like stock `fork(entryId)`: the cut is carried through the call's recorded result.
		expect(atAnsweredCall.lastRole).toBe("toolResult");
		expect(atAnsweredCall.unanswered).toBe(0);
		// A call with no result anywhere: the copy ends before it, so it holds no call nothing will answer.
		expect(atOpenCall.lastRole).toBe("toolResult");
		expect(atOpenCall.unanswered).toBe(0);
		expect(atOpenCall.draft).toBeUndefined();
	}, 130_000);
});
