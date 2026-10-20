import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as GpuFallback from "./gpu-fallback";

// One fake Electron per test: a "launch" is a fresh import of gpu-fallback.ts over the same userData.
const electron = vi.hoisted(() => ({
	userData: "",
	switches: new Set<string>(),
	relaunches: 0,
	exits: 0,
	softwareCalls: 0,
	/** What `app.getGPUInfo("basic").gpuDevice` answers. */
	gpuDevices: [] as Array<Record<string, unknown>>,
}));

vi.mock("electron", () => ({
	app: {
		getPath: () => electron.userData,
		getVersion: () => "0.0.0-test",
		commandLine: { hasSwitch: (name: string) => electron.switches.has(name) },
		disableHardwareAcceleration: () => {
			electron.softwareCalls++;
		},
		relaunch: () => {
			electron.relaunches++;
		},
		exit: () => {
			electron.exits++;
		},
		getGPUInfo: async () => ({ gpuDevice: electron.gpuDevices }),
	},
}));

const crash = { type: "GPU", reason: "crashed", exitCode: -1073741819 };

/**
 * One launch as index.ts runs it: the launch guard, then the GPU fallback. A fresh module graph per launch, so
 * per-process state never carries over; a static import cannot stand in.
 */
async function launch(): Promise<typeof GpuFallback> {
	vi.resetModules();
	const guard = await import("./launch-guard");
	const gpu = await import("./gpu-fallback");
	const { safeMode } = guard.startLaunchGuard(join(electron.userData, "launch-history.json"));
	gpu.applyGpuFallbackIfNeeded(safeMode);
	return gpu;
}

beforeEach(() => {
	electron.userData = mkdtempSync(join(tmpdir(), "gpu-loop-"));
	electron.switches.clear();
	electron.relaunches = 0;
	electron.exits = 0;
	electron.softwareCalls = 0;
	electron.gpuDevices = [];
});

afterEach(() => {
	rmSync(electron.userData, { recursive: true, force: true });
});

describe("GPU crash relaunch", () => {
	it("never relaunches a launch that already renders in software (the marker's own launch)", async () => {
		// Windows still runs a GPU process for SwiftShader/WARP with hardware acceleration off; when that one
		// dies too, a relaunch from here starts the same software launch again: on, off, on, off.
		writeFileSync(
			join(electron.userData, "gpu-fallback.json"),
			JSON.stringify({ at: new Date().toISOString(), reason: "crashed", exitCode: -1 }),
		);
		const gpu = await launch();
		expect(electron.softwareCalls).toBe(1);
		gpu.handleGpuProcessGone(crash);
		expect(electron.relaunches).toBe(0);
		expect(electron.exits).toBe(0);
		const log = readFileSync(join(electron.userData, "logs", "gui-runtime.jsonl"), "utf8");
		expect(log).toContain("no relaunch");
	});

	it("never relaunches a launch started with --disable-gpu", async () => {
		electron.switches.add("disable-gpu");
		const gpu = await launch();
		gpu.handleGpuProcessGone(crash);
		expect(electron.relaunches).toBe(0);
		expect(electron.exits).toBe(0);
	});

	it("relaunches a hardware launch once into software, and that launch then stays up", async () => {
		const first = await launch();
		first.handleGpuProcessGone(crash);
		expect(electron.relaunches).toBe(1);
		expect(electron.exits).toBe(1);

		const second = await launch();
		expect(electron.softwareCalls).toBe(1);
		second.handleGpuProcessGone(crash);
		second.handleGpuProcessGone(crash);
		expect(electron.relaunches).toBe(1);
		expect(electron.exits).toBe(1);
	});

	it("relaunches at most once per 10 minutes, even when the user turns hardware acceleration back on", async () => {
		(await launch()).handleGpuProcessGone(crash);
		expect(electron.relaunches).toBe(1);

		// --enable-gpu clears the marker, so this launch is a hardware one again; its GPU process dies too.
		electron.switches.add("enable-gpu");
		const again = await launch();
		expect(electron.softwareCalls).toBe(0);
		again.handleGpuProcessGone(crash);
		expect(electron.relaunches).toBe(1);
		expect(electron.exits).toBe(1);
		// The marker is written, so the next plain launch renders in software.
		electron.switches.clear();
		await launch();
		expect(electron.softwareCalls).toBe(1);
	});

	it("never relaunches in safe mode, which renders in software whatever the switches say", async () => {
		electron.switches.add("enable-gpu");
		for (let i = 0; i < 3; i++) await launch(); // three launches that never became stable
		const safe = await launch();
		expect(electron.softwareCalls).toBe(1);
		safe.handleGpuProcessGone(crash);
		expect(electron.relaunches).toBe(0);
	});
});

// Intel iGPU of a laptop, before and after the user updates its driver. Chromium's basic info names the real
// adapter even in a software launch; the SwiftShader device (vendor 0xffff) is never an identity.
const iGpu = (driverVersion: string) => ({
	active: true,
	vendorId: 0x8086,
	deviceId: 0x9a49,
	driverVersion,
	driverDate: "2021-6-14",
});
const swiftShader = { active: false, vendorId: 0xffff, deviceId: 0xffff, driverVersion: "5.0.0" };

/** A launch that also reads the GPU once ready and outlives the crash-loop window, as index.ts does. */
async function launchWith(device: Record<string, unknown>): Promise<typeof GpuFallback> {
	electron.gpuDevices = [swiftShader, device];
	const gpu = await launch();
	await gpu.recordGpuIdentity();
	// Same module graph as the launch above (no reset in between).
	(await import("./launch-guard")).markLaunchStable();
	return gpu;
}

function readLog(): string {
	return readFileSync(join(electron.userData, "logs", "gui-runtime.jsonl"), "utf8");
}

describe("hardware acceleration comes back by itself", () => {
	it("stays in software while the driver that crashed is still installed", async () => {
		(await launchWith(iGpu("27.20.100.9466"))).handleGpuProcessGone(crash);
		expect(electron.relaunches).toBe(1);
		await launchWith(iGpu("27.20.100.9466"));
		await launchWith(iGpu("27.20.100.9466"));
		expect(electron.softwareCalls).toBe(2);
	});

	it("tries hardware once after the driver changed, and keeps it when that launch stays up", async () => {
		(await launchWith(iGpu("27.20.100.9466"))).handleGpuProcessGone(crash);
		// The software launch after the update sees the new driver.
		await launchWith(iGpu("31.0.101.5186"));
		expect(electron.softwareCalls).toBe(1);
		const trial = await launchWith(iGpu("31.0.101.5186"));
		expect(electron.softwareCalls).toBe(1);
		expect(readLog()).toContain("trying hardware acceleration again (driver-changed)");
		trial.confirmHardwareTrial();
		expect(readLog()).toContain("hardware acceleration works again");
		await launchWith(iGpu("31.0.101.5186"));
		expect(electron.softwareCalls).toBe(1);
	});

	it("tries hardware once only: a trial launch that ends without a verdict leaves the next one in software", async () => {
		(await launchWith(iGpu("27.20.100.9466"))).handleGpuProcessGone(crash);
		await launchWith(iGpu("31.0.101.5186"));
		await launchWith(iGpu("31.0.101.5186")); // the trial, closed before it proved anything
		await launchWith(iGpu("31.0.101.5186"));
		expect(electron.softwareCalls).toBe(2);
	});

	it("a crash in the trial goes back to software without a second relaunch inside the cap", async () => {
		(await launchWith(iGpu("27.20.100.9466"))).handleGpuProcessGone(crash);
		await launchWith(iGpu("31.0.101.5186"));
		const trial = await launchWith(iGpu("31.0.101.5186"));
		trial.handleGpuProcessGone(crash);
		expect(electron.relaunches).toBe(1);
		expect(electron.exits).toBe(1);
		// Back in software with the new driver recorded: the same driver does not try again.
		await launchWith(iGpu("31.0.101.5186"));
		await launchWith(iGpu("31.0.101.5186"));
		expect(electron.softwareCalls).toBe(3);
	});

	it("tries hardware once again after a 7-day cool-off", async () => {
		const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
		writeFileSync(
			join(electron.userData, "gpu-fallback.json"),
			JSON.stringify({ at: eightDaysAgo, reason: "crashed", exitCode: -1 }),
		);
		await launchWith(iGpu("27.20.100.9466"));
		expect(electron.softwareCalls).toBe(0);
		expect(readLog()).toContain("trying hardware acceleration again (cool-off)");
	});
});
