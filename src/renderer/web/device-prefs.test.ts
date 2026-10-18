import { describe, expect, it } from "vitest";
import { IPC_COMMANDS, IPC_EVENTS } from "../../shared/ipc-types";
import type { OmpTransport } from "../../shared/omp-api";
import { WEB_DEVICE_CHANNELS } from "../../shared/web-host";
import type { WebChrome } from "./chrome";
import { LocalChannels } from "./deep-link";
import { createWebOmp } from "./shim";

const C = IPC_COMMANDS;
const E = IPC_EVENTS;

/** A host with its own prefs and one device record, as `PREFS_*` and `web:device.uiPrefs.*` answer them. */
function rig(options: { host?: Record<string, unknown>; device?: Record<string, unknown> } = {}) {
	const host: Record<string, unknown> = { language: "ko", themeName: "light", ...options.host };
	const device: { prefs: Record<string, unknown>; failNext: boolean } = {
		prefs: { ...options.device },
		failNext: false,
	};
	const calls: { channel: string; args: unknown[] }[] = [];
	const pushed = new Map<string, Set<(data: unknown) => void>>();
	const transport: OmpTransport = {
		invoke: async <T>(channel: string, ...args: unknown[]) => {
			calls.push({ channel, args });
			if (channel === C.PREFS_GET) {
				const key = (args[0] as { key?: string } | undefined)?.key;
				return (key ? host[key] : { ...host }) as T;
			}
			if (channel === C.PREFS_SET) {
				const { key, value } = args[0] as { key: string; value: unknown };
				host[key] = value;
				return undefined as T;
			}
			if (channel === WEB_DEVICE_CHANNELS.UI_PREFS_GET) return { ...device.prefs } as T;
			if (channel === WEB_DEVICE_CHANNELS.UI_PREFS_SET) {
				if (device.failNext) {
					device.failNext = false;
					throw new Error("[invalid_content] Preferences are too large");
				}
				device.prefs = { ...(args[0] as Record<string, unknown>) };
				return true as T;
			}
			return undefined as T;
		},
		send: () => undefined,
		on: (channel, listener) => {
			const set = pushed.get(channel) ?? new Set();
			set.add(listener);
			pushed.set(channel, set);
			return () => set.delete(listener);
		},
	};
	const web = createWebOmp({
		transport,
		fetch: async () => new Response("{}"),
		chrome: {} as WebChrome,
		channels: new LocalChannels(),
		t: key => key,
		browser: { open: () => undefined, confirm: () => true, prompt: () => null },
		openTab: async () => null,
		takePendingSessionPath: () => null,
		notify: () => undefined,
		toastError: () => undefined,
		save: async () => "downloaded",
		pickFiles: async () => [],
	});
	const hostPush = (payload: unknown) => {
		for (const listener of pushed.get(E.PREFS_CHANGED) ?? []) listener(payload);
	};
	return { web, host, device, calls, hostPush };
}

const channelsCalled = (calls: { channel: string }[]) => calls.map(call => call.channel);

describe("a web page's device preferences", () => {
	it("writes a theme change to the device's record and never to the host's prefs", async () => {
		const { web, host, device, calls } = rig();
		await web.api.prefs.set("themeName", "dark");
		await web.api.prefs.set("theme", "dark");
		expect(device.prefs).toEqual({ themeName: "dark", theme: "dark" });
		expect(host.themeName).toBe("light");
		expect(host.theme).toBeUndefined();
		expect(channelsCalled(calls)).not.toContain(C.PREFS_SET);
	});

	it("sends a key that is not appearance to the host, and leaves the device's record alone", async () => {
		const { web, host, device, calls } = rig();
		await web.api.prefs.set("language", "en");
		expect(host.language).toBe("en");
		expect(device.prefs).toEqual({});
		expect(channelsCalled(calls)).not.toContain(WEB_DEVICE_CHANNELS.UI_PREFS_SET);
	});

	it("keeps the phone's theme when the computer's changes", async () => {
		const { web, host } = rig({ device: { themeName: "dark" } });
		host.themeName = "sepia";
		host.fontSize = 20;
		expect(await web.api.prefs.get("themeName")).toBe("dark");
		const all = (await web.api.prefs.get()) as Record<string, unknown>;
		expect(all).toMatchObject({ themeName: "dark", language: "ko" });
		expect(all.fontSize).toBeUndefined();
	});

	it("starts a phone with nothing set on none of the computer's appearance", async () => {
		const { web } = rig({ host: { themeName: "light", fontSize: 19, compactDensity: true } });
		expect(await web.api.prefs.get("themeName")).toBeUndefined();
		const all = (await web.api.prefs.get()) as Record<string, unknown>;
		expect(all).toEqual({ language: "ko" });
	});

	it("ignores the host's PREFS_CHANGED for device-local keys and passes the others", async () => {
		const { web, hostPush } = rig();
		const seen: string[] = [];
		web.api.prefs.onChanged(({ key }) => void seen.push(key));
		hostPush({ key: "themeName" });
		hostPush({ key: "displayPreferences.showTokenUsage" });
		hostPush({ key: "gui.panelWidth" });
		hostPush({ key: "language" });
		expect(seen).toEqual(["language"]);
	});

	it("keeps two quick writes and nests dotted keys when the whole store is read", async () => {
		const { web, device } = rig({ host: { gui: { other: 1 } } });
		await Promise.all([
			web.api.prefs.set("fontSize", 14),
			web.api.prefs.set("displayPreferences.showTokenUsage", true),
			web.api.prefs.set("gui.panelWidth", 320),
		]);
		expect(device.prefs).toEqual({
			fontSize: 14,
			"displayPreferences.showTokenUsage": true,
			"gui.panelWidth": 320,
		});
		expect(await web.api.prefs.get()).toMatchObject({
			fontSize: 14,
			displayPreferences: { showTokenUsage: true },
			gui: { other: 1, panelWidth: 320 },
		});
		expect(await web.api.prefs.get("displayPreferences")).toEqual({ showTokenUsage: true });
	});

	it("removes a key set to undefined and reads it back as unset", async () => {
		const { web, device } = rig({ device: { fontSize: 14, workBoard: false } });
		await web.api.prefs.set("fontSize", undefined);
		expect(device.prefs).toEqual({ workBoard: false });
		expect(await web.api.prefs.get("fontSize")).toBeUndefined();
	});

	it("rejects a write the host refused and keeps the copy it had", async () => {
		const { web, device } = rig({ device: { fontSize: 14 } });
		expect(await web.api.prefs.get("fontSize")).toBe(14);
		device.failNext = true;
		await expect(web.api.prefs.set("fontSize", 18)).rejects.toThrow("too large");
		expect(await web.api.prefs.get("fontSize")).toBe(14);
		await web.api.prefs.set("workBoard", false);
		expect(device.prefs).toEqual({ fontSize: 14, workBoard: false });
	});

	it("reads the record again at each whole-store read, so a reconnect shows what another visit saved", async () => {
		const { web, device } = rig({ device: { themeName: "dark" } });
		expect(await web.api.prefs.get("themeName")).toBe("dark");
		device.prefs = { themeName: "light" };
		expect(((await web.api.prefs.get()) as Record<string, unknown>).themeName).toBe("light");
		expect(await web.api.prefs.get("themeName")).toBe("light");
	});
});
