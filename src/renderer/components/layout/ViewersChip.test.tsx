/**
 * ViewersChip: "👁 N" for the other devices that show this tab too (multi-viewer). It reads the tab's
 * `viewerCount` from the tabs store, says nothing while the tab is only here, and names the count for
 * assistive technology (the visible badge is only the number).
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider, translate } from "../../lib/i18n";
import { SessionRuntimeProvider, setFocusedSessionRuntime } from "../../stores/session-runtime-context";
import { ensureTabRuntime } from "../../stores/tab-runtime";
import { type SessionTab, useTabsStore } from "../../stores/tabs";
import { ViewersChip } from "./ViewersChip";

const { document, window, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;

function seed(tabs: Array<Partial<SessionTab> & { id: string }>): void {
	useTabsStore.setState({
		tabs: tabs.map(tab => ({ kind: "agent", cwd: "/p", status: "ready", unreadDone: false, ...tab })),
		activeTabId: tabs[0]?.id ?? null,
	});
}

async function mount(tabId: string): Promise<Element> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	const runtime = ensureTabRuntime(tabId);
	setFocusedSessionRuntime(tabId);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<SessionRuntimeProvider runtime={runtime}>
					<ViewersChip />
				</SessionRuntimeProvider>
			</I18nProvider>,
		);
	});
	return container as unknown as Element;
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	useTabsStore.getState().reset();
});

describe("ViewersChip", () => {
	it("renders nothing while the tab is only on this device", async () => {
		seed([{ id: "t0" }]);
		const container = await mount("t0");
		expect(container.querySelector("[data-viewers-chip]")).toBeNull();
	});

	it("shows the count and names the one other device in the singular", async () => {
		seed([{ id: "t0", viewerCount: 1 }]);
		const chip = (await mount("t0")).querySelector("[data-viewers-chip]");
		expect(chip?.getAttribute("data-viewers-count")).toBe("1");
		expect(chip?.getAttribute("aria-label")).toBe(translate("viewers.chipOne"));
		expect(chip?.getAttribute("role")).toBe("status");
		expect(chip?.textContent).toContain("1");
	});

	it("names several other devices in the plural", async () => {
		seed([{ id: "t0", viewerCount: 3 }]);
		const chip = (await mount("t0")).querySelector("[data-viewers-chip]");
		expect(chip?.getAttribute("aria-label")).toBe(translate("viewers.chipMany", { count: 3 }));
		expect(chip?.textContent).toContain("3");
	});

	it("follows the tab list: a viewer joining and leaving", async () => {
		seed([{ id: "t0" }]);
		const container = await mount("t0");
		await act(async () => {
			useTabsStore.setState({ tabs: [{ ...useTabsStore.getState().tabs[0]!, viewerCount: 2 }] });
		});
		expect(container.querySelector("[data-viewers-chip]")?.getAttribute("data-viewers-count")).toBe("2");
		await act(async () => {
			const { viewerCount: _gone, ...rest } = useTabsStore.getState().tabs[0]!;
			useTabsStore.setState({ tabs: [rest] });
		});
		expect(container.querySelector("[data-viewers-chip]")).toBeNull();
	});

	it("counts only its own tab, not the tab in the next pane", async () => {
		seed([{ id: "t0" }, { id: "t1", viewerCount: 4 }]);
		const container = await mount("t0");
		expect(container.querySelector("[data-viewers-chip]")).toBeNull();
	});
});
