import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteDevices } from "./devices";
import type { LocalHostServices } from "./host-services";

let userData: string;
let devices: RemoteDevices | undefined;

beforeEach(async () => {
	userData = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-devices-"));
});

afterEach(async () => {
	await devices?.dispose();
	devices = undefined;
	await fs.rm(userData, { recursive: true, force: true });
});

/** The slice of LocalHostServices the constructor, dispose and the host-setting fan-outs touch. */
function fakeServices() {
	return {
		onRunningChange: vi.fn(() => () => {}),
		attachQuota: vi.fn(),
		disposeAll: vi.fn(),
		syncNextPrompt: vi.fn(),
		syncAutoTitle: vi.fn(),
	};
}

describe("RemoteDevices host settings", () => {
	it("pushes this machine's prompt-suggestion switches to the tabs it hosts for paired devices", () => {
		const services = fakeServices();
		devices = new RemoteDevices({
			userData,
			appVersion: "1.0.0",
			prefs: { get: () => undefined, set: () => {} },
			broadcast: () => {},
			services: services as unknown as LocalHostServices,
			machineInfo: () => ({ platform: "darwin", ompVersion: "18.8.0", home: "/home/u", sep: "/" }),
			offlineMessage: () => "offline",
			stalledMessage: device => `${device} stalled`,
			powerSaveBlocker: { start: () => 1, stop: () => {} },
		});
		devices.hostNextPromptChanged();
		expect(services.syncNextPrompt).toHaveBeenCalledTimes(1);
	});
});

describe("RemoteDevices auto-title setting", () => {
	it("pushes this machine's automatic-title switches to the tabs it hosts for paired devices", () => {
		const services = fakeServices();
		devices = new RemoteDevices({
			userData,
			appVersion: "1.0.0",
			prefs: { get: () => undefined, set: () => {} },
			broadcast: () => {},
			services: services as unknown as LocalHostServices,
			machineInfo: () => ({ platform: "darwin", ompVersion: "18.8.0", home: "/home/u", sep: "/" }),
			offlineMessage: () => "offline",
			stalledMessage: device => `${device} stalled`,
			powerSaveBlocker: { start: () => 1, stop: () => {} },
		});
		devices.hostAutoTitleChanged();
		expect(services.syncAutoTitle).toHaveBeenCalledTimes(1);
	});
});
