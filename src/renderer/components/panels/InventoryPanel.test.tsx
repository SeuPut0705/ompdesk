/**
 * Tests for the inventory window: closed-state rendering plus the pure
 * filter/sort and source-shortening contracts behind the list tabs.
 * (Open-state SSR assertions are not viable: react-dom/server renders
 * createPortal children as empty in this repo's test environment.)
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcMarketplaceInfo, RpcPluginInfo, RpcPromptTemplateInfo } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { resetTabRoute } from "../../lib/tab-routing";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { InventoryPanel, InventorySettingsPage } from "./InventoryPanel";
import { filterMarketplaces, filterPlugins, filterTemplates, shortenSource } from "./inventory-utils";

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

describe("InventoryPanel", () => {
	it("renders nothing while closed", () => {
		const html = renderToStaticMarkup(
			<I18nProvider>
				<InventoryPanel open={false} onClose={() => {}} />
			</I18nProvider>,
		);
		expect(html).toBe("");
	});

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
		await act(async () => {
			root?.render(
				<I18nProvider>
					<InventorySettingsPage query="" />
				</I18nProvider>,
			);
		});
		await flush();

		expect(getPlugins).toHaveBeenCalledTimes(1);
		expect(document.body.textContent).toContain("No plugins installed.");
		expect(document.body.textContent).toContain("Browse marketplaces");
	});
});
