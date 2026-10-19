/**
 * One name per device, renamable at any time from either side: two RemoteDevices (host B, device A) over real
 * sockets on 127.0.0.1, each with its own userData, prefs and fake Tailscale (test-devices.ts).
 */
import { afterEach, describe, expect, it } from "vitest";
import { ipcErrorCode } from "../../shared/ipc-error-codes";
import { DevicesRig, fakeTailnet, studioNode, until } from "./test-devices";

const rig = new DevicesRig();

afterEach(() => rig.dispose());

describe("device names", () => {
	it("renames the host from the device: the host's own name changes and both sides show it live", async () => {
		const { a, b, hostId } = await rig.connected();
		await a.devices.renameHost({ deviceId: hostId, name: "  Big desk  " });
		expect(b.prefs.get("remote.deviceName")).toBe("Big desk");
		expect(b.devices.state().host.name).toBe("Big desk");
		expect(a.devices.state().hosts[0]?.name).toBe("Big desk");
	});

	it("announces this computer's new name to a connected device and to the host it uses", async () => {
		const { a, b } = await rig.connected();
		b.devices.setDeviceName("Renamed host");
		await until(a, state => state.hosts[0]?.name === "Renamed host");
		a.devices.setDeviceName("Renamed laptop");
		await until(b, state => state.host.peers[0]?.name === "Renamed laptop");
	});

	it("asks a connected device to rename itself, and refuses while it is not connected", async () => {
		const { a, b } = await rig.connected();
		const peerId = b.devices.state().host.peers[0]?.deviceId ?? "";
		b.devices.renamePeer({ deviceId: peerId, name: "Kitchen laptop" });
		await until(a, state => state.host.name === "Kitchen laptop");
		await until(b, state => state.host.peers[0]?.name === "Kitchen laptop");

		await a.devices.dispose();
		await until(b, state => state.host.peers[0]?.online === false);
		let refused: unknown;
		try {
			b.devices.renamePeer({ deviceId: peerId, name: "Gone" });
		} catch (error) {
			refused = error;
		}
		expect(ipcErrorCode(refused)).toBe("remote_offline");
	});

	it("keeps a renamed host's name across the device's relaunch and refuses an empty name", async () => {
		const { a, hostId } = await rig.connected();
		await a.devices.renameHost({ deviceId: hostId, name: "Big desk" });
		await expect(a.devices.renameHost({ deviceId: hostId, name: "   " })).rejects.toMatchObject({});
		await a.devices.dispose();
		const again = await rig.computer("Laptop", fakeTailnet({ peers: [studioNode()] }), {
			userData: a.userData,
			prefs: a.prefs,
		});
		expect(again.devices.state().hosts[0]?.name).toBe("Big desk");
	});
});
