import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobileWebState } from "../../shared/mobile-web";
import type { SetupItemState } from "../../shared/setup";
import type { ExecResult } from "./cli";
import type { LocatedTailscale } from "./locate";
import {
	BLOCK_RETRY_MS,
	FAST_POLL_MS,
	LOGIN_TIMEOUT_MS,
	MOBILE_WEB_PREFS,
	MobileWebService,
	OS_APPROVAL_AFTER_MS,
	POLL_MS,
	TAILSCALE_DOWNLOAD_URL,
} from "./service";
import {
	defaultTailscaleScenario,
	type FakeTailscaleScenario,
	fakeTailscaleExecutor,
	startFakeApp,
	USER_SERVE,
	USER_SERVE_HOST,
} from "./test-fake-tailscale";

const LOCAL_PORT = 51000;
const TARGET = `http://127.0.0.1:${LOCAL_PORT}`;
const SECRET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
/** What serve proxies to: the local address plus the secret path only serve's traffic carries. */
const FULL_TARGET = `${TARGET}/${SECRET}`;
const HOST = USER_SERVE_HOST;
const ok: ExecResult = { code: 0, stdout: "", stderr: "", timedOut: false, spawnError: null };

interface Options {
	scenario?: Partial<FakeTailscaleScenario>;
	prefs?: Record<string, unknown>;
	installed?: boolean;
	platform?: "darwin" | "win32" | "other";
}

/** A service over a fake Tailscale daemon (the scenario object), flat in-memory prefs and recording ports. */
function harness(options: Options = {}) {
	const scenario = defaultTailscaleScenario(options.scenario);
	const calls: string[][] = [];
	const exec = fakeTailscaleExecutor(scenario, calls);
	const store = new Map<string, unknown>(Object.entries(options.prefs ?? {}));
	const prefs = {
		get: (key: string) => store.get(key),
		set: (key: string, value: unknown) => void store.set(key, value),
		delete: (key: string) => void store.delete(key),
	};
	const server = {
		start: vi.fn(async () => ({ port: LOCAL_PORT })),
		stop: vi.fn(async () => {}),
		configure: vi.fn(),
	};
	let installed = options.installed ?? true;
	const located: LocatedTailscale = { path: "/fake/tailscale", variant: "mac-cli", app: null, env: {} };
	let setupItem: SetupItemState | null = null;
	const setup = {
		installForConnection: vi.fn(async () => {
			installed = true;
			return setupItem as SetupItemState;
		}),
		cancel: vi.fn(() => true),
	};
	const startApp = vi.fn(async () => {
		startFakeApp(scenario);
		return ok;
	});
	const openExternal = vi.fn(async (_url: string) => {});
	const openSystemSettings = vi.fn(async () => {});
	const states: MobileWebState[] = [];
	let now = 1_000_000;
	const service = new MobileWebService({
		platform: options.platform ?? "darwin",
		prefs,
		server,
		serveSecret: () => SECRET,
		setup,
		locate: async () => (installed ? located : null),
		exec,
		startApp,
		openExternal,
		openSystemSettings,
		onState: state => states.push(state),
		now: () => now,
	});
	return {
		service,
		scenario,
		calls,
		store,
		server,
		setup,
		startApp,
		openExternal,
		openSystemSettings,
		states,
		advance: (ms: number) => {
			now += ms;
		},
		install: (item: SetupItemState) => {
			setupItem = item;
		},
		setInstalled: (value: boolean) => {
			installed = value;
		},
		/** `enable`, then the state it settled in. */
		async enable() {
			await service.request({ action: "enable" });
			return service.state();
		},
		writes: () => calls.filter(args => args[0] === "serve" && args[1] !== "status"),
	};
}

const services: MobileWebService[] = [];
afterEach(() => {
	for (const service of services.splice(0)) service.dispose();
	vi.useRealTimers();
});
function track<T extends { service: MobileWebService }>(h: T): T {
	services.push(h.service);
	return h;
}

/** The user's own handlers, as `serve status --json` shows them (what must never change). */
const userServe = () => JSON.stringify(USER_SERVE.Web?.[`${HOST}:443`]);

function expectNoDangerousCalls(calls: string[][]) {
	for (const args of calls) {
		expect(args[0]).not.toBe("funnel");
		expect(args).not.toContain("reset");
		expect(args.some(arg => arg.includes("funnel"))).toBe(false);
	}
}

describe("MobileWebService publishing", () => {
	it("publishes on 47831 beside the user's 443 → 3010 and reports the address", async () => {
		const h = track(harness());
		const state = await h.enable();
		expect(state).toMatchObject({
			enabled: true,
			phase: "ready",
			url: `https://${HOST}:47831`,
			host: HOST,
			port: 47831,
			user: "seuput@example.com",
			allowedUsers: ["seuput@example.com"],
			published: true,
			funnelExposed: false,
			phones: ["iphone"],
			guideUrl: null,
			detail: null,
		});
		expect(h.writes()).toEqual([["serve", "--bg", "--https=47831", FULL_TARGET]]);
		// The prefs record names the local address only: the secret lives in its own 0600 file, never in the prefs.
		expect(h.store.get(MOBILE_WEB_PREFS.serve)).toEqual({ host: HOST, port: 47831, target: TARGET });
		expect(JSON.stringify([...h.store])).not.toContain(SECRET);
		expect(h.store.get(MOBILE_WEB_PREFS.enabled)).toBe(true);
		expect(h.store.get(MOBILE_WEB_PREFS.allowedUsers)).toEqual(["seuput@example.com"]);
		expect(h.server.configure).toHaveBeenCalledWith({
			host: HOST,
			publicPort: 47831,
			secure: true,
			servePrefix: SECRET,
		});
		expect(JSON.stringify(h.scenario.serve.Web?.[`${HOST}:443`])).toBe(userServe());
		expectNoDangerousCalls(h.calls);
	});

	it("moves to the next free port when another handler holds 47831, and leaves it alone", async () => {
		const foreign = { Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } } };
		const h = track(
			harness({
				scenario: {
					serve: {
						TCP: { "443": { HTTPS: true }, "47831": { HTTPS: true }, "47832": { TCPForward: "127.0.0.1:1" } },
						Web: {
							...USER_SERVE.Web,
							[`${HOST}:47831`]: foreign,
						},
					},
				},
			}),
		);
		const state = await h.enable();
		expect(state).toMatchObject({ phase: "ready", port: 47833, url: `https://${HOST}:47833` });
		expect(h.writes()).toEqual([["serve", "--bg", "--https=47833", FULL_TARGET]]);
		expect(h.scenario.serve.Web?.[`${HOST}:47831`]).toEqual(foreign);
		expect(h.store.get(MOBILE_WEB_PREFS.serve)).toEqual({ host: HOST, port: 47833, target: TARGET });
	});

	it("leaves our own handler in place when it is already there with the same target", async () => {
		const h = track(
			harness({
				prefs: { [MOBILE_WEB_PREFS.serve]: { host: HOST, port: 47832, target: TARGET } },
				scenario: {
					serve: {
						TCP: { "443": { HTTPS: true }, "47832": { HTTPS: true } },
						Web: { ...USER_SERVE.Web, [`${HOST}:47832`]: { Handlers: { "/": { Proxy: FULL_TARGET } } } },
					},
				},
			}),
		);
		const state = await h.enable();
		expect(state).toMatchObject({ phase: "ready", port: 47832, published: true });
		expect(h.writes()).toEqual([]);
	});

	it("republishes our own handler on the same port when the local port changed", async () => {
		const h = track(
			harness({
				prefs: { [MOBILE_WEB_PREFS.serve]: { host: HOST, port: 47831, target: "http://127.0.0.1:40000" } },
				scenario: {
					serve: {
						TCP: { "443": { HTTPS: true }, "47831": { HTTPS: true } },
						Web: {
							...USER_SERVE.Web,
							[`${HOST}:47831`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:40000" } } },
						},
					},
				},
			}),
		);
		expect(await h.enable()).toMatchObject({ phase: "ready", port: 47831 });
		expect(h.writes()).toEqual([["serve", "--bg", "--https=47831", FULL_TARGET]]);
		expect(h.store.get(MOBILE_WEB_PREFS.serve)).toEqual({ host: HOST, port: 47831, target: TARGET });
	});

	it("neither overwrites nor removes a user's handler on the same local address under another path", async () => {
		const theirs = { Handlers: { "/": { Proxy: `${TARGET}/other-app` } } };
		const scenario = {
			serve: {
				TCP: { "443": { HTTPS: true }, "47831": { HTTPS: true } },
				Web: { ...USER_SERVE.Web, [`${HOST}:47831`]: theirs },
			},
		};
		const h = track(
			harness({ prefs: { [MOBILE_WEB_PREFS.serve]: { host: HOST, port: 47831, target: TARGET } }, scenario }),
		);
		// Publishing takes the next free port; the user's handler on 47831 is exactly as it was.
		expect(await h.enable()).toMatchObject({ phase: "ready", port: 47832 });
		expect(h.writes()).toEqual([["serve", "--bg", "--https=47832", FULL_TARGET]]);
		expect(h.scenario.serve.Web?.[`${HOST}:47831`]).toEqual(theirs);
		// Turning off removes only the handler it made.
		await h.service.request({ action: "disable" });
		expect(h.scenario.serve.Web?.[`${HOST}:47831`]).toEqual(theirs);
		expect(h.writes().some(args => args.includes("--https=47831"))).toBe(false);

		// A stale record that points at the user's handler is dropped on turn-off, never acted on.
		const stale = track(
			harness({
				prefs: {
					[MOBILE_WEB_PREFS.enabled]: true,
					[MOBILE_WEB_PREFS.serve]: { host: HOST, port: 47831, target: TARGET },
				},
				scenario,
			}),
		);
		const state = await stale.service.request({ action: "disable" });
		expect(state.phase).toBe("off");
		expect(stale.writes()).toEqual([]);
		expect(stale.scenario.serve.Web?.[`${HOST}:47831`]).toEqual(theirs);
		expect(stale.store.has(MOBILE_WEB_PREFS.serve)).toBe(false);
	});
	it("publishes again over a handler an earlier OMPdesk made without the secret path, on the same port", async () => {
		const h = track(
			harness({
				prefs: { [MOBILE_WEB_PREFS.serve]: { host: HOST, port: 47832, target: TARGET } },
				scenario: {
					serve: {
						TCP: { "443": { HTTPS: true }, "47832": { HTTPS: true } },
						Web: { ...USER_SERVE.Web, [`${HOST}:47832`]: { Handlers: { "/": { Proxy: TARGET } } } },
					},
				},
			}),
		);
		expect(await h.enable()).toMatchObject({ phase: "ready", port: 47832, published: true });
		expect(h.writes()).toEqual([["serve", "--bg", "--https=47832", FULL_TARGET]]);
		expect(h.scenario.serve.Web?.[`${HOST}:47832`]).toEqual({ Handlers: { "/": { Proxy: FULL_TARGET } } });
		expect(JSON.stringify(h.scenario.serve.Web?.[`${HOST}:443`])).toBe(userServe());
	});

	it("refuses to start when Funnel exposes our port, and takes the server down", async () => {
		const h = track(
			harness({
				prefs: { [MOBILE_WEB_PREFS.serve]: { host: HOST, port: 47831, target: TARGET } },
				scenario: {
					serve: {
						TCP: { "443": { HTTPS: true }, "47831": { HTTPS: true } },
						Web: { ...USER_SERVE.Web, [`${HOST}:47831`]: { Handlers: { "/": { Proxy: TARGET } } } },
						AllowFunnel: { [`${HOST}:47831`]: true },
					},
				},
			}),
		);
		const state = await h.enable();
		expect(state).toMatchObject({ phase: "serve-blocked", funnelExposed: true, url: null, published: true });
		expect(state.detail).toContain("Funnel");
		expect(h.writes()).toEqual([]);
		expect(h.server.stop).toHaveBeenCalled();
		expectNoDangerousCalls(h.calls);

		// Retry takes our (own, exactly matching) handler down and puts it up private again.
		h.scenario.serve.AllowFunnel = { [`${HOST}:47831`]: true };
		const after = await h.service.request({ action: "retry" });
		expect(after).toMatchObject({ phase: "ready", funnelExposed: false, published: true });
		expect(h.writes()).toEqual([
			["serve", "--https=47831", "off"],
			["serve", "--bg", "--https=47831", FULL_TARGET],
		]);
		expect(h.scenario.serve.AllowFunnel?.[`${HOST}:47831`]).toBeUndefined();
		expect(JSON.stringify(h.scenario.serve.Web?.[`${HOST}:443`])).toBe(userServe());
		expectNoDangerousCalls(h.calls);
	});

	it("sees Funnel appear on a ready page and stops serving it", async () => {
		const h = track(harness());
		await h.enable();
		h.scenario.serve.AllowFunnel = { [`${HOST}:47831`]: true };
		await h.service.refresh();
		expect(h.service.state()).toMatchObject({ phase: "serve-blocked", funnelExposed: true, url: null });
		expect(h.server.stop).toHaveBeenCalled();
	});

	it("republishes when the handler disappears from a ready page", async () => {
		const h = track(harness());
		await h.enable();
		delete h.scenario.serve.TCP?.["47831"];
		delete h.scenario.serve.Web?.[`${HOST}:47831`];
		await h.service.refresh();
		expect(h.service.state()).toMatchObject({ phase: "ready", published: true });
		expect(h.writes()).toHaveLength(2);
	});
});

describe("MobileWebService turning off", () => {
	it("removes only our handler and leaves the user's 443 → 3010 byte-identical", async () => {
		const h = track(harness());
		await h.enable();
		const before = JSON.stringify(h.scenario.serve.Web?.[`${HOST}:443`]);
		const state = await h.service.request({ action: "disable" });
		expect(state).toMatchObject({ enabled: false, phase: "off", url: null, published: false, detail: null });
		expect(h.writes().at(-1)).toEqual(["serve", "--https=47831", "off"]);
		expect(h.scenario.serve.Web).toEqual(USER_SERVE.Web);
		expect(JSON.stringify(h.scenario.serve.Web?.[`${HOST}:443`])).toBe(before);
		expect(h.scenario.serve.TCP).toEqual(USER_SERVE.TCP);
		expect(h.store.has(MOBILE_WEB_PREFS.serve)).toBe(false);
		expect(h.store.get(MOBILE_WEB_PREFS.enabled)).toBe(false);
		expect(h.server.stop).toHaveBeenCalled();
		expectNoDangerousCalls(h.calls);
	});

	it("only drops the record when the handler is no longer exactly what it recorded", async () => {
		const other = { Handlers: { "/": { Proxy: "http://127.0.0.1:4242" } } };
		const h = track(
			harness({
				prefs: {
					[MOBILE_WEB_PREFS.enabled]: true,
					[MOBILE_WEB_PREFS.serve]: { host: HOST, port: 47831, target: TARGET },
				},
				scenario: {
					serve: {
						TCP: { "443": { HTTPS: true }, "47831": { HTTPS: true } },
						Web: { ...USER_SERVE.Web, [`${HOST}:47831`]: other },
					},
				},
			}),
		);
		await h.service.start();
		// Enabled at launch: the handler on 47831 is not ours, so a free port is used...
		expect(h.service.state()).toMatchObject({ phase: "ready", port: 47832 });
		const written = h.writes().length;
		// ...and the record now names 47832. Point it back at the foreign handler to test the turn-off rule.
		h.store.set(MOBILE_WEB_PREFS.serve, { host: HOST, port: 47831, target: TARGET });
		const snapshot = JSON.stringify(h.scenario.serve);
		const state = await h.service.request({ action: "disable" });
		expect(state.phase).toBe("off");
		expect(h.writes()).toHaveLength(written);
		expect(h.store.has(MOBILE_WEB_PREFS.serve)).toBe(false);
		expect(JSON.stringify(h.scenario.serve)).toBe(snapshot);
		expectNoDangerousCalls(h.calls);
	});

	it("only drops the record when the handler is gone", async () => {
		const h = track(harness({ prefs: { [MOBILE_WEB_PREFS.serve]: { host: HOST, port: 47831, target: TARGET } } }));
		const state = await h.service.request({ action: "disable" });
		expect(state.phase).toBe("off");
		expect(h.writes()).toEqual([]);
		expect(h.store.has(MOBILE_WEB_PREFS.serve)).toBe(false);
	});

	it("keeps the record and says why when the handler cannot be read or confirmed gone", async () => {
		const h = track(harness());
		await h.enable();
		h.scenario.daemon = "down";
		const state = await h.service.request({ action: "disable" });
		expect(state).toMatchObject({ phase: "off", enabled: false });
		expect(state.detail).toContain("failed to connect");
		expect(h.store.has(MOBILE_WEB_PREFS.serve)).toBe(true);
		expect(h.writes().filter(args => args.includes("off"))).toEqual([]);
	});

	it("leaves a handler the user added since, on another port, exactly as it is", async () => {
		const h = track(harness());
		await h.enable();
		const added = { Handlers: { "/": { Proxy: "http://127.0.0.1:1" } } };
		h.scenario.serve.Web = { ...h.scenario.serve.Web, [`${HOST}:8443`]: added };
		h.scenario.serve.TCP = { ...h.scenario.serve.TCP, "8443": { HTTPS: true } };
		const state = await h.service.request({ action: "disable" });
		expect(state.detail).toBeNull();
		expect(h.scenario.serve.Web?.[`${HOST}:8443`]).toEqual(added);
		expect(h.scenario.serve.Web?.[`${HOST}:47831`]).toBeUndefined();
	});
});

describe("MobileWebService phases", () => {
	it("walks a signed-out Tailscale through sign-in to ready", async () => {
		const h = track(harness({ scenario: { backendState: "NeedsLogin" } }));
		expect(await h.enable()).toMatchObject({
			phase: "needs-login",
			loginUrl: "https://login.tailscale.com/a/fake0123456789",
			url: null,
		});
		const asked = await h.service.request({ action: "login" });
		expect(asked).toMatchObject({ phase: "logging-in", loginUrl: "https://login.tailscale.com/a/fake0123456789" });
		expect(h.openExternal).toHaveBeenCalledWith("https://login.tailscale.com/a/fake0123456789");
		await h.service.refresh();
		expect(h.service.state().phase).toBe("logging-in");
		h.scenario.backendState = "Running";
		await h.service.refresh();
		expect(h.service.state()).toMatchObject({ phase: "ready", loginUrl: null });
		expectNoDangerousCalls(h.calls);
	});

	it("gives up waiting for the sign-in after ten minutes", async () => {
		const h = track(harness({ scenario: { backendState: "NeedsLogin" } }));
		await h.enable();
		await h.service.request({ action: "login" });
		h.advance(LOGIN_TIMEOUT_MS - 1);
		await h.service.refresh();
		expect(h.service.state().phase).toBe("logging-in");
		h.advance(2);
		await h.service.refresh();
		expect(h.service.state().phase).toBe("needs-login");
	});

	it("asks `up --json` for the sign-in link when status has none", async () => {
		const h = track(
			harness({ scenario: { backendState: "NeedsLogin", authUrl: "https://login.tailscale.com/a/up" } }),
		);
		await h.enable();
		// status shows AuthURL here, so blank it for the first look, as a daemon that has not started the flow does.
		const shown = h.scenario.authUrl;
		h.scenario.authUrl = null;
		await h.service.refresh();
		h.scenario.authUrl = shown;
		const state = await h.service.request({ action: "login" });
		expect(state.phase).toBe("logging-in");
		expect(h.openExternal).toHaveBeenCalledWith("https://login.tailscale.com/a/up");
	});

	it("never opens a sign-in link that is not on Tailscale's login host", async () => {
		const h = track(harness({ scenario: { backendState: "NeedsLogin", authUrl: "https://evil.example.com/a/x" } }));
		const state = await h.enable();
		expect(state).toMatchObject({ phase: "needs-login", loginUrl: null });
		const after = await h.service.request({ action: "login" });
		expect(h.openExternal).not.toHaveBeenCalled();
		expect(after.phase).toBe("needs-login");
		expect(after.detail).toContain("login host");
		// http is refused even on the right host.
		h.scenario.authUrl = "http://login.tailscale.com/a/x";
		await h.service.request({ action: "login" });
		expect(h.openExternal).not.toHaveBeenCalled();
	});

	it("opens a sign-in link on the control server of a self-hosted tailnet", async () => {
		const h = track(
			harness({
				scenario: {
					backendState: "NeedsLogin",
					authUrl: "https://headscale.example.org/register/abc",
					controlUrl: "https://headscale.example.org",
				},
			}),
		);
		await h.enable();
		await h.service.request({ action: "login" });
		expect(h.openExternal).toHaveBeenCalledWith("https://headscale.example.org/register/abc");
	});

	it("runs `up` once for a stopped Tailscale and goes on", async () => {
		const h = track(harness({ scenario: { backendState: "Stopped" } }));
		expect(await h.enable()).toMatchObject({ phase: "ready" });
		expect(h.calls.filter(args => args[0] === "up")).toEqual([["up"]]);
	});

	it("reports a stopped Tailscale that `up` could not start, and does not run `up` again on its own", async () => {
		const h = track(harness({ scenario: { backendState: "Stopped", upResult: "stay" } }));
		const state = await h.enable();
		expect(state).toMatchObject({ phase: "app-not-running", detail: "Tailscale is turned off" });
		await h.service.refresh();
		expect(h.calls.filter(args => args[0] === "up")).toHaveLength(1);
		// Start (explicitly) tries `up` again.
		await h.service.request({ action: "start-app" });
		expect(h.calls.filter(args => args[0] === "up")).toHaveLength(2);
		expect(h.startApp).not.toHaveBeenCalled();
	});

	it("waits for the app, starts it on request, and asks for OS approval when it never answers", async () => {
		const h = track(harness({ scenario: { daemon: "down" } }));
		const first = await h.enable();
		expect(first.phase).toBe("app-not-running");
		expect(first.detail).toContain("failed to connect");
		const started = await h.service.request({ action: "start-app" });
		expect(h.startApp).toHaveBeenCalledTimes(1);
		expect(started.phase).toBe("ready");
		expect(started.detail).toBeNull();

		// A second computer whose app never comes up: the OS holds it (system extension / VPN approval).
		const stuck = track(harness({ scenario: { daemon: "down" } }));
		stuck.startApp.mockImplementation(async () => ok);
		await stuck.enable();
		await stuck.service.request({ action: "start-app" });
		expect(stuck.service.state().phase).toBe("app-not-running");
		stuck.advance(OS_APPROVAL_AFTER_MS);
		await stuck.service.refresh();
		expect(stuck.service.state().phase).toBe("needs-os-approval");
		await stuck.service.request({ action: "open-system-settings" });
		expect(stuck.openSystemSettings).toHaveBeenCalledTimes(1);
		// ...and it carries on by itself once the OS lets it through.
		startFakeApp(stuck.scenario);
		await stuck.service.refresh();
		expect(stuck.service.state().phase).toBe("ready");
	});

	it("treats `Starting` that lasts as waiting on the OS", async () => {
		const h = track(harness({ scenario: { backendState: "Starting" } }));
		expect((await h.enable()).phase).toBe("detecting");
		h.advance(OS_APPROVAL_AFTER_MS);
		await h.service.refresh();
		expect(h.service.state().phase).toBe("needs-os-approval");
	});

	it("shows the admin approval a machine waits for", async () => {
		const h = track(harness({ scenario: { backendState: "NeedsMachineAuth" } }));
		expect(await h.enable()).toMatchObject({
			phase: "needs-machine-approval",
			guideUrl: "https://login.tailscale.com/admin/machines",
			user: "seuput@example.com",
		});
		h.scenario.backendState = "Running";
		await h.service.refresh();
		expect(h.service.state()).toMatchObject({ phase: "ready", guideUrl: null });
	});

	it("says HTTPS is off when the tailnet has no certificates, MagicDNS or https capability", async () => {
		for (const scenario of [
			{ httpsEnabled: false },
			{ magicDns: false },
			{ httpsCapability: false },
		] satisfies Partial<FakeTailscaleScenario>[]) {
			const h = track(harness({ scenario }));
			const state = await h.enable();
			expect(state).toMatchObject({
				phase: "https-disabled",
				guideUrl: "https://login.tailscale.com/admin/dns",
				url: null,
				published: false,
			});
			expect(state.detail).toBeTruthy();
			expect(h.writes()).toEqual([]);
			expect(h.server.start).not.toHaveBeenCalled();
		}
	});

	it("uses the link `tailscale serve` printed when it refuses for HTTPS, and continues once it is on", async () => {
		const guide = "https://login.tailscale.com/f/serve?node=n123";
		const h = track(
			harness({
				scenario: { serveError: `Serve is not enabled on your tailnet.\nTo enable, visit:\n\n\t${guide}\n` },
			}),
		);
		const state = await h.enable();
		expect(state).toMatchObject({ phase: "https-disabled", guideUrl: guide });
		expect(state.detail).toBe("Serve is not enabled on your tailnet.");
		// Within a minute nothing is tried again on its own...
		const attempts = h.writes().length;
		await h.service.refresh();
		expect(h.writes()).toHaveLength(attempts);
		// ...after the user fixed it, a retry publishes.
		h.scenario.serveError = null;
		expect(await h.service.request({ action: "retry" })).toMatchObject({ phase: "ready", guideUrl: null });
	});

	it("shows what `tailscale serve` said when it is blocked, and tries again at most once a minute", async () => {
		const h = track(harness({ scenario: { serveError: "serve is disabled by your organization's policy" } }));
		const state = await h.enable();
		expect(state).toMatchObject({
			phase: "serve-blocked",
			detail: "serve is disabled by your organization's policy",
			funnelExposed: false,
			published: false,
			guideUrl: null,
		});
		const attempts = h.writes().length;
		await h.service.refresh();
		expect(h.writes()).toHaveLength(attempts);
		h.advance(BLOCK_RETRY_MS);
		await h.service.refresh();
		expect(h.writes()).toHaveLength(attempts + 1);
	});

	it("blocks when Tailscale is in use by another user, and when it is too old", async () => {
		const other = track(harness({ scenario: { backendState: "InUseOtherUser" } }));
		expect(await other.enable()).toMatchObject({ phase: "serve-blocked" });
		const old = track(harness({ scenario: { version: "1.50.1" } }));
		const state = await old.enable();
		expect(state.phase).toBe("error");
		expect(state.detail).toContain("1.52");
	});

	it("regresses a ready page when Tailscale goes away, signs out or loses its machine approval", async () => {
		const h = track(harness());
		await h.enable();
		h.scenario.daemon = "down";
		await h.service.refresh();
		expect(h.service.state()).toMatchObject({ phase: "app-not-running", published: false, url: null });
		h.scenario.daemon = "up";
		h.scenario.backendState = "NeedsLogin";
		await h.service.refresh();
		expect(h.service.state()).toMatchObject({ phase: "needs-login", published: false });
		h.scenario.backendState = "Running";
		await h.service.refresh();
		expect(h.service.state()).toMatchObject({ phase: "ready", published: true });
	});

	it("starts the app on its own once Tailscale was installed by this service", async () => {
		const h = track(harness({ installed: false, scenario: { daemon: "down" } }));
		const state = await h.enable();
		expect(state).toMatchObject({
			phase: "not-installed",
			install: { progress: null, failure: null, manualUrl: TAILSCALE_DOWNLOAD_URL },
		});
		h.install(setupItem("present"));
		await h.service.request({ action: "install" });
		await vi.waitFor(() => expect(h.startApp).toHaveBeenCalledTimes(1));
		// The app is up by the next look.
		await h.service.refresh();
		expect(h.service.state().phase).toBe("ready");
		expect(h.setup.installForConnection).toHaveBeenCalledWith("tailscale");
		expect(h.startApp).toHaveBeenCalledTimes(1);
	});

	it("shows setup's progress while installing and its failure after", async () => {
		const h = track(harness({ installed: false }));
		await h.enable();
		const release = Promise.withResolvers<SetupItemState>();
		h.setup.installForConnection.mockReturnValueOnce(release.promise);
		const running = setupItem("running", {
			progress: { step: 1, steps: 1, startedAt: 5, download: { received: 10, total: 100 } },
		});
		await h.service.request({ action: "install" });
		h.service.onSetupState({
			platform: "darwin",
			automatic: true,
			ompReady: true,
			requiredRunning: false,
			items: [running],
		});
		expect(h.service.state()).toMatchObject({
			phase: "installing",
			install: { progress: { download: { received: 10, total: 100 } } },
		});
		await h.service.request({ action: "cancel-install" });
		expect(h.setup.cancel).toHaveBeenCalledTimes(1);
		const failed = setupItem("failed", { presence: { kind: "missing" }, failure: { reason: "checksum" } });
		h.setInstalled(false);
		h.service.onSetupState({
			platform: "darwin",
			automatic: true,
			ompReady: true,
			requiredRunning: false,
			items: [failed],
		});
		release.resolve(failed);
		await vi.waitFor(() => expect(h.service.state().phase).toBe("not-installed"));
		expect(h.service.state().install).toMatchObject({ failure: { reason: "checksum" }, progress: null });
	});
});

describe("MobileWebService allowed users and requests", () => {
	it("defaults to this computer's login, keeps a set list, and never empties it", async () => {
		const h = track(harness());
		await h.enable();
		const state = await h.service.request({
			action: "set-allowed-users",
			users: [" family@example.com ", "FAMILY@example.com", "", "seuput@example.com"],
		});
		expect(state.allowedUsers).toEqual(["family@example.com", "seuput@example.com"]);
		expect(h.service.allowedUsers()).toEqual(["family@example.com", "seuput@example.com"]);
		expect(h.store.get(MOBILE_WEB_PREFS.allowedUsers)).toEqual(["family@example.com", "seuput@example.com"]);
		const emptied = await h.service.request({ action: "set-allowed-users", users: [" "] });
		expect(emptied.allowedUsers).toEqual(["seuput@example.com"]);
		await h.service.refresh();
		expect(h.service.allowedUsers()).toEqual(["seuput@example.com"]);
	});

	it("refuses an empty list while this computer's login is unknown", async () => {
		const h = track(harness({ scenario: { backendState: "NeedsLogin" } }));
		await h.enable();
		await expect(h.service.request({ action: "set-allowed-users", users: [] })).rejects.toThrow("At least one");
		expect(h.service.allowedUsers()).toEqual([]);
	});

	it("rejects a request that is not one", async () => {
		const h = track(harness());
		for (const bad of [
			null,
			"enable",
			{ action: "format-disk" },
			{ action: "watch" },
			{ action: "set-allowed-users", users: [1] },
		]) {
			await expect(h.service.request(bad)).rejects.toThrow("Invalid Mobile web request");
		}
	});

	it("picks the switch up at launch, and stays off when it was off", async () => {
		const on = track(harness({ prefs: { [MOBILE_WEB_PREFS.enabled]: true } }));
		await on.service.start();
		expect(on.service.state()).toMatchObject({ enabled: true, phase: "ready" });
		const off = track(harness());
		await off.service.start();
		expect(off.service.state()).toMatchObject({ enabled: false, phase: "off" });
		expect(off.calls).toEqual([]);
	});

	it("is unavailable where Tailscale is not supported", async () => {
		const h = track(harness({ platform: "other" }));
		const state = await h.enable();
		expect(state).toMatchObject({ enabled: false, phase: "error" });
		expect(h.store.has(MOBILE_WEB_PREFS.enabled)).toBe(false);
		expect(h.calls).toEqual([]);
	});

	it("pushes the whole state on every change, and nothing twice", async () => {
		const h = track(harness());
		await h.enable();
		expect(h.states.at(-1)).toEqual(h.service.state());
		const count = h.states.length;
		await h.service.refresh();
		expect(h.states).toHaveLength(count);
		h.scenario.peers = [];
		await h.service.refresh();
		expect(h.states).toHaveLength(count + 1);
		expect(h.states.at(-1)?.phones).toEqual([]);
	});

	it("polls every 15 s, every 2 s while Settings watches, and stops on disable", async () => {
		vi.useFakeTimers();
		const h = track(harness());
		await h.enable();
		const statusCalls = () => h.calls.filter(args => args[0] === "status").length;
		const base = statusCalls();
		await vi.advanceTimersByTimeAsync(POLL_MS - 1);
		expect(statusCalls()).toBe(base);
		await vi.advanceTimersByTimeAsync(1);
		expect(statusCalls()).toBe(base + 1);
		await h.service.request({ action: "watch", on: true });
		const watched = statusCalls();
		await vi.advanceTimersByTimeAsync(FAST_POLL_MS * 3);
		expect(statusCalls()).toBeGreaterThanOrEqual(watched + 3);
		await h.service.request({ action: "watch", on: false });
		const slow = statusCalls();
		await vi.advanceTimersByTimeAsync(FAST_POLL_MS * 3);
		expect(statusCalls()).toBe(slow);
		await h.service.request({ action: "disable" });
		const off = statusCalls();
		await vi.advanceTimersByTimeAsync(POLL_MS * 2);
		expect(statusCalls()).toBe(off);
	});

	it("holds new devices for the desktop's approval only after the user turns that on, and says so in the state", async () => {
		const h = track(harness());
		expect(h.service.confirmNewDevices()).toBe(false);
		expect(h.service.state().confirmNewDevices).toBe(false);
		const on = await h.service.request({ action: "set-confirm-new-devices", on: true });
		expect(on.confirmNewDevices).toBe(true);
		expect(h.store.get(MOBILE_WEB_PREFS.confirmNewDevices)).toBe(true);
		expect(h.service.confirmNewDevices()).toBe(true);
		expect(h.states.at(-1)?.confirmNewDevices).toBe(true);
		const off = await h.service.request({ action: "set-confirm-new-devices", on: false });
		expect(off.confirmNewDevices).toBe(false);
		await expect(h.service.request({ action: "set-confirm-new-devices", on: "yes" })).rejects.toThrow();
	});

	it("asks `tailscale whois` for the node behind a tailnet address, read-only, and nothing for anything else", async () => {
		const h = track(harness());
		expect(await h.service.whois("100.64.0.9")).toBeNull();
		await h.enable();
		expect(await h.service.whois("100.64.0.9")).toEqual({
			nodeId: "nIPHONE1CNTRL",
			nodeName: "iphone",
			login: "seuput@example.com",
		});
		expect(h.calls.filter(args => args[0] === "whois")).toEqual([["whois", "--json", "100.64.0.9"]]);
		// An unknown address, and text that is no address (never passed to the CLI), answer null.
		expect(await h.service.whois("100.64.0.200")).toBeNull();
		expect(await h.service.whois("--help")).toBeNull();
		expect(await h.service.whois("not an address")).toBeNull();
		expect(h.calls.filter(args => args[0] === "whois")).toHaveLength(2);
		expectNoDangerousCalls(h.calls);
		await h.service.request({ action: "disable" });
		expect(await h.service.whois("100.64.0.9")).toBeNull();
	});
});

function setupItem(phase: SetupItemState["phase"], partial: Partial<SetupItemState> = {}): SetupItemState {
	return {
		id: "tailscale",
		required: false,
		phase,
		presence: { kind: "present", version: "1.104.1", path: "/Applications/Tailscale.app/Contents/MacOS/Tailscale" },
		method: null,
		command: null,
		location: null,
		prompt: null,
		progress: null,
		output: "",
		failure: null,
		manualCommands: [],
		manualUrl: TAILSCALE_DOWNLOAD_URL,
		...partial,
	};
}

describe("src/main/tailscale never resets serve or runs Funnel", () => {
	const dir = __dirname;
	const sources = readdirSync(dir).filter(
		name => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.startsWith("test-"),
	);

	it("has sources to check", () => {
		expect(sources).toEqual(expect.arrayContaining(["cli.ts", "locate.ts", "serve.ts", "service.ts", "status.ts"]));
	});

	it.each(sources)("%s has no `serve reset` and no funnel command", name => {
		const text = readFileSync(join(dir, name), "utf8");
		// A reset subcommand, as a word or an argument.
		expect(text).not.toMatch(/\bserve\s+reset\b/);
		expect(text).not.toMatch(/["'`]reset["'`]/);
		// A funnel subcommand or flag: an argument, or `tailscale funnel` as a command (prose says "Funnel").
		expect(text).not.toMatch(/["'`]funnel["'`]/);
		expect(text).not.toMatch(/\btailscale funnel\b/);
		expect(text).not.toMatch(/\bfunnel\s+--/);
	});
});
