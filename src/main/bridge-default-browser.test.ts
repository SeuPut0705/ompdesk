/**
 * gui-bridge default browser (modes/default-browser-core.ts): while the agents' browser is ego-browser every prompt
 * carries one static `<browser>` section; the built-in browser leaves the prompt stock, and `default_browser_set`
 * switches it without reinstalling.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	BROWSER_ENV,
	browserSection,
	type DefaultBrowserHost,
	install,
	setDefaultBrowser,
} from "../../resources/gui-bridge/modes/default-browser-core";
import { DEFAULT_BROWSER_ENV } from "../shared/default-browser";

type Handler = Parameters<DefaultBrowserHost["on"]>[1];

function installedHook(kind: string): (event: { systemPrompt: string[] }) => ReturnType<Handler> {
	const handlers: Handler[] = [];
	install({ on: (_event, handler) => handlers.push(handler) });
	expect(handlers).toHaveLength(1);
	return event => handlers[0]?.(event, { sessionManager: { getBranch: () => [] }, agent: { kind } });
}

afterEach(() => {
	setDefaultBrowser({ browser: "builtin" });
});

describe("gui-bridge default browser", () => {
	it("reads the same env name main sets", () => {
		expect(BROWSER_ENV).toBe(DEFAULT_BROWSER_ENV);
	});

	it("names ego-browser's CLI for ego, in the main agent and a subagent", () => {
		setDefaultBrowser({ browser: "ego" });
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

	it("adds nothing for the built-in browser", () => {
		expect(browserSection("builtin")).toBeUndefined();
		expect(installedHook("main")({ systemPrompt: ["base"] })).toBeUndefined();
	});

	it("follows default_browser_set on the next prompt without reinstalling", () => {
		const hook = installedHook("main");
		expect(hook({ systemPrompt: ["base"] })).toBeUndefined();
		expect(setDefaultBrowser({ browser: "ego" })).toEqual({ browser: "ego" });
		expect(hook({ systemPrompt: ["base"] })?.systemPrompt[1]).toContain("<browser>");
		setDefaultBrowser({ browser: "builtin" });
		expect(hook({ systemPrompt: ["base"] })).toBeUndefined();
	});

	it("keeps one copy and the same bytes across turns", () => {
		setDefaultBrowser({ browser: "ego" });
		const hook = installedHook("main");
		const first = hook({ systemPrompt: ["base"] })?.systemPrompt;
		expect(hook({ systemPrompt: first ?? [] })).toBeUndefined();
		expect(hook({ systemPrompt: ["base"] })?.systemPrompt).toEqual(first);
		expect(first?.filter(part => part.includes("<browser>"))).toHaveLength(1);
	});

	it("refuses a value that is not a browser", () => {
		expect(() => setDefaultBrowser({ browser: "chrome" })).toThrow("default_browser_set");
		expect(() => setDefaultBrowser(null)).toThrow("default_browser_set");
	});
});
