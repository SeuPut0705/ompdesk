import { describe, expect, it, vi } from "vitest";
import { MAC_PERMISSIONS_REQUESTED_PREF, type MacPermissionDeps, MacPermissions } from "./mac-permissions";

const AGENT_DESKTOP = "/tools/agent-desktop/agent-desktop";

/** agent-desktop's `permissions` envelope (1.2.0). */
function envelope(accessibility: string, screen: string): string {
	return JSON.stringify({
		version: "2.6",
		ok: true,
		command: "permissions",
		data: {
			accessibility: { state: accessibility },
			automation: { state: "unknown" },
			screen_recording: { state: screen },
		},
	});
}

/** A Mac where the person may flip the switches between calls (`granted`), as in System Settings. */
function mac(overrides: Partial<MacPermissionDeps> = {}, stored: Record<string, unknown> = {}) {
	const data = { ...stored };
	const granted = { accessibility: true, screen: false };
	const runs: string[][] = [];
	const panes: string[] = [];
	const accessibilityTrusted = vi.fn((_prompt: boolean) => granted.accessibility);
	const deps: MacPermissionDeps = {
		platform: "darwin",
		prefs: {
			get: key => data[key],
			set: (key, value) => {
				data[key] = value;
			},
		},
		agentDesktop: async () => AGENT_DESKTOP,
		run: async (executable, args) => {
			runs.push([executable, ...args]);
			return envelope(granted.accessibility ? "granted" : "denied", granted.screen ? "granted" : "denied");
		},
		accessibilityTrusted,
		screenGranted: () => granted.screen,
		openPane: async url => {
			panes.push(url);
		},
		...overrides,
	};
	return { permissions: new MacPermissions(deps), data, granted, runs, panes, accessibilityTrusted };
}

describe("MacPermissions.status", () => {
	it("reads the engine's own view from a fresh agent-desktop, so a switch just turned on reads granted", async () => {
		const m = mac();
		expect(await m.permissions.status()).toEqual({ accessibility: true, screen: false });
		m.granted.screen = true;
		expect(await m.permissions.status()).toEqual({ accessibility: true, screen: true });
		expect(m.runs).toEqual([
			[AGENT_DESKTOP, "permissions"],
			[AGENT_DESKTOP, "permissions"],
		]);
	});

	it("falls back to Electron's reading without agent-desktop, or when its answer is no envelope", async () => {
		const missing = mac({ agentDesktop: async () => null, screenGranted: () => true });
		expect(await missing.permissions.status()).toEqual({ accessibility: true, screen: true });
		const garbled = mac({ run: async () => "not json", screenGranted: () => true });
		expect(await garbled.permissions.status()).toEqual({ accessibility: true, screen: true });
		const failing = mac({
			run: async () => {
				throw new Error("timed out");
			},
		});
		expect(await failing.permissions.status()).toEqual({ accessibility: true, screen: false });
	});

	it("is null on Windows, which has no such permissions", async () => {
		const m = mac({ platform: "win32" });
		expect(await m.permissions.status()).toBeNull();
		expect(await m.permissions.askMissing()).toEqual([]);
		expect(await m.permissions.request("screen")).toBeNull();
		expect(m.runs).toEqual([]);
	});
});

describe("MacPermissions.askMissing (launch)", () => {
	it("asks macOS for a missing permission through agent-desktop, once: a decline is not asked again", async () => {
		const m = mac();
		expect(await m.permissions.askMissing()).toEqual(["screen"]);
		expect(m.runs).toContainEqual([AGENT_DESKTOP, "permissions", "--request"]);
		expect(m.data[MAC_PERMISSIONS_REQUESTED_PREF]).toEqual(["screen"]);
		// The next launch: still declined, nothing asked, and no System Settings opened at launch.
		m.runs.length = 0;
		expect(await m.permissions.askMissing()).toEqual([]);
		expect(m.runs).toEqual([[AGENT_DESKTOP, "permissions"]]);
		expect(m.panes).toEqual([]);
	});

	it("asks Accessibility with Electron's prompting check, and nothing that is granted", async () => {
		const m = mac();
		m.granted.accessibility = false;
		m.granted.screen = true;
		expect(await m.permissions.askMissing()).toEqual(["accessibility"]);
		expect(m.accessibilityTrusted).toHaveBeenCalledWith(true);
		expect(m.runs).not.toContainEqual([AGENT_DESKTOP, "permissions", "--request"]);
	});

	it("leaves Screen Recording for a later launch while no agent-desktop can run (a dev run without the bundle)", async () => {
		let installed: string | null = null;
		const m = mac({ agentDesktop: async () => installed });
		expect(await m.permissions.askMissing()).toEqual([]);
		expect(m.data[MAC_PERMISSIONS_REQUESTED_PREF]).toBeUndefined();
		installed = AGENT_DESKTOP;
		expect(await m.permissions.askMissing()).toEqual(["screen"]);
	});
});

describe("MacPermissions.request (the person's button)", () => {
	it("asks again even after a decline, opens the pane with the switch and reads the state afresh", async () => {
		const m = mac({}, { [MAC_PERMISSIONS_REQUESTED_PREF]: ["screen"] });
		expect(await m.permissions.request("screen")).toEqual({ accessibility: true, screen: false });
		expect(m.runs).toEqual([
			[AGENT_DESKTOP, "permissions", "--request"],
			[AGENT_DESKTOP, "permissions"],
		]);
		expect(m.panes).toEqual(["x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"]);
	});

	it("still opens the pane when the request fails or agent-desktop is missing, and remembers the ask", async () => {
		const m = mac({ agentDesktop: async () => null });
		await m.permissions.request("screen");
		expect(m.panes).toHaveLength(1);
		expect(m.data[MAC_PERMISSIONS_REQUESTED_PREF]).toEqual(["screen"]);
		const a = mac();
		a.granted.accessibility = false;
		await a.permissions.request("accessibility");
		expect(a.accessibilityTrusted).toHaveBeenCalledWith(true);
		expect(a.panes).toEqual(["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"]);
	});
});
