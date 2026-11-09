import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INSTALLED_OMP, runBridgeProbe } from "./test-bridge-probe";

/**
 * Settings › Disconnect (`provider_logout`, gui-bridge settings.ts) on the installed omp, in an empty private agent
 * dir with stored credentials no provider knows: it removes every stored account of the provider and leaves the
 * other provider's alone.
 *
 * It runs wherever omp is installed, CI included. Until 10 Nov 2026 the only suite that called `provider_logout`
 * on stock was `bridge-accounts-stock`, which needs an `~/.omp/agent/agent.db`: on a runner it ran only when an
 * earlier suite's omp had left one there (skipped in ci run 42660216414). Stock's `logoutCredential` took the
 * session instead of a model registry from omp 18.18.2 (8 Nov), Disconnect threw
 * `undefined is not an object (evaluating 'i.authStorage')` on every omp since, and every check stayed green (the
 * capability probe only asks that the export exists) until the shards were dealt anew and that suite happened to
 * run (ci run 42701060204).
 */

const PROBE = `
import { methods } from "./settings";
export default function (pi) {
 pi.on("session_start", async () => {
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = { pi, session: () => session, context: () => undefined, emit: () => {} };
   const auth = session.modelRegistry.authStorage;
   const count = provider => auth.credentials.list(provider).length;
   await auth.credentials.upsert("ompdesk-logout-probe", { type: "api_key", key: "throwaway-not-a-real-key" });
   await auth.credentials.upsert("ompdesk-logout-kept", { type: "api_key", key: "another-throwaway-key" });
   const before = { probe: count("ompdesk-logout-probe"), kept: count("ompdesk-logout-kept") };
   const answer = await methods.provider_logout({ providerId: "ompdesk-logout-probe" }, env);
   await auth.credentials.reload();
   console.error("LOGOUT_PROBE=" + JSON.stringify({
    before,
    after: { probe: count("ompdesk-logout-probe"), kept: count("ompdesk-logout-kept") },
    answer,
   }));
   process.exit(0);
  } catch (error) {
   console.error("LOGOUT_PROBE=" + JSON.stringify({ error: String((error && error.stack) || error) }));
   process.exit(1);
  }
 });
}
`;

describe.skipIf(!existsSync(INSTALLED_OMP))("disconnecting a provider on stock omp", () => {
	it("removes every stored account of that provider and no other provider's", () => {
		expect(runBridgeProbe(PROBE, "LOGOUT_PROBE")).toEqual({
			before: { probe: 1, kept: 1 },
			after: { probe: 0, kept: 1 },
			answer: { providerId: "ompdesk-logout-probe" },
		});
	}, 120_000);
});
