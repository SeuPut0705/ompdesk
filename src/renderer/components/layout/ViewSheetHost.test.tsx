/**
 * The views the side panel no longer holds open as sheets on the tab that was focused when they opened: the same
 * components over that tab's runtime, so a paired host's tab reads its host exactly as the panel did. The side panel
 * keeps its four views and no View options list.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { RpcCommand, RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { setFocusedSessionRuntime } from "../../stores/session-runtime-context";
import { createTabRuntime } from "../../stores/tab-runtime";
import { useTabsStore } from "../../stores/tabs";
import { migrateDefaultPanelTab, PANEL_TABS, useUiStore } from "../../stores/ui";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
});
const events = new Proxy({}, { get: () => () => () => {} });
Reflect.set(window, "omp", {
	prefs: { get: async () => undefined, set: async () => {} },
	runtime: { logSnapshot: async () => [] },
	events,
});

const { createRoot } = await import("react-dom/client");
const { ViewSheetHost } = await import("./ViewSheetHost");
// The sheets' views load lazily; loaded once here, every mount resolves within a tick.
await import("./ViewSheets");

const sent: Record<string, string[]> = {};

function tab(id: string, device?: string) {
	const runtime = createTabRuntime(id);
	// The tab's own session store: its omp is ready, so the views load.
	runtime.stores.get("session")?.setState({ status: "ready", sessionId: `session-${id}` });
	sent[id] = [];
	runtime.command = async (command: RpcCommand): Promise<RpcResponse> => {
		sent[id]?.push(command.type);
		return { type: "response", command: command.type, success: true, data: { rows: [], nodes: [] } } as RpcResponse;
	};
	return {
		id,
		cwd: "/w",
		status: "ready" as const,
		kind: "agent" as const,
		unreadDone: false,
		...(device ? { device } : {}),
	};
}

let root: Root | undefined;
let container: HTMLElement;

async function settle(): Promise<void> {
	for (let index = 0; index < 6; index++)
		await act(async () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 0);
			await promise;
		});
}

async function mount(): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<ViewSheetHost />
			</I18nProvider>,
		);
	});
	await settle();
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	useUiStore.setState({ viewSheet: null, panelVisible: false, panelTab: "diff" });
	setFocusedSessionRuntime(null);
	useTabsStore.getState().reset();
});

describe("a view opened as a sheet", () => {
	for (const [name, device] of [
		["a local tab", undefined],
		["a paired host's tab", "host-1"],
	] as const)
		it(`reads the tab focused when it opened: ${name}`, async () => {
			useTabsStore.setState({ tabs: [tab("other"), tab("focused", device)], activeTabId: "focused" });
			setFocusedSessionRuntime("focused");
			await mount();
			await act(async () => useUiStore.getState().openViewSheet("tree"));
			await settle();
			expect(document.querySelector('[data-view-sheet="tree"]')).not.toBeNull();
			expect(sent.focused).toContain("get_session_tree");
			expect(sent.other).not.toContain("get_session_tree");
			// The tab it opened on stays its scope when the focus moves.
			await act(async () => {
				useTabsStore.setState({ activeTabId: "other" });
				setFocusedSessionRuntime("other");
			});
			await settle();
			expect(useUiStore.getState().viewSheet?.tabId).toBe("focused");
			expect(useUiStore.getState().panelVisible).toBe(false);
		});

	it("background tasks poll the focused tab's jobs, never another tab's", async () => {
		useTabsStore.setState({ tabs: [tab("other"), tab("focused", "host-1")], activeTabId: "focused" });
		setFocusedSessionRuntime("focused");
		await mount();
		await act(async () => useUiStore.getState().openViewSheet("jobs"));
		await settle();
		expect(document.querySelector('[data-view-sheet="jobs"]')).not.toBeNull();
		expect(sent.focused).toContain("get_jobs");
		expect(sent.other).not.toContain("get_jobs");
	});

	it("closes on its close button", async () => {
		useTabsStore.setState({ tabs: [tab("focused")], activeTabId: "focused" });
		setFocusedSessionRuntime("focused");
		await mount();
		await act(async () => useUiStore.getState().openViewSheet("logs"));
		await settle();
		const close = document.querySelector(
			`[aria-label="${translate("common.close")}"]`,
		) as unknown as HTMLButtonElement;
		await act(async () => close.click());
		expect(useUiStore.getState().viewSheet).toBeNull();
	});
});

describe("the side panel's views", () => {
	it("are the four primary ones; a stored or shortcut view the panel no longer holds falls back to Changes", () => {
		expect([...PANEL_TABS]).toEqual(["terminal", "diff", "preview", "files"]);
		for (const gone of ["jobs", "plan", "logs", "queue", "tree", "work", "memory"])
			expect(migrateDefaultPanelTab(gone)).toBe("diff");
	});
});
