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

describe("a drain that never ends", () => {
	it("is stopped at its bound: the item it ran fails with the reason, and the next drain goes through", async () => {
		await landElsewhere("other.txt", "other\n");
		const sha = await commit(work, "a.txt");
		const ship = runner({
			drainMaxMs: 300,
			// A check whose supervisor never reports back.
			checkCandidate: () => Promise.withResolvers<never>().promise,
		});
		const stuck = await land(ship, sha, "true");
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
