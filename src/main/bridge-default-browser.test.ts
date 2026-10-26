/**
 * gui-bridge default browser (modes/default-browser-core.ts): ego-browser and the user's own browser each get one
 * static `<browser>` section, the built-in browser leaves the prompt stock, and `default_browser_set` switches it
 * without reinstalling. A relay choice holds `browser.relay` and `browser.relayUrl` (the endpoint only that browser's
 * extension dials) as session overrides; Preview's agent browsing wins while it runs and the choice comes back when
 * it stops.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	type AgentBrowser,
	agentBrowserEnv,
	parseAgentBrowserEnv,
} from "../../resources/gui-bridge/modes/default-browser-contracts";
import {
	applyDefaultBrowser,
	browserSection,
	type DefaultBrowserHost,
	install,
	previewRelayStarted,
	previewRelayStopped,
	type RelaySetting,
	setDefaultBrowser,
} from "../../resources/gui-bridge/modes/default-browser-core";

type Handler = Parameters<DefaultBrowserHost["on"]>[1];
type Turn = ReturnType<Handler>;

const EGO: AgentBrowser = { kind: "ego" };
const CHROME: AgentBrowser = { kind: "relay", name: "Google Chrome", url: "http://127.0.0.1:9231" };
const EDGE: AgentBrowser = { kind: "relay", name: "Microsoft Edge", url: "http://127.0.0.1:9232" };
const BUILTIN: AgentBrowser = { kind: "builtin" };

function installedHook(kind: string): (event: { systemPrompt: string[] }) => Turn {
	const handlers: Handler[] = [];
	install({ on: (_event, handler) => handlers.push(handler) });
	expect(handlers).toHaveLength(1);
	return event => handlers[0]?.(event, { sessionManager: { getBranch: () => [] }, agent: { kind } });
}

interface Overrides {
	relay: boolean;
	relayUrl: string;
}

/** The session settings as the bridge's two overrides leave them: scope → what `browser.relay`/`browser.relayUrl` hold. */
function fakeSettings() {
	const overrides = new Map<object, Overrides>();
	const writes: string[] = [];
	const setting: RelaySetting = {
		hold: (scope, url) => {
			overrides.set(scope, { relay: true, relayUrl: url });
			writes.push(`hold ${url}`);
		},
		release: scope => {
			overrides.delete(scope);
			writes.push("release");
		},
	};
	return { overrides, setting, writes };
}

afterEach(() => {
	setDefaultBrowser({ browser: BUILTIN });
});

describe("gui-bridge default browser section", () => {
	it("names ego-browser's CLI for ego, in the main agent and a subagent", () => {
		setDefaultBrowser({ browser: EGO });
		for (const kind of ["main", "sub"]) {
			const result = installedHook(kind)({ systemPrompt: ["base"] });
			expect(result?.systemPrompt[0]).toBe("base");
			expect(result?.systemPrompt).toHaveLength(2);
			const section = result?.systemPrompt[1] ?? "";
			expect(section).toContain("<browser>");
			expect(section).toContain("`ego-browser skill`");
			expect(section).toContain("`ego-browser nodejs`");
		}
	});

	it("names the user's own browser for a relay choice, and says what to do without the extension", () => {
		setDefaultBrowser({ browser: CHROME });
		const section = installedHook("main")({ systemPrompt: ["base"] })?.systemPrompt[1] ?? "";
		expect(section).toContain("<browser>");
		expect(section).toContain("signed-in Google Chrome");
		expect(section).toContain("never navigate or close a tab the user opened unless asked");
		expect(section).toContain("tell the user to open Google Chrome");
		expect(section).not.toContain("ego-browser");
	});

	it("adds nothing for the built-in browser", () => {
		expect(browserSection(BUILTIN)).toBeUndefined();
		expect(installedHook("main")({ systemPrompt: ["base"] })).toBeUndefined();
	});

	it("follows default_browser_set on the next prompt without reinstalling", () => {
		const hook = installedHook("main");
		expect(hook({ systemPrompt: ["base"] })).toBeUndefined();
		expect(setDefaultBrowser({ browser: EGO })).toEqual({ browser: EGO });
		expect(hook({ systemPrompt: ["base"] })?.systemPrompt[1]).toContain("ego-browser");
		setDefaultBrowser({ browser: CHROME });
		expect(hook({ systemPrompt: ["base"] })?.systemPrompt[1]).toContain("Google Chrome");
		setDefaultBrowser({ browser: BUILTIN });
		expect(hook({ systemPrompt: ["base"] })).toBeUndefined();
	});

	it("keeps one copy and the same bytes across turns", () => {
		setDefaultBrowser({ browser: CHROME });
		const hook = installedHook("main");
		const first = hook({ systemPrompt: ["base"] })?.systemPrompt;
		expect(hook({ systemPrompt: first ?? [] })).toBeUndefined();
		expect(hook({ systemPrompt: ["base"] })?.systemPrompt).toEqual(first);
		expect(first?.filter(part => part.includes("<browser>"))).toHaveLength(1);
	});

	it("refuses a value that is not a browser, or a relay at an endpoint that is not loopback", () => {
		for (const bad of [
			{ browser: "ego" },
			{ browser: { kind: "chrome" } },
			{ browser: { kind: "relay", name: "Chrome" } },
			{ browser: { kind: "relay", name: "a\nb", url: "http://127.0.0.1:9231" } },
			{ browser: { kind: "relay", name: "Chrome", url: "http://evil.example:9231" } },
			{ browser: { kind: "relay", name: "Chrome", url: "http://127.0.0.1:9231/x" } },
			null,
		]) {
			expect(() => setDefaultBrowser(bad)).toThrow("default_browser_set");
		}
	});
});

describe("gui-bridge default browser env", () => {
	it("round-trips every choice through the env value and reads anything else as built-in", () => {
		for (const browser of [EGO, CHROME, EDGE, BUILTIN]) {
			expect(parseAgentBrowserEnv(agentBrowserEnv(browser))).toEqual(browser);
		}
		expect(agentBrowserEnv(CHROME)).toBe("relay:Google Chrome@http://127.0.0.1:9231");
		for (const bad of [
			undefined,
			"",
			"chrome",
			"relay:",
			"relay:   ",
			"relay:Google Chrome",
			"relay:Google Chrome@",
			"relay:Google Chrome@http://evil.example:9231",
			"relay:@http://127.0.0.1:9231",
			`relay:${"x".repeat(65)}@http://127.0.0.1:9231`,
		]) {
			expect(parseAgentBrowserEnv(bad)).toEqual(BUILTIN);
		}
	});
});

describe("gui-bridge default browser relay override", () => {
	it("holds browser.relay and browser.relayUrl while the choice is relay and releases both on switching away", () => {
		const { overrides, setting } = fakeSettings();
		const scope = {};
		setDefaultBrowser({ browser: CHROME });
		applyDefaultBrowser(scope, setting);
		expect(overrides.get(scope)).toEqual({ relay: true, relayUrl: "http://127.0.0.1:9231" });
		setDefaultBrowser({ browser: EGO });
		applyDefaultBrowser(scope, setting);
		expect(overrides.has(scope)).toBe(false);
		setDefaultBrowser({ browser: CHROME });
		applyDefaultBrowser(scope, setting);
		setDefaultBrowser({ browser: BUILTIN });
		applyDefaultBrowser(scope, setting);
		expect(overrides.size).toBe(0);
	});

	it("moves to the other browser's endpoint when the pick changes between browsers", () => {
		const { overrides, setting } = fakeSettings();
		const scope = {};
		setDefaultBrowser({ browser: CHROME });
		applyDefaultBrowser(scope, setting);
		setDefaultBrowser({ browser: EDGE });
		applyDefaultBrowser(scope, setting);
		expect(overrides.get(scope)?.relayUrl).toBe("http://127.0.0.1:9232");
	});

	it("never touches the settings for ego or built-in, so a user's own browser.relay stays", () => {
		const { writes, setting } = fakeSettings();
		for (const browser of [EGO, BUILTIN]) {
			setDefaultBrowser({ browser });
			applyDefaultBrowser({}, setting);
		}
		expect(writes).toEqual([]);
	});

	it("writes the overrides once however often the same choice is applied", () => {
		const { writes, setting } = fakeSettings();
		const scope = {};
		setDefaultBrowser({ browser: CHROME });
		applyDefaultBrowser(scope, setting);
		applyDefaultBrowser(scope, setting);
		expect(writes).toEqual(["hold http://127.0.0.1:9231"]);
	});

	it("leaves both overrides to Preview while it runs and holds the choice's again when Preview stops", () => {
		const { overrides, setting } = fakeSettings();
		const scope = {};
		setDefaultBrowser({ browser: CHROME });
		applyDefaultBrowser(scope, setting);
		previewRelayStarted(scope);
		// Preview's own pair replaces the choice's; a switch meanwhile must not clear it.
		overrides.set(scope, { relay: true, relayUrl: "http://127.0.0.1:50321" });
		setDefaultBrowser({ browser: BUILTIN });
		applyDefaultBrowser(scope, setting);
		expect(overrides.get(scope)?.relayUrl).toBe("http://127.0.0.1:50321");
		// Preview's stop cleared both (browser-relay.ts); the choice is now built-in, so they stay cleared.
		overrides.delete(scope);
		previewRelayStopped(scope, setting);
		expect(overrides.has(scope)).toBe(false);

		setDefaultBrowser({ browser: CHROME });
		applyDefaultBrowser(scope, setting);
		previewRelayStarted(scope);
		overrides.set(scope, { relay: true, relayUrl: "http://127.0.0.1:50322" });
		overrides.delete(scope);
		previewRelayStopped(scope, setting);
		expect(overrides.get(scope)).toEqual({ relay: true, relayUrl: "http://127.0.0.1:9231" });
	});
});
