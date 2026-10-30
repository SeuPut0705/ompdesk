import { afterEach, describe, expect, it, vi } from "vitest";
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
 * The drain's bound. The stuck drain reaches it on a fake clock, once its check is running; the drain after it runs
 * real git on the real clock, which costs over a second per git process on a saturated Windows runner.
 */
const BOUND_MS = 60_000;

afterEach(() => {
	vi.useRealTimers();
});

describe("a drain that never ends", () => {
	it("is stopped at its bound: the item it ran fails with the reason, and the next drain goes through", async () => {
		await landElsewhere("other.txt", "other\n");
		const sha = await commit(work, "a.txt");
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
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
		vi.advanceTimersByTime(BOUND_MS);
		const stuck = await landing;
		vi.useRealTimers();
		expect(stuck?.item.state).toBe("failed");
		expect(stuck?.item.detail).toMatch(/did not finish in/);
		expect(ship.queue().some(item => item.state === "running")).toBe(false);
		const next = await commit(work, "b.txt");
		ship.enqueue({ kind: "push", sha: next });
		const [pushed] = await ship.drain(target());
		expect(pushed?.item.state).toBe("done");
		expect(remoteTip(`refs/heads/${branch}`)).toBe(next);
	});
});
