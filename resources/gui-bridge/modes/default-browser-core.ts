/**
 * Default browser (Settings › Agent behavior › Default browser; rules in src/shared/default-browser.ts): while the
 * agents' browser is ego-browser, every prompt carries one static section that points them at its CLI instead of
 * omp's built-in `browser` tool. Main resolves the setting against what is installed and passes `ego` or `builtin`
 * as `OMP_GUI_BROWSER` at spawn and through `default_browser_set` on change. No omp imports, so the GUI's vitest
 * runs it.
 */
import { type PromptSectionHost, registerPromptSection } from "../prompt-sections";

/** Env main sets at every spawn (src/shared/default-browser.ts `DEFAULT_BROWSER_ENV`; a test pins them equal). */
export const BROWSER_ENV = "OMP_GUI_BROWSER";

export type AgentBrowser = "ego" | "builtin";

const EGO_SECTION = `<browser>
ego-browser (ego lite) is this computer's browser for agents. For any task that needs a web browser (opening sites, signing in, forms, clicks, screenshots, page data, web app checks), run \`ego-browser skill\` once and follow its guide; drive pages with \`ego-browser nodejs\`. Do not use the built-in \`browser\` tool or Eval's \`browser\` object unless ego-browser fails or the user asks for it; say so when you fall back. A project's own test runners (Playwright and the like) stay as they are.
</browser>`;

/** The prompt section for `browser`; undefined for the built-in browser (stock omp's own prompt). */
export function browserSection(browser: AgentBrowser): string | undefined {
	return browser === "ego" ? EGO_SECTION : undefined;
}

function parseBrowser(value: unknown): AgentBrowser {
	return value === "ego" ? "ego" : "builtin";
}

let current: AgentBrowser = parseBrowser(process.env[BROWSER_ENV]);

/** The browser agents are pointed at right now. */
export function currentDefaultBrowser(): AgentBrowser {
	return current;
}

/** `{browser: "ego" | "builtin"}`; anything else is refused rather than silently switching the section off. */
export function setDefaultBrowser(params: unknown): { browser: AgentBrowser } {
	const value = typeof params === "object" && params !== null && "browser" in params ? params.browser : undefined;
	if (value !== "ego" && value !== "builtin")
		throw new Error('default_browser_set needs {browser: "ego" | "builtin"}');
	current = value;
	return { browser: current };
}

export type DefaultBrowserHost = PromptSectionHost;

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: DefaultBrowserHost): void {
	registerPromptSection(pi, "default-browser", () => browserSection(current));
}
