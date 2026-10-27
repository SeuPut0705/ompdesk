import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Pins resources/gui-bridge/context-hook.ts to the installed omp, through stock's own `ExtensionRunner` on the real
 * `pi` (an empty private agent dir, no model call): the hook leaves stock's handler table (`pi.extension.handlers`)
 * after a request with nothing to drop, so `emitContext` returns the very array it was given (no `structuredClone`),
 * and is back after stock's `before_agent_start` and after `armContextHook`.
 */
const omp = join(homedir(), ".bun", "bin", "omp");

const PROBE = `
import { armContextHook, installContextHook } from "./context-hook";
export default function (pi) {
 let calls = 0;
 installContextHook(pi, "probe-drop", event => {
  calls++;
  const messages = event.messages.filter(m => m.customType !== "probe-drop");
  return messages.length === event.messages.length ? undefined : { messages };
 });
 pi.on("session_start", async () => {
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const runner = session.extensionRunner;
   const user = { role: "user", content: [{ type: "text", text: "x" }], timestamp: 1 };
   const drop = { role: "custom", customType: "probe-drop", content: "d", display: false, timestamp: 2 };
   const out = { atStart: runner.hasHandlers("context") };
   const first = [user];
   out.firstCopied = (await runner.emitContext(first)) !== first;
   out.afterFirst = runner.hasHandlers("context");
   const second = [user, user];
   out.secondSame = (await runner.emitContext(second)) === second;
   out.calls = calls;
   await runner.emitBeforeAgentStart("hi", undefined, ["base"]);
   out.afterPrompt = runner.hasHandlers("context");
   // A pre-prompt compaction's request before the notice joins: the hook stays until the run's agent_start.
   await runner.emitContext([user]);
   out.heldThroughPreparation = runner.hasHandlers("context");
   out.sent = (await runner.emitContext([user, drop])).map(m => m.role);
   out.afterDrop = runner.hasHandlers("context");
   await runner.emit({ type: "agent_start" });
   await runner.emitContext([user]);
   out.leftAgain = !runner.hasHandlers("context");
   const release = armContextHook("probe-drop", session.sessionManager);
   out.afterArm = runner.hasHandlers("context");
   await runner.emitContext([user]);
   out.heldByArm = runner.hasHandlers("context");
   release();
   await runner.emitContext([user]);
   out.leftAfterRelease = !runner.hasHandlers("context");
   console.error("CTXHOOK_PROBE=" + JSON.stringify(out));
  } catch (err) {
   console.error("CTXHOOK_PROBE_ERROR=" + String(err && err.stack || err));
  }
  process.exit(0);
 });
}
`;

interface Probe {
	atStart: boolean;
	firstCopied: boolean;
	afterFirst: boolean;
	secondSame: boolean;
	calls: number;
	afterPrompt: boolean;
	heldThroughPreparation: boolean;
	sent: string[];
	afterDrop: boolean;
	leftAgain: boolean;
	afterArm: boolean;
	heldByArm: boolean;
	leftAfterRelease: boolean;
}

function runProbe(): Probe {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-ctxhook-"));
	chmodSync(isolated, 0o700);
	try {
		mkdirSync(join(isolated, "bridge"));
		cpSync(resolve("resources/gui-bridge/context-hook.ts"), join(isolated, "bridge", "context-hook.ts"));
		const extension = join(isolated, "bridge", "ctxhook-probe.ts");
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
			{ env, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024, input: "" },
		);
		const line = result.stderr.split("\n").find(value => value.startsWith("CTXHOOK_PROBE="));
		expect(line, result.stderr.slice(-2500)).toMatch(/^CTXHOOK_PROBE=/);
		return JSON.parse(line?.slice("CTXHOOK_PROBE=".length) ?? "{}") as Probe;
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
}

describe.skipIf(!existsSync(omp))("context hook on stock omp", () => {
	it("leaves stock's handler table while nothing needs dropping, so requests go uncopied, and comes back", () => {
		const probe = runProbe();
		expect(probe).toEqual({
			atStart: true,
			// The first request runs the hook on stock's copy; it then leaves the table.
			firstCopied: true,
			afterFirst: false,
			// No `context` handler: stock hands the same array on, with no structuredClone.
			secondSame: true,
			calls: 1,
			afterPrompt: true,
			// Stock's pre-prompt compaction runs before the mount notice joins: the hook waits for the run's agent_start.
			heldThroughPreparation: true,
			sent: ["user"],
			afterDrop: true,
			leftAgain: true,
			// armContextHook holds it on until released (the recap is in the branch by then).
			afterArm: true,
			heldByArm: true,
			leftAfterRelease: true,
		});
	}, 130_000);
});
