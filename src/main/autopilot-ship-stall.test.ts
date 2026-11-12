import { describe, expect, it } from "vitest";
import {
	branch,
	commit,
	installShipRig,
	land,
	landElsewhere,
	remoteTip,
	runner,
	target,
	work,
} from "./autopilot-ship-test-rig";

installShipRig();

/**
 * The drain's bound (3 h in the app): the core's clock cannot be moved, so the stuck drain reaches a short real one once
 * its check is running; the drain after it runs real git, which costs over a second per git process on a saturated Windows
 * runner.
 */
const BOUND_MS = 400;

describe("a drain that never ends", () => {
	it("is stopped at its bound: the item it ran fails with the reason, and the next drain goes through", async () => {
		await landElsewhere("other.txt", "other\n");
		const sha = await commit(work, "a.txt");
		const checking = Promise.withResolvers<void>();
		const ship = runner({
			drainMaxMs: BOUND_MS,
			// A check whose supervisor never reports back.
			checkCandidate: () => {
				checking.resolve();
				return Promise.withResolvers<never>().promise;
			},
		});
		const landing = land(ship, sha, "true");
		await checking.promise;
		const stuck = await landing;
		expect(stuck?.item.state).toBe("failed");
		expect(stuck?.item.detail).toMatch(/did not finish in/);
		expect((await ship.queue()).some(item => item.state === "running")).toBe(false);
		const next = await commit(work, "b.txt");
		await ship.enqueue({ kind: "push", sha: next });
		const [pushed] = await ship.drain(target());
		expect(pushed?.item.state).toBe("done");
		expect(remoteTip(`refs/heads/${branch}`)).toBe(next);
	});
});
