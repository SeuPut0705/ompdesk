import { describe, expect, it } from "vitest";
import { branch, commit, installShipRig, remoteTip, runner, target, work } from "./autopilot-ship-test-rig";
import { gitRunner } from "./local/git/exec";

installShipRig();

/**
 * The drain's bound (3 h in the app) is given to the one drain that must reach it, as a short real one: the core's clock
 * cannot be moved. The step that never ends is the first thing the drain awaits, main's answer with the git runner, so
 * the bound is reached before any git runs: git is slow on a saturated Windows runner, over a second a process, and a
 * bound that git races against stops the drain before the point the test means. The next drain has the app's bound and
 * runs real git.
 */
const BOUND_MS = 1_000;

describe("a drain that never ends", () => {
	it("is stopped at its bound: the item it ran fails with the reason, and the next drain goes through", async () => {
		const sha = await commit(work, "a.txt");
		const asked = Promise.withResolvers<void>();
		let calls = 0;
		const ship = runner({
			// The first ask is never answered; later ones are.
			gitRunner: () => {
				calls++;
				if (calls > 1) return gitRunner();
				asked.resolve();
				return Promise.withResolvers<never>().promise;
			},
		});
		await ship.enqueue({ kind: "push", sha });
		const draining = ship.drain(target(), { maxMs: BOUND_MS });
		await asked.promise;
		const [stuck] = await draining;
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
