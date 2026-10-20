/**
 * An Autopilot notice the host sends one device (`host.autopilotNotice`) reaches that device's listeners whatever tab
 * it has open: two RemoteDevices (host B, device A) over real sockets on 127.0.0.1 (test-devices.ts).
 */
import { afterEach, expect, it } from "vitest";
import { AUTOPILOT_NOTICE_EVENT, type AutopilotNoticeEvent } from "./app-protocol";
import type { HostConnection } from "./host-server";
import { DevicesRig } from "./test-devices";

const rig = new DevicesRig();

afterEach(() => rig.dispose());

it("hands the host's Autopilot notice to the device's listeners with the host's id, and drops a malformed one", async () => {
	const { a, b, hostId } = await rig.connected();
	const heard: Array<{ host: string; notice: AutopilotNoticeEvent }> = [];
	const { promise, resolve } = Promise.withResolvers<void>();
	a.devices.onAutopilotNotice((host, notice) => {
		heard.push({ host, notice });
		resolve();
	});
	// Any request of the device gives the host its connection.
	await a.devices.listDirs(hostId, "/", "").catch(() => undefined);
	const conn = b.services.call.mock.calls.at(-1)?.[3] as HostConnection | undefined;
	if (!conn) throw new Error("the device made no request");
	conn.emit(AUTOPILOT_NOTICE_EVENT, { kind: "error", title: 42 });
	const notice: AutopilotNoticeEvent = {
		kind: "error",
		title: "Autopilot paused",
		body: "The repository folder is gone.",
		sessionPath: "/s/run.jsonl",
	};
	conn.emit(AUTOPILOT_NOTICE_EVENT, notice);
	await promise;
	expect(heard).toEqual([{ host: hostId, notice }]);
});
