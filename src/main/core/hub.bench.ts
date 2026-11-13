/**
 * One synchronous hub call against the real core: main blocks on `Atomics.wait` until the hub worker hands it the
 * answer (`bunx vitest bench src/main/core/hub.bench.ts`). Reported, never asserted: a unit test bounding it failed on
 * a loaded Windows runner (1.37 ms against a 1 ms bound, run 43487947733).
 */
import { afterAll, bench, describe } from "vitest";
import { Hub } from "./hub";
import { stopCore } from "./process";

afterAll(() => stopCore());

describe("the hub connection", () => {
	let probe: { hub: Hub; id: number } | null = null;
	let n = 0;
	bench("one synchronous call that pushes an item", () => {
		if (!probe) {
			const hub = new Hub();
			probe = { hub, id: hub.nextId() };
			hub.open(probe.id, "test:probe", {}, { item: () => {}, ask: () => "yes", lost: () => {} });
		}
		probe.hub.call(probe.id, "push", { n: n++ });
	});
});
