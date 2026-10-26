/**
 * Default browser (Settings › Agent behavior › Default browser; rules in src/shared/default-browser.ts): main
 * resolves the setting against what is installed and passes the result (`./default-browser-contracts.ts`) as
 * `OMP_GUI_BROWSER` at spawn and through `default_browser_set` on change.
 *   ego      one static section pointing agents at ego-browser's CLI instead of omp's built-in `browser` tool.
 *   relay    stock's `browser.relay` and `browser.relayUrl` held as runtime overrides of the session's settings, so the
 *            built-in `browser` tool drives the user's own signed-in browser through the relay only that browser's
 *            extension dials, plus one static section naming it.
 *   builtin  nothing: stock omp.
 * No omp imports, so the GUI's vitest runs it.
 */
import { type PromptSectionHost, registerPromptSection } from "../prompt-sections";
import {
	type AgentBrowser,
	DEFAULT_BROWSER_ENV,
	parseAgentBrowser,
	parseAgentBrowserEnv,
} from "./default-browser-contracts";

const EGO_SECTION = `<browser>
ego-browser (ego lite) is this computer's browser for agents. For any task that needs a web browser (opening sites, signing in, forms, clicks, screenshots, page data, web app checks), run \`ego-browser skill\` once and follow its guide; drive pages with \`ego-browser nodejs\`. Do not use the built-in \`browser\` tool or Eval's \`browser\` object unless ego-browser fails or the user asks for it; say so when you fall back. A project's own test runners (Playwright and the like) stay as they are.
</browser>`;

function relaySection(name: string): string {
	return `<browser>
The built-in \`browser\` tool and Eval's \`browser\` object drive the user's own signed-in ${name} through the omp Browser Relay, so pages open with their logins. Open a tab of your own for a task; never navigate or close a tab the user opened unless asked. If the relay reports no connected extension, tell the user to open ${name}. A project's own test runners (Playwright and the like) stay as they are.
</browser>`;
}

/** The prompt section for `browser`; undefined for the built-in browser (stock omp's own prompt). */
export function browserSection(browser: AgentBrowser): string | undefined {
	if (browser.kind === "ego") return EGO_SECTION;
	return browser.kind === "relay" ? relaySection(browser.name) : undefined;
}

let current: AgentBrowser = parseAgentBrowserEnv(process.env[DEFAULT_BROWSER_ENV]);

/** The browser agents are pointed at right now. */
export function currentDefaultBrowser(): AgentBrowser {
	return current;
}

/** `{browser: AgentBrowser}`; anything else is refused rather than silently switching the section off. */
export function setDefaultBrowser(params: unknown): { browser: AgentBrowser } {
	const value = typeof params === "object" && params !== null && "browser" in params ? params.browser : undefined;
	const browser = parseAgentBrowser(value);
	if (!browser)
		throw new Error('default_browser_set needs {browser: {kind: "ego" | "builtin" | "relay", name?, url?}}');
	current = browser;
	return { browser };
}

/** The session settings the relay choice holds: `browser.relay` and `browser.relayUrl`, one scope at a time. */
export interface RelaySetting {
	hold(scope: object, url: string): void;
	release(scope: object): void;
}

/** Scopes where this choice holds the relay overrides now, with the endpoint held. */
const held = new Map<object, string>();
/** Scopes where Preview's agent browsing holds the same overrides: its pair wins while it runs. */
const previewing = new Set<object>();

/** Make `scope`'s relay overrides match the current choice. */
export function applyDefaultBrowser(scope: object, setting: RelaySetting): void {
	if (previewing.has(scope)) return;
	if (current.kind === "relay") {
		if (held.get(scope) === current.url) return;
		setting.hold(scope, current.url);
		held.set(scope, current.url);
	} else if (held.delete(scope)) {
		setting.release(scope);
	}
}

/** Preview's relay took `scope`'s `browser.relay`. */
export function previewRelayStarted(scope: object): void {
	previewing.add(scope);
}

/** Preview's relay stopped and cleared `scope`'s overrides: the default browser's choice comes back. */
export function previewRelayStopped(scope: object, setting: RelaySetting): void {
	previewing.delete(scope);
	held.delete(scope);
	applyDefaultBrowser(scope, setting);
}

export type DefaultBrowserHost = PromptSectionHost;

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: DefaultBrowserHost): void {
	registerPromptSection(pi, "default-browser", () => browserSection(current));
}
