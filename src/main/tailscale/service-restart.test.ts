import { afterEach, describe, expect, it, vi } from "vitest";
import { stopCore } from "../core/process";
import { MOBILE_WEB_PREFS, MobileWebService } from "./service";
import { defaultTailscaleScenario, fakeTailscaleCli, USER_SERVE, USER_SERVE_HOST } from "./test-fake-tailscale";

vi.setConfig({ testTimeout: 60_000 });

const services: MobileWebService[] = [];
afterEach(() => {
	for (const service of services.splice(0)) service.dispose();
});

/** The state machine lives in the core process: one that ends takes it along, and main must put it back. */
describe("MobileWebService after the core process ended", () => {
	it("reads the switch from the prefs again, keeps polling, and still turns off cleanly", async () => {
		const scenario = defaultTailscaleScenario();
		const calls: string[][] = [];
		const located = fakeTailscaleCli(scenario, calls);
		const store = new Map<string, unknown>();
		const states: string[] = [];
		const service = new MobileWebService({
			platform: "darwin",
			prefs: {
				get: key => store.get(key),
				set: (key, value) => void store.set(key, value),
				delete: key => void store.delete(key),
			},
			server: { start: async () => ({ port: 51000 }), stop: async () => {}, configure: () => {} },
			serveSecret: () => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ",
			setup: { installForConnection: async () => Promise.reject(new Error("unused")), cancel: () => true },
			locate: async () => located(),
			startApp: async () => ({ code: 0, line: null }),
			openExternal: async () => {},
			openSystemSettings: async () => {},
			onState: state => states.push(state.phase),
		});
		services.push(service);
		await service.request({ action: "enable" });
		expect(service.state()).toMatchObject({ phase: "ready", published: true });
		const statuses = () => calls.filter(args => args[0] === "status").length;
		const before = statuses();

		// The core ends (a crash, or a stop): the next request starts a new one with no memory of this service.
		await stopCore();
		await vi.waitFor(() => expect(statuses()).toBeGreaterThan(before), { timeout: 30_000 });
		await vi.waitFor(() => expect(service.state()).toMatchObject({ phase: "ready", published: true }), {
			timeout: 30_000,
		});
		// The poll goes on in the new core, and its record of what it published is the prefs' (still there).
		const polled = statuses();
		await service.refresh();
		expect(statuses()).toBeGreaterThan(polled);

		const off = await service.request({ action: "disable" });
		expect(off).toMatchObject({ enabled: false, phase: "off", published: false });
		expect(scenario.serve.Web).toEqual(USER_SERVE.Web);
		expect(JSON.stringify(scenario.serve.Web?.[`${USER_SERVE_HOST}:443`])).toBe(
			JSON.stringify(USER_SERVE.Web?.[`${USER_SERVE_HOST}:443`]),
		);
		expect(store.has(MOBILE_WEB_PREFS.serve)).toBe(false);
		expect(store.get(MOBILE_WEB_PREFS.enabled)).toBe(false);
	});
});
