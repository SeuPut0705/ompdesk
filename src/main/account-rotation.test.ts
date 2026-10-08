/**
 * The account-rotation pref fan-out: a change is stored, then pushed to every
 * local tab and to the tabs this computer hosts; tabs on a paired host follow
 * the host's own pref and get nothing.
 */
import { describe, expect, it } from "vitest";
import { ACCOUNT_ROTATION_PREF } from "../shared/account-rotation";
import { accountRotationDeps } from "./account-rotation";

function tab(device?: string) {
	return {
		device,
		syncs: 0,
		syncAccountRotation() {
			this.syncs++;
		},
	};
}

describe("accountRotationDeps", () => {
	it("stores a change and pushes it to local tabs and hosted tabs, never to a paired host's tabs", async () => {
		const store = new Map<string, unknown>();
		const local = [tab(), tab()];
		const remote = tab("host-b");
		let hosted = 0;
		const deps = accountRotationDeps({
			prefs: { get: key => store.get(key), set: (key, value) => store.set(key, value) },
			tabs: () => [...local, remote],
			hostedTabsChanged: () => {
				hosted++;
			},
			evenSupported: async () => true,
		});

		expect(deps.read()).toBeUndefined();
		deps.write("even");
		expect(store.get(ACCOUNT_ROTATION_PREF)).toBe("even");
		expect(deps.read()).toBe("even");
		expect(local.map(entry => entry.syncs)).toEqual([1, 1]);
		expect(remote.syncs).toBe(0);
		expect(hosted).toBe(1);
		await expect(deps.evenSupported()).resolves.toBe(true);
	});
});
