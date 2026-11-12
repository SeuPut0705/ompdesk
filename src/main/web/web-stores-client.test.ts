import { describe, expect, it, vi } from "vitest";
import type { WebDevice } from "./devices-store";
import { seededDevice } from "./test-web-devices";
import { StoresChannel } from "./web-stores-client";

// The copy's rules for the core's snapshots, over synthetic events: no core process. The core side is
// crates/core/src/web/store.rs; devices-store.test.ts and blocks-store.test.ts run both together.
const named = (name: string): WebDevice => seededDevice({ deviceId: name, name }).record;
const snapshot = (names: string[], version: number, ack = 0) => ({ list: names.map(named), version, ack });
const told = (names: string[], version: number, ack = 0, notify = false) => ({
	userData: "ud",
	devices: names.map(named),
	version,
	ack,
	notify,
});
const names = (channel: StoresChannel) => channel.devices.list.map(device => device.name);

function loaded(...initial: string[]): StoresChannel {
	const channel = new StoresChannel("ud");
	channel.devices.load(snapshot(initial, 1), 0);
	return channel;
}

describe("the copy of the core's devices", () => {
	it("takes a newer snapshot and ignores one older than what it saw", () => {
		const channel = loaded("a");
		channel.devicesChanged(told(["a", "b", "c"], 3));
		channel.devicesChanged(told(["a", "b"], 2));
		expect(names(channel)).toEqual(["a", "b", "c"]);
		channel.devicesChanged(told(["a", "b", "c"], 3, 0));
		expect(names(channel), "the same version again is no news").toEqual(["a", "b", "c"]);
	});

	it("keeps a change of its own until the core says it applied it", () => {
		const channel = loaded("a");
		// A push was sent (number 1) and the copy already shows its effect.
		channel.devices.seq = 1;
		channel.devices.list = [named("a"), named("mine")];
		// A list the core made before it saw the push.
		channel.devicesChanged(told(["a", "edge"], 2, 0));
		expect(names(channel)).toEqual(["a", "mine"]);
		// The answer to the push holds both.
		channel.devicesChanged(told(["a", "mine", "edge"], 3, 1));
		expect(names(channel)).toEqual(["a", "mine", "edge"]);
		// An older answer arriving late changes nothing.
		channel.devicesChanged(told(["a"], 2, 1));
		expect(names(channel)).toEqual(["a", "mine", "edge"]);
	});

	it("holds what the core tells before it answers the open, and the newer of the two wins", () => {
		const first = new StoresChannel("ud");
		first.devicesChanged(told(["event"], 6));
		expect(names(first), "nothing is taken before the open's answer").toEqual([]);
		first.devices.load(snapshot(["opened"], 5), 0);
		expect(names(first)).toEqual(["event"]);
		const second = new StoresChannel("ud");
		second.devicesChanged(told(["event"], 4));
		second.devices.load(snapshot(["opened"], 5), 0);
		expect(names(second)).toEqual(["opened"]);
	});

	it("settles what was pushed to a core that ended with the open of the next one", () => {
		const channel = loaded("a");
		channel.devices.seq = 3;
		channel.devices.list = [named("lost"), named("a")];
		// The core ended: the pushes it never applied are gone with it.
		channel.devices.reset();
		channel.devices.load(snapshot(["a", "edge"], 1, 0), 3);
		expect(names(channel)).toEqual(["a", "edge"]);
		// What the new core tells next is believed even though it never applied pushes 1 to 3...
		channel.devicesChanged(told(["a", "edge", "later"], 2, 0));
		expect(names(channel)).toEqual(["a", "edge", "later"]);
		// ...but a push made after the open waits for its own answer.
		channel.devices.seq = 4;
		channel.devices.list = [named("a"), named("fresh")];
		channel.devicesChanged(told(["a", "edge"], 3, 0));
		expect(names(channel)).toEqual(["a", "fresh"]);
		channel.devicesChanged(told(["a", "fresh"], 4, 4));
		expect(names(channel)).toEqual(["a", "fresh"]);
	});

	it("tells the listeners of a change only when the core says the settings page shows it", () => {
		const channel = loaded("a");
		const changed = vi.fn();
		channel.devicesListeners.add(changed);
		channel.devicesChanged(told(["a", "b"], 2, 0, false));
		expect(changed).not.toHaveBeenCalled();
		channel.devicesChanged(told(["a", "b", "c"], 3, 0, true));
		expect(changed).toHaveBeenCalledTimes(1);
	});

	it("tells the revoked listeners of a device it still holds, and of none it already removed itself", () => {
		const channel = loaded("a", "b");
		const revoked = vi.fn();
		channel.revokedListeners.add(revoked);
		channel.deviceRevoked("b");
		expect(names(channel), "gone from the copy before the listeners run").toEqual(["a"]);
		expect(revoked).toHaveBeenCalledExactlyOnceWith("b");
		channel.deviceRevoked("b");
		channel.deviceRevoked("ghost");
		expect(revoked).toHaveBeenCalledTimes(1);
	});

	it("keeps the blocks by the same rules", () => {
		const channel = new StoresChannel("ud");
		const entry = (id: string) => ({ id, scope: "node" as const, name: id, tailscaleLogin: null, blockedAt: 1 });
		channel.blocks.load({ list: [entry("node:a")], version: 1, ack: 0 }, 0);
		channel.blocks.seq = 1;
		channel.blocks.list = [entry("node:a"), entry("node:b")];
		channel.blocksChanged({ userData: "ud", blocks: [entry("node:a")], version: 2, ack: 0 });
		expect(channel.blocks.list.map(block => block.id)).toEqual(["node:a", "node:b"]);
		channel.blocksChanged({ userData: "ud", blocks: [entry("node:a"), entry("node:b")], version: 3, ack: 1 });
		expect(channel.blocks.list.map(block => block.id)).toEqual(["node:a", "node:b"]);
	});
});
