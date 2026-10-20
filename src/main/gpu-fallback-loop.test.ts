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
	},
}));

const crash = { type: "GPU", reason: "crashed", exitCode: -1073741819 };

/** A fresh module per "launch": its per-process state must not carry over, so a static import cannot stand in. */
async function launch(): Promise<typeof GpuFallback> {
	vi.resetModules();
	const gpu = await import("./gpu-fallback");
	gpu.applyGpuFallbackIfNeeded();
	return gpu;
}

beforeEach(() => {
	electron.userData = mkdtempSync(join(tmpdir(), "gpu-loop-"));
	electron.switches.clear();
	electron.relaunches = 0;
	electron.exits = 0;
	electron.softwareCalls = 0;
});

afterEach(() => {
	rmSync(electron.userData, { recursive: true, force: true });
});

describe("GPU crash relaunch", () => {
	it("never relaunches a launch that already renders in software (the marker's own launch)", async () => {
		// Windows still runs a GPU process for SwiftShader/WARP with hardware acceleration off; when that one
		// dies too, a relaunch from here starts the same software launch again: on, off, on, off.
		writeFileSync(join(electron.userData, "gpu-fallback.json"), JSON.stringify({ reason: "crashed", exitCode: -1 }));
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
});
