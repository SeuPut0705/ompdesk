import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../lib/i18n";
import { useSessionStore } from "../../../stores/session";
import { useSidebarFolds } from "../../../stores/sidebar-folds";
import { useTabsStore } from "../../../stores/tabs";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

let reports: unknown[] = [];
Reflect.set(window, "omp", {
	rpc: {
		getUsage: vi.fn(async () => ({ type: "response", command: "get_usage", success: true, data: { reports } })),
	},
	prefs: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) },
});

const { createRoot } = await import("react-dom/client");
const { SidebarUsage, USAGE_LINE_CAP } = await import("./SidebarUsage");

let root: Root;
let container: HTMLElement;

const report = (provider: string) => ({
	provider,
	fetchedAt: Date.now(),
	account: `${provider}@example.com`,
	active: true,
	limits: [{ id: `${provider}:5h`, label: "5 hour", windowId: "5h", usedFraction: 0.3 }],
});

async function mount(providers: number): Promise<Element | null> {
	useSessionStore.setState({ status: "ready" });
	reports = Array.from({ length: providers }, (_, index) => report(`provider-${index}`));
	useTabsStore.setState({
		tabs: [{ id: "t1", cwd: "/w", status: "ready", kind: "agent", unreadDone: false }],
		activeTabId: "t1",
		bundles: new Map(),
	});
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () =>
		root.render(
			<I18nProvider>
				<SidebarUsage />
			</I18nProvider>,
		),
	);
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 20));
	});
	return container.querySelector(".omp-sidebar-usage");
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	useSidebarFolds.setState({ usageCollapsed: false });
	useSessionStore.getState().reset();
});

describe("SidebarUsage", () => {
	it("is not marked capped while it shows every provider, so the board can drop its own gauges", async () => {
		const block = await mount(USAGE_LINE_CAP);
		expect(block?.querySelectorAll(".omp-sidebar-usage-line")).toHaveLength(USAGE_LINE_CAP);
		expect(block?.hasAttribute("data-capped")).toBe(false);
	});

	it("marks itself capped past USAGE_LINE_CAP providers, where the board's gauges are the only place the rest show", async () => {
		const block = await mount(USAGE_LINE_CAP + 1);
		expect(block?.querySelectorAll(".omp-sidebar-usage-line")).toHaveLength(USAGE_LINE_CAP);
		expect(block?.hasAttribute("data-capped")).toBe(true);
	});
});
