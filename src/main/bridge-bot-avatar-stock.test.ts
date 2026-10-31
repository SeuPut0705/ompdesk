import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INSTALLED_OMP, runBridgeProbe } from "./test-bridge-probe";

/**
 * Pins Settings › Bot › Generate to the installed omp, in an empty private agent dir (a throwaway key only gives the
 * catalog models; nothing is generated and no request leaves the machine): the `botAvatar` feature is available
 * (every stock internal it reads exists, none a separate copy), and `bot_avatar.status` answers from stock's image
 * role chain without drawing.
 */
const PROBE = `
import { methods } from "./bot-avatar";
import { probe } from "./health";
export default function (pi) {
 pi.on("session_start", async () => {
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = { pi, session: () => session, context: () => undefined, emit: () => {} };
   const out = {};
   out.unavailable = (await probe(env, ["botAvatar"])).map(entry => ({ feature: entry.feature, missing: entry.missing }));
   out.status = await methods["bot_avatar.status"]({}, env);
   console.error("AVATAR_PROBE=" + JSON.stringify(out));
  } catch (err) {
   console.error("AVATAR_PROBE_ERROR=" + String((err && err.stack) || err));
  }
  process.exit(0);
 });
}
`;

interface Probe {
	unavailable: Array<{ feature: string; missing: string[] }>;
	status: { available: boolean; model?: string; reason?: string };
}

const probe = (env: Record<string, string> = {}) => runBridgeProbe(PROBE, "AVATAR_PROBE", env) as unknown as Probe;

describe.skipIf(!existsSync(INSTALLED_OMP))("bot avatar on the installed omp", () => {
	it("names the image model stock's role chain resolves for an OpenAI key, without generating", () => {
		const { unavailable, status } = probe();
		expect(unavailable).toEqual([]);
		expect(status.available).toBe(true);
		expect(status.model).toMatch(/^openai\//);
	});

	it("says no image model is set up when the only key is for a provider with none", () => {
		const { unavailable, status } = probe({ OPENAI_API_KEY: "", GROQ_API_KEY: "probe-not-a-real-key" });
		expect(unavailable).toEqual([]);
		expect(status).toEqual({ available: false, reason: "no_model" });
	});
});
