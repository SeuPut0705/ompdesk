import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { useTabHistoryStore } from "../../lib/tab-history";
import { useTabsStore } from "../../stores/tabs";
import { useUiStore } from "../../stores/ui";
import { TabSwitcher, useTabSwitcherStore } from "./TabSwitcher";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

let root: Root;
const originalSwitchTab = useTabsStore.getState().switchTab;
const switchTab = vi.fn(async (_tabId: string) => {});

beforeEach(async () => {
	// linkedom has no CSS.escape; useId's ids hold colons.
	vi.stubGlobal("CSS", { escape: (value: string) => value.replace(/[^\w-]/g, character => `\\${character}`) });
	useTabsStore.setState({
		tabs: [
			{ id: "a", cwd: "/a", status: "ready", kind: "agent", unreadDone: false },
			{ id: "b", cwd: "/b", status: "ready", kind: "agent", unreadDone: false },
			{ id: "c", cwd: "/c", status: "ready", kind: "agent", unreadDone: false },
		],
		activeTabId: "a",
		switchTab,
	});
	// Most recent first: a (current), then c, then b.
	useTabHistoryStore.setState({ mru: ["a", "c", "b"] });
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as globalThis.Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<TabSwitcher />
			</I18nProvider>,
		);
	});
});

afterEach(async () => {
	await act(async () => root.unmount());
	document.body.innerHTML = "";
	switchTab.mockClear();
	vi.unstubAllGlobals();
	useUiStore.setState({ tabSwitcherOpen: false });
	useTabSwitcherStore.setState({ step: 1 });
	useTabHistoryStore.setState({ mru: [] });
	useTabsStore.setState({ tabs: [], activeTabId: null, switchTab: originalSwitchTab });
});

/** linkedom has no KeyboardEvent: a plain event carrying the fields the switcher reads. */
const key = (type: "keydown" | "keyup", name: string) =>
	window.dispatchEvent(Object.assign(new Event(type), { key: name, shiftKey: false }));
const releaseControl = () => key("keyup", "Control");

describe("TabSwitcher", () => {
	it("a quick ⌃⇥ tap released before the overlay renders switches to the previous tab", () => {
		// No act(): ⌃ comes up before React commits the open overlay.
		useUiStore.setState({ tabSwitcherOpen: true });
		releaseControl();
		expect(switchTab).toHaveBeenCalledWith("c");
		expect(useUiStore.getState().tabSwitcherOpen).toBe(false);
	});

	it("a quick ⌃⇧⇥ tap switches to the oldest tab", () => {
		useTabSwitcherStore.setState({ step: -1 });
		useUiStore.setState({ tabSwitcherOpen: true });
		releaseControl();
		expect(switchTab).toHaveBeenCalledWith("b");
	});

	it("marks the opening's pick in its first frame and commits a moved pick on release", async () => {
		await act(async () => useUiStore.setState({ tabSwitcherOpen: true }));
		const selected = () =>
			document.querySelector('[role="option"][aria-selected="true"]')?.getAttribute("data-tab-id");
		expect(selected()).toBe("c");
		await act(async () => {
			key("keydown", "Tab");
		});
		expect(selected()).toBe("b");
		await act(async () => releaseControl());
		expect(switchTab).toHaveBeenCalledWith("b");
		// The next opening starts on its own pick again.
		await act(async () => useUiStore.setState({ tabSwitcherOpen: true }));
		expect(selected()).toBe("c");
	});
});
