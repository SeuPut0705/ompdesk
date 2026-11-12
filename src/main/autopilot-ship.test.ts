import { describe, expect, it } from "vitest";
import { branch, broadcasts, commit, installShipRig, remoteTip, runner, target, work } from "./autopilot-ship-test-rig";

installShipRig();

describe("ShipRunner queue", () => {
	it("shows queued → running → done in order and broadcasts every change", async () => {
		await commit(work, "a.txt");
		const ship = runner();
		const item = await ship.enqueue({ kind: "push" });
		expect(item).toMatchObject({ kind: "push", state: "queued" });
		await ship.drain(target());
		expect((await ship.queue()).map(entry => entry.state)).toEqual(["done"]);
		const seen = broadcasts.map(queue => queue[0]?.state);
		expect(seen).toEqual(["queued", "running", "done"]);
	});

	it("cancels only an item that has not started", async () => {
		const ship = runner();
		const item = await ship.enqueue({ kind: "push" });
		expect(await ship.cancel(item.id)).toBe(true);
		expect(await ship.queue()).toEqual([]);
		expect(await ship.cancel("nope")).toBe(false);
	});

	it("one failed item does not stop the others", async () => {
		const sha = await commit(work, "a.txt");
		const ship = runner();
		await ship.enqueue({ kind: "revert", cycle: 3, sha: "0000000000000000000000000000000000000000" });
		await ship.enqueue({ kind: "push" });
		const results = await ship.drain(target());
		expect(results.map(result => result.item.state)).toEqual(["failed", "done"]);
		expect(remoteTip(`refs/heads/${branch}`)).toBe(sha);
	});

	it("keeps the newest release item while later pushes push the finished ones out", async () => {
		await commit(work, "a.txt");
		const ship = runner();
		const release = await ship.track({ kind: "release", detail: "v1" });
		for (let i = 0; i < 25; i++)
			await ship.enqueue({ kind: "revert", cycle: i, sha: "0000000000000000000000000000000000000000" });
		await ship.drain(target());
		await ship.finish(release.id, "done", "ok");
		await ship.drain(target());
		expect((await ship.queue()).find(item => item.kind === "release")).toMatchObject({ state: "done" });
		expect((await ship.queue()).filter(item => item.kind === "revert").length).toBeLessThanOrEqual(20);
	});

	it("tracks a release for display only: the runner never executes it", async () => {
		const ship = runner();
		const item = await ship.track({ kind: "release", detail: "v1.2.3" });
		expect(item.state).toBe("running");
		await ship.drain(target());
		expect((await ship.queue())[0]?.state).toBe("running");
		await ship.finish(item.id, "done", "run passed");
		expect((await ship.queue())[0]).toMatchObject({ state: "done", detail: "run passed" });
	});
});
