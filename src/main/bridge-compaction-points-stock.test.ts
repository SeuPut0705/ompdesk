import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INSTALLED_OMP, runBridgeProbe } from "./test-bridge-probe";

/**
 * `compaction_points` on the installed omp. The context ring and the Run sheet's compaction-point row show the session
 * model's point alone; the whole table (every available model and every role's resolved model) was 62 KB a read,
 * read again on every tab hydration and sent to a paired device each time. With `selector` the bridge answers that
 * model's point, the same as the table's entry, and no roles.
 */

const PROBE = `
import { methods } from "./compaction-limits";
export default function (pi) {
 pi.on("session_start", async () => {
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = { pi, session: () => session, context: () => undefined, emit: () => {} };
   const whole = await methods.compaction_points({}, env);
   const first = whole.models[0];
   const one = await methods.compaction_points({ selector: first.selector }, env);
   const missing = await methods.compaction_points({ selector: "nobody/none" }, env);
   console.error("POINTS_PROBE=" + JSON.stringify({
    models: whole.models.length,
    roles: whole.roles.length,
    wholeBytes: JSON.stringify(whole).length,
    oneBytes: JSON.stringify(one).length,
    first,
    one,
    missing,
   }));
   process.exit(0);
  } catch (error) {
   console.error("POINTS_PROBE=" + JSON.stringify({ error: String((error && error.stack) || error) }));
   process.exit(1);
  }
 });
}
`;

describe.skipIf(!existsSync(INSTALLED_OMP))("compaction points the bridge sends", () => {
	it("answers one model's point, as the whole table has it, when asked for that model", () => {
		const probe = runBridgeProbe(PROBE, "POINTS_PROBE") as {
			models: number;
			roles: number;
			wholeBytes: number;
			oneBytes: number;
			first: unknown;
			one: { models: unknown[]; roles: unknown[] };
			missing: { models: unknown[]; roles: unknown[] };
		};
		expect(probe.models).toBeGreaterThan(10);
		expect(probe.one).toEqual({ models: [probe.first], roles: [] });
		expect(probe.missing).toEqual({ models: [], roles: [] });
		expect(probe.oneBytes * 20).toBeLessThan(probe.wholeBytes);
		console.info(
			`compaction points: whole ${probe.wholeBytes} B (${probe.models} models, ${probe.roles} roles), one ${probe.oneBytes} B`,
		);
	});
});
