import { describe, expect, it } from "vitest";
import {
	type AgentBrowserStatus,
	CHROMIUM_BROWSER_IDS,
	CHROMIUM_RELAY_PORTS,
	chromiumBrowserOf,
	type DefaultBrowserPref,
	parseDefaultBrowser,
	relayUrl,
	resolveAgentBrowser,
} from "./default-browser";

const chrome = (relayInstalled: boolean) => ({
	id: "chrome" as const,
	name: "Google Chrome",
	relayInstalled,
	relayConnected: false,
});
const brave = (relayInstalled: boolean) => ({
	id: "brave" as const,
	name: "Brave",
	relayInstalled,
	relayConnected: false,
});
const status = (egoInstalled: boolean, ...browsers: AgentBrowserStatus["browsers"]): AgentBrowserStatus => ({
	egoInstalled,
	browsers,
});
const CHROME_RELAY = { kind: "relay", name: "Google Chrome", url: "http://127.0.0.1:9231" };
const BRAVE_RELAY = { kind: "relay", name: "Brave", url: "http://127.0.0.1:9233" };

describe("default browser pref", () => {
	it("reads a missing or invalid pref as auto", () => {
		for (const value of [undefined, null, "", "chrome", "chromium:safari", "chromium:", 1, {}]) {
			expect(parseDefaultBrowser(value)).toBe("auto");
		}
		for (const value of ["auto", "ego", "builtin", "chromium:chrome", "chromium:arc"] as const) {
			expect(parseDefaultBrowser(value)).toBe(value);
		}
	});

	it("names the Chromium browser of a pick", () => {
		expect(chromiumBrowserOf("chromium:edge")).toBe("edge");
		expect(chromiumBrowserOf("auto")).toBeUndefined();
	});
});

describe("relay endpoints", () => {
	it("gives every browser its own port, none of them stock's shared default", () => {
		const ports = CHROMIUM_BROWSER_IDS.map(id => CHROMIUM_RELAY_PORTS[id]);
		expect(new Set(ports).size).toBe(CHROMIUM_BROWSER_IDS.length);
		expect(ports).not.toContain(9224);
		expect(relayUrl("edge")).toBe("http://127.0.0.1:9232");
	});
});

describe("resolveAgentBrowser", () => {
	it.each<[string, DefaultBrowserPref, AgentBrowserStatus, unknown]>([
		[
			"auto prefers ego-browser over a browser with its extension",
			"auto",
			status(true, chrome(true)),
			{ kind: "ego" },
		],
		[
			"auto without ego takes the first browser with its own extension, at its own port",
			"auto",
			status(false, chrome(false), brave(true)),
			BRAVE_RELAY,
		],
		[
			"auto keeps the detection order among browsers with their extension",
			"auto",
			status(false, chrome(true), brave(true)),
			CHROME_RELAY,
		],
		["auto with nothing usable is built-in", "auto", status(false, chrome(false)), { kind: "builtin" }],
		["auto on a bare machine is built-in", "auto", status(false), { kind: "builtin" }],
		["ego when installed", "ego", status(true), { kind: "ego" }],
		[
			"ego without ego-browser is built-in, never a missing binary",
			"ego",
			status(false, chrome(true)),
			{ kind: "builtin" },
		],
		[
			"a browser with its extension is driven through its own relay",
			"chromium:chrome",
			status(true, chrome(true)),
			CHROME_RELAY,
		],
		[
			"a browser without its extension is built-in",
			"chromium:chrome",
			status(true, chrome(false)),
			{ kind: "builtin" },
		],
		[
			"a pick is never another browser's relay",
			"chromium:chrome",
			status(false, chrome(false), brave(true)),
			{ kind: "builtin" },
		],
		["a browser that is gone is built-in", "chromium:brave", status(false, chrome(true)), { kind: "builtin" }],
		["built-in stays built-in whatever is installed", "builtin", status(true, chrome(true)), { kind: "builtin" }],
	])("%s", (_name, pref, machine, expected) => {
		expect(resolveAgentBrowser(pref, machine)).toEqual(expected);
	});
});
