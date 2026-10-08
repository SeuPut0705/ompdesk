import { createSocket } from "node:dgram";
import { afterEach, describe, expect, it } from "vitest";
import { BeaconBroadcaster, BeaconListener, broadcastTargets, type DiscoveredHost } from "./discovery";

const stops: (() => void)[] = [];

afterEach(() => {
	for (const stop of stops.splice(0)) stop();
});

/** A UDP port that was free a moment ago. */
async function freeUdpPort(): Promise<number> {
	const socket = createSocket("udp4");
	const { promise, resolve } = Promise.withResolvers<number>();
	socket.bind(0, "127.0.0.1", () => {
		const { port } = socket.address();
		socket.close(() => resolve(port));
	});
	return promise;
}

function listener(port: number, ignoreDeviceId?: string): BeaconListener {
	const instance = new BeaconListener({ port, ignoreDeviceId });
	stops.push(() => instance.stop());
	return instance;
}

function nextBeacon(instance: BeaconListener): Promise<DiscoveredHost> {
	const { promise, resolve } = Promise.withResolvers<DiscoveredHost>();
	const onBeacon = (host: DiscoveredHost) => {
		instance.off("beacon", onBeacon);
		resolve(host);
	};
	instance.on("beacon", onBeacon);
	return promise;
}

function broadcaster(port: number, deviceId: string): BeaconBroadcaster {
	const instance = new BeaconBroadcaster({
		port,
		intervalMs: 50,
		targets: () => ["127.0.0.1"],
		beacon: () => ({ deviceId, name: "Studio", port: 47821 }),
	});
	stops.push(() => instance.stop());
	return instance;
}

describe("UDP beacon discovery", () => {
	it("delivers a host beacon to a listener", async () => {
		const port = await freeUdpPort();
		const receiver = listener(port);
		expect(await receiver.start()).toBe(true);
		const received = nextBeacon(receiver);
		await broadcaster(port, "host-1").start();
		expect(await received).toMatchObject({
			deviceId: "host-1",
			name: "Studio",
			host: "127.0.0.1",
			port: 47821,
			address: "127.0.0.1:47821",
		});
	});

	it("lets several instances listen on one discovery port", async () => {
		const port = await freeUdpPort();
		const first = listener(port);
		const second = listener(port);
		expect(await first.start()).toBe(true);
		expect(await second.start()).toBe(true);
		// Unicast to a shared port reaches one of the bound sockets (broadcasts reach all).
		const received = Promise.race([nextBeacon(first), nextBeacon(second)]);
		await broadcaster(port, "host-2").start();
		expect((await received).deviceId).toBe("host-2");
	});

	it("skips the listening device's own beacon", async () => {
		const port = await freeUdpPort();
		const receiver = listener(port, "self");
		expect(await receiver.start()).toBe(true);
		const received = nextBeacon(receiver);
		await broadcaster(port, "self").start();
		await broadcaster(port, "other").start();
		expect((await received).deviceId).toBe("other");
	});

	it("includes the limited broadcast address in its targets", () => {
		expect(broadcastTargets()).toContain("255.255.255.255");
	});
});
