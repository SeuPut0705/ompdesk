/**
 * Tests for Settings › Plugins & resources: the inline plugins tab's
 * auto-load + actionable empty state, plus the pure filter/sort and
 * source-shortening contracts behind the list tabs.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcMarketplaceInfo, RpcPluginInfo, RpcPromptTemplateInfo } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { resetTabRoute } from "../../lib/tab-routing";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { filterMarketplaces, filterPlugins, filterTemplates, shortenSource } from "../panels/inventory-utils";
import { MemoryReportSection, PluginsSection } from "./PluginsSection";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

interface TestElement {
	textContent: string | null;
	remove(): void;
	dispatchEvent(event: object): boolean;
}

let root: Root | null = null;
let container: TestElement | null = null;

async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	container?.remove();
	root = null;
	container = null;
	useSessionStore.getState().reset();
	useTabsStore.getState().reset();
	resetTabRoute();
	vi.restoreAllMocks();
});

function plugin(partial: Partial<RpcPluginInfo> & { name: string }): RpcPluginInfo {
	return { marketplace: "npm", enabled: true, version: "1.0.0", ...partial };
}

function marketplace(partial: Partial<RpcMarketplaceInfo> & { name: string }): RpcMarketplaceInfo {
	return { source: `https://github.com/omp/${partial.name}.git`, ...partial };
}

function template(partial: Partial<RpcPromptTemplateInfo> & { name: string }): RpcPromptTemplateInfo {
	return { description: "", source: "(user)", ...partial };
}

describe("shortenSource", () => {
	it("strips protocol and trailing .git from URLs", () => {
		expect(shortenSource("https://github.com/omp/plugins.git")).toBe("github.com/omp/plugins");
		expect(shortenSource("http://example.com/mkt/")).toBe("example.com/mkt");
	});

	it("strips the git@ ceremony from SSH remotes", () => {
		expect(shortenSource("git@github.com:omp/plugins.git")).toBe("github.com:omp/plugins");
	});

	it("keeps short names and paths intact", () => {
		expect(shortenSource("local-marketplace")).toBe("local-marketplace");
		expect(shortenSource("~/mkt")).toBe("~/mkt");
	});

	it("trims long filesystem paths to the last two segments", () => {
		expect(shortenSource("/Users/zach/dev/marketplaces/omp")).toBe("…/marketplaces/omp");
		expect(shortenSource("C:\\tools\\marketplaces\\omp")).toBe("…/marketplaces/omp");
	});
});

describe("filterPlugins", () => {
	const plugins = [
		plugin({ name: "zeta" }),
		plugin({ name: "alpha", marketplace: "internal", id: "alpha@internal", scope: "user" }),
		plugin({
			name: "beta",
			enabled: false,
			scope: "project",
			shadowedBy: "project",
			id: "beta@mkt",
			marketplace: "mkt",
		}),
	];

	it("sorts alphabetically and returns everything on an empty query", () => {
		expect(filterPlugins(plugins, "  ").map(p => p.name)).toEqual(["alpha", "beta", "zeta"]);
	});

	it("matches name, marketplace, and scope case-insensitively", () => {
		expect(filterPlugins(plugins, "ALP").map(p => p.name)).toEqual(["alpha"]);
		expect(filterPlugins(plugins, "internal").map(p => p.name)).toEqual(["alpha"]);
		expect(filterPlugins(plugins, "project").map(p => p.name)).toEqual(["beta"]);
	});

	it("matches by install id", () => {
		expect(filterPlugins(plugins, "beta@mkt").map(p => p.name)).toEqual(["beta"]);
	});

	it("returns nothing when nothing matches", () => {
		expect(filterPlugins(plugins, "nope")).toEqual([]);
	});
});

describe("filterMarketplaces", () => {
	const marketplaces = [
		marketplace({ name: "official", pluginCount: 12 }),
		marketplace({ name: "team", source: "/opt/omp/team-marketplace" }),
	];

	it("matches by name and by source, and keeps rows without a pluginCount", () => {
		expect(filterMarketplaces(marketplaces, "off").map(m => m.name)).toEqual(["official"]);
		expect(filterMarketplaces(marketplaces, "team-marketplace").map(m => m.name)).toEqual(["team"]);
	});

	it("returns all rows sorted on an empty query", () => {
		expect(filterMarketplaces(marketplaces, "").map(m => m.name)).toEqual(["official", "team"]);
	});
});

describe("filterTemplates", () => {
	const templates = [
		template({ name: "review", description: "Review a pull request", argumentHint: "[arguments]" }),
		template({ name: "commit", description: "Draft a commit message", source: "(project)" }),
	];

	it("matches description and source", () => {
		expect(filterTemplates(templates, "pull request").map(t => t.name)).toEqual(["review"]);
		expect(filterTemplates(templates, "project").map(t => t.name)).toEqual(["commit"]);
	});
});

describe("PluginsSection", () => {
	it("loads the active resource automatically and renders an actionable empty state", async () => {
		const getPlugins = vi.fn(async () => ({ success: true as const, data: { plugins: [] } }));
		const ompWindow = window as unknown as {
			omp: { rpc: { getPlugins: typeof getPlugins } };
		};
		ompWindow.omp = { rpc: { getPlugins } };
		useSessionStore.setState({ status: "ready", cwd: "/repo" });
		useTabsStore.setState({
			activeTabId: "tab-1",
			tabs: [{ id: "tab-1", cwd: "/repo", status: "ready", kind: "agent", unreadDone: false }],
			bundles: new Map(),
		});
		resetTabRoute();

		container = document.createElement("div") as unknown as TestElement;
		document.body.appendChild(container as never);
		root = createRoot(container as unknown as Element);
		const onTabChange = vi.fn();
		await act(async () => {
			root?.render(
				<I18nProvider>
					<PluginsSection onTabChange={onTabChange} query="" tab="plugins" />
				</I18nProvider>,
			);
		});
		await flush();

		expect(getPlugins).toHaveBeenCalledTimes(1);
		expect(document.body.textContent).toContain("No plugins installed.");
		const browse = (Array.from(document.querySelectorAll("button")) as unknown as TestElement[]).find(
			button => button.textContent?.trim() === "Browse marketplaces",
		);
		if (!browse) throw new Error("missing Browse marketplaces action");
		const click = new Event("click", { bubbles: true, cancelable: true });
		// linkedom's Event has a getter-only eventPhase React writes to.
		Object.defineProperty(click, "eventPhase", { value: 0, writable: true, configurable: true });
		await act(async () => {
			browse.dispatchEvent(click);
		});
		expect(onTabChange).toHaveBeenCalledWith("marketplaces");
	});

	it("names the memory backend and says a bare one has nothing to show in one quiet line", async () => {
		const getMemoryReport = vi.fn(async () => ({ success: true as const, data: { backend: "none", entryCount: 0 } }));
		(window as unknown as { omp: { rpc: { getMemoryReport: typeof getMemoryReport } } }).omp = {
			rpc: { getMemoryReport },
		};
		useSessionStore.setState({ status: "ready", cwd: "/repo" });
		useTabsStore.setState({
			activeTabId: "tab-1",
			tabs: [{ id: "tab-1", cwd: "/repo", status: "ready", kind: "agent", unreadDone: false }],
			bundles: new Map(),
		});
		resetTabRoute();
		container = document.createElement("div") as unknown as TestElement;
		document.body.appendChild(container as never);
		root = createRoot(container as unknown as Element);
		await act(async () => {
			root?.render(
				<I18nProvider>
					<MemoryReportSection />
				</I18nProvider>,
			);
		});
		await flush();

		const text = document.body.textContent ?? "";
		expect(text).toContain("Memory backend: none");
		expect(document.querySelector("[data-memory-bare]")?.textContent).toBe(
			"This backend exposes no status, stats, or diagnosis.",
		);
		// No promise of a future update in the UI.
		expect(text).not.toContain("future update");
	});
});
