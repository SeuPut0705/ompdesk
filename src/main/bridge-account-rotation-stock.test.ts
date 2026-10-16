import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Pins quota re-ranking (account-rotation.ts) to stock's own selector and ranking on the installed omp: an empty
 * private agent dir holds two throwaway Anthropic OAuth credentials, a runtime usage provider (stock
 * `usage.setProvider`) stands in for the network with per-account 5h and 7d windows, and the bridge's real
 * `before_agent_start` handler runs against the real session at each turn start. Nothing reaches a provider and no
 * user data is read.
 *
 * - An automatic pin moves to the account stock ranks first when its 7d required drain beats the pin's by more
 *   than the margin (2x: 2.7x moves it), and the new pin is an automatic one a subagent then inherits.
 * - Inside the margin (1.9x either way) nothing moves, turn after turn; just past it (2.1x) the session moves, and
 *   once moved it does not come back for a 1.9x gap.
 * - Stock's own tiers move a pin at once, whatever the drain: a pin whose 5h window is at 90% (stock demotes
 *   85%) loses to a cool account that drains 3x slower.
 * - An explicit pin stays, a cold pin is left to stock (which then ranks it away itself), and a subagent's turn
 *   never re-ranks.
 * - Stock's selector pick, the pin's provenance read and the comparator leave no pin behind.
 */
const omp = join(homedir(), ".bun", "bin", "omp");

const PROBE = `
import { install } from "./account-rotation";

export default function (pi) {
 pi.on("session_start", async () => {
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const auth = session.modelRegistry.authStorage;
   const expires = Date.now() + 3_600_000;
   const H = 3_600_000;
   const credential = email => ({ type: "oauth", access: "probe-access-" + email, refresh: "probe-refresh-" + email, expires, email, accountId: "acc-" + email });
   await auth.credentials.upsert("anthropic", credential("a@example.test"));
   await auth.credentials.upsert("anthropic", credential("b@example.test"));
   const rows = auth.credentials.list("anthropic");
   const ids = { a: rows.find(row => row.credential.email === "a@example.test").id, b: rows.find(row => row.credential.email === "b@example.test").id };
   // The 7d required drain stock ranks by is headroom / hours to reset; D0 is account B's in the first phase.
   const D0 = 0.98 / 77;
   const account = (used5, drain, resetH) => {
    const used7 = 1 - drain * resetH;
    if (used7 < 0 || used7 > 1) throw new Error("drain " + drain + " is not reachable with a " + resetH + "h reset");
    return { used5, used7, resetH };
   };
   const state = { a: account(0.04, 0.46 / 97.5, 97.5), b: account(0.03, D0, 77) };
   const limit = (id, windowId, used, durationMs, resetH) => ({
    id,
    label: id,
    scope: { provider: "anthropic", windowId, shared: true },
    amount: { usedFraction: used, unit: "percent" },
    window: { id: windowId, label: windowId, durationMs, resetsAt: Date.now() + resetH * H },
   });
   auth.usage.setProvider("anthropic", {
    id: "anthropic",
    async fetchUsage(params) {
     const s = state[params.credential.email === "a@example.test" ? "a" : "b"];
     return {
      provider: "anthropic",
      fetchedAt: Date.now(),
      limits: [limit("anthropic:5h", "5h", s.used5, 5 * H, 3), limit("anthropic:7d", "7d", s.used7, 168 * H, s.resetH)],
      metadata: { email: params.credential.email, accountId: "acc-" + params.credential.email },
     };
    },
   });
   const model = session.modelRegistry.getAll().find(candidate => candidate.provider === "anthropic");
   await session.setModel(model);
   // The real handler, registered on a stand-in pi that only collects it.
   const handlers = [];
   install({ on: (event, handler) => { if (event === "before_agent_start") handlers.push(handler); }, pi: pi.pi, logger: pi.logger });
   const sid = session.sessionId;
   const contextAs = kind => {
    const base = session.extensionRunner.createContext(model);
    return Object.create(base, { agent: { value: { ...base.agent, kind } } });
   };
   const turnStart = async kind => handlers[0]({ type: "before_agent_start", prompt: "hello", systemPrompt: [] }, contextAs(kind ?? "main"));
   const pinOf = sessionId => auth.oauth.accounts("anthropic", sessionId).find(entry => entry.active)?.credentialId ?? null;
   const pinned = (credentialId, restoredAtMs) => {
    auth.sessions.release("anthropic", sid);
    auth.sessions.pin("anthropic", sid, credentialId, restoredAtMs === undefined ? undefined : { restoredAtMs });
   };
   const explicitOf = sessionId => {
    let explicit;
    auth.sessions.inherit(sessionId, sessionId + ":read", (provider, flag) => { if (provider === "anthropic") explicit = flag; return false; });
    return explicit;
   };
   const refresh = async () => auth.usage.invalidate("anthropic");
   const out = { ids };
   const sequence = [];
   const turn = async (label, kind) => {
    await refresh();
    await turnStart(kind);
    sequence.push({ label, pin: pinOf(sid) === ids.a ? "a" : pinOf(sid) === ids.b ? "b" : pinOf(sid), explicit: explicitOf(sid) ?? null });
   };

   // Phase 0: automatic warm pin on A; B drains 2.7x faster, as in the user's session. A subagent's turn leaves it.
   out.ratio = D0 / (0.46 / 97.5);
   pinned(ids.a, Date.now() - 5 * 60_000);
   await refresh();
   await turnStart("sub");
   out.subTurnPin = pinOf(sid) === ids.a ? "a" : "other";
   await turn("a-to-b-2.7x");
   out.childPin = (() => { auth.sessions.inherit(sid, "child-session"); return pinOf("child-session") === ids.b ? "b" : pinOf("child-session"); })();
   out.childExplicit = explicitOf("child-session") ?? null;
   await turn("b-stays-same-top");
   // Inside the margin: A drains 1.9x B's, then 2.1x.
   state.a = account(0.04, 1.9 * D0, 20);
   await turn("b-stays-1.9x");
   await turn("b-stays-1.9x-again");
   state.a = account(0.04, 2.1 * D0, 20);
   await turn("b-to-a-2.1x");
   // Moved to A; B is now 1.9x A's drain: no way back.
   state.b = account(0.03, 1.9 * 2.1 * D0, 18);
   await turn("a-stays-1.9x");
   await turn("a-stays-1.9x-again");
   // Stock's tier: A's 5h window at 90% (hot) loses at once to cool B though A drains 3x faster.
   state.a = account(0.9, 3 * D0, 20);
   state.b = account(0.1, D0, 77);
   await turn("a-hot-to-b");
   // Explicit pin on A, B far better: stays.
   state.a = account(0.04, 0.46 / 97.5, 97.5);
   pinned(ids.a);
   await turn("explicit-stays");
   // Cold pin on A: the bridge leaves it, and stock's own selector then moves it.
   pinned(ids.a, Date.now() - 2 * H);
   await turn("cold-left-to-stock");
   const resolved = await auth.keys.getWithCredential("anthropic", sid, { modelId: model.id, baseUrl: model.baseUrl });
   out.stockAfterCold = resolved?.credentialId === ids.b ? "b" : resolved?.credentialId;
   out.stockPinAfterCold = pinOf(sid) === ids.b ? "b" : pinOf(sid);
   out.sequence = sequence;
   // The pick, the provenance read and the comparator recorded nothing: only the real sessions hold pins.
   out.strayProbePin = auth.oauth.accounts("anthropic", sid + ":read").some(entry => entry.active);
   console.error("ROTATION_PROBE=" + JSON.stringify(out));
   process.exit(0);
  } catch (error) {
   console.error("ROTATION_PROBE_FAILED " + (error instanceof Error ? error.stack : String(error)));
   process.exit(1);
  }
 });
}
`;

describe.skipIf(!existsSync(omp))("bridge quota re-rank on stock's selector", () => {
	it("moves an automatic warm pin only when stock ranks another account first by more than the margin, never an explicit one, and never flip-flops", () => {
		const isolated = mkdtempSync(join(tmpdir(), "ompdesk-rotation-rerank-"));
		chmodSync(isolated, 0o700);
		try {
			cpSync(resolve("resources/gui-bridge"), join(isolated, "bridge"), { recursive: true });
			const extension = join(isolated, "bridge", "rotation-rerank-probe.ts");
			writeFileSync(extension, PROBE);
			// A throwaway OpenAI key only gives the session a default model; nothing is prompted.
			const env: Record<string, string | undefined> = {
				...process.env,
				PI_CODING_AGENT_DIR: isolated,
				PI_CONFIG_DIR: isolated,
				OMP_PROFILE: "",
				PI_PROFILE: "",
				OPENAI_API_KEY: "probe-not-a-real-key",
				OMP_GUI_ACCOUNT_ROTATION: "quota",
			};
			// An Anthropic key from the shell would add a third credential.
			for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) {
				Reflect.deleteProperty(env, key);
			}
			const result = spawnSync(
				omp,
				["--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-rules", "-e", extension],
				{ env, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024, input: "" },
			);
			const line = result.stderr.split("\n").find(value => value.startsWith("ROTATION_PROBE"));
			expect(line, result.stderr.slice(-2000)).toMatch(/^ROTATION_PROBE=/);
			const probe = JSON.parse(line?.slice("ROTATION_PROBE=".length) ?? "{}") as {
				ratio: number;
				subTurnPin: string;
				childPin: string;
				childExplicit: boolean | null;
				sequence: Array<{ label: string; pin: string; explicit: boolean | null }>;
				stockAfterCold: string;
				stockPinAfterCold: string;
				strayProbePin: boolean;
			};
			// The user's numbers: B's 7d drain 2.7x A's.
			expect(probe.ratio).toBeGreaterThan(2.6);
			// A subagent's own turn never re-ranks, whatever stock would pick.
			expect(probe.subTurnPin).toBe("a");
			const pins = Object.fromEntries(probe.sequence.map(step => [step.label, step.pin]));
			expect(pins).toEqual({
				"a-to-b-2.7x": "b",
				"b-stays-same-top": "b",
				"b-stays-1.9x": "b",
				"b-stays-1.9x-again": "b",
				"b-to-a-2.1x": "a",
				"a-stays-1.9x": "a",
				"a-stays-1.9x-again": "a",
				"a-hot-to-b": "b",
				"explicit-stays": "a",
				"cold-left-to-stock": "a",
			});
			// Every move is an automatic pin, never an explicit one; the explicit one is still explicit afterwards.
			for (const step of probe.sequence) {
				expect(step.explicit, step.label).toBe(step.label === "explicit-stays");
			}
			// A subagent spawned after the move inherits the parent's new pin, as stock copies it.
			expect(probe.childPin).toBe("b");
			expect(probe.childExplicit).toBe(false);
			// Stock itself re-ranks the cold pin the bridge left alone.
			expect(probe.stockAfterCold).toBe("b");
			expect(probe.stockPinAfterCold).toBe("b");
			expect(probe.strayProbePin).toBe(false);
		} finally {
			rmSync(isolated, { recursive: true, force: true });
		}
	}, 130_000);
});
