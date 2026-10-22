import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INSTALLED_OMP, runBridgeProbe } from "./test-bridge-probe";

/**
 * The model catalog the bridge sends every window and paired device (`providers`, `models_catalog`,
 * `model_catalog_update`), on the installed omp with the catalog's OpenAI models: stock's `compat` block (request
 * quirks for the provider's API, 76 % of a model's bytes, read by nothing in OMPdesk) stays on the omp's side. A
 * paired device's Settings read 1.73 MB of `get_providers` from a host with many providers. `model_roles` asked for
 * `compact` names each candidate model once (the same device read 882 KB of `get_model_roles`).
 */

const PROBE = `
import { methods } from "./settings";
import { expandModelRoles } from "./model-role-contracts";
export default function (pi) {
 pi.on("session_start", async () => {
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = { pi, session: () => session, context: () => undefined, emit: () => {} };
   const providers = await methods.providers({}, env);
   const available = await methods.models_catalog({}, env);
   const stock = session.getAvailableModels();
   const plainRoles = await methods.model_roles({}, env);
   const compactRoles = await methods.model_roles({ compact: true }, env);
   console.error("CATALOG_PROBE=" + JSON.stringify({
    count: providers.models.length,
    bytes: JSON.stringify(providers.models).length,
    withCompat: [...providers.models, ...available.models].filter(model => "compat" in model).length,
    stockWithCompat: stock.filter(model => "compat" in model).length,
    sample: providers.models[0],
    rolesPlainBytes: JSON.stringify(plainRoles).length,
    rolesCompactBytes: JSON.stringify(compactRoles).length,
    rolesRoundTrip: JSON.stringify(expandModelRoles(JSON.parse(JSON.stringify(compactRoles)))) === JSON.stringify(plainRoles),
    roleCandidates: plainRoles.roles.reduce((n, role) => n + (role.candidates?.length ?? 0), 0),
   }));
   process.exit(0);
  } catch (error) {
   console.error("CATALOG_PROBE=" + JSON.stringify({ error: String((error && error.stack) || error) }));
   process.exit(1);
  }
 });
}
`;

describe.skipIf(!existsSync(INSTALLED_OMP))("the model catalog the bridge sends", () => {
	it("leaves stock's compat block on the omp's side and keeps what the windows read", () => {
		const probe = runBridgeProbe(PROBE, "CATALOG_PROBE") as {
			count: number;
			bytes: number;
			withCompat: number;
			stockWithCompat: number;
			sample: Record<string, unknown>;
		};
		expect(probe.count).toBeGreaterThan(10);
		// Stock's own models carry it: the probe sees what the bridge would have sent.
		expect(probe.stockWithCompat).toBeGreaterThan(0);
		expect(probe.withCompat).toBe(0);
		// 2.5 KB a model with it, about 600 B without.
		expect(probe.bytes / probe.count).toBeLessThan(1000);
		for (const key of ["provider", "id", "name", "contextWindow", "maxTokens", "cost", "reasoning", "input"])
			expect(probe.sample).toHaveProperty(key);
	}, 120_000);

	it("names each role candidate once when asked, and expands to exactly the plain answer", () => {
		const probe = runBridgeProbe(PROBE, "CATALOG_PROBE") as {
			rolesPlainBytes: number;
			rolesCompactBytes: number;
			rolesRoundTrip: boolean;
			roleCandidates: number;
		};
		expect(probe.roleCandidates).toBeGreaterThan(100);
		expect(probe.rolesRoundTrip).toBe(true);
		const { rolesPlainBytes: plain, rolesCompactBytes: compact } = probe;
		expect(compact * 3, `${compact} B against ${plain} B`).toBeLessThan(plain);
	}, 120_000);
});
