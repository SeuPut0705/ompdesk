import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { useSidebarPrefs } from "../../stores/sidebar-prefs";
import { type SessionTab, useTabsStore } from "../../stores/tabs";
import { SplitPaneHeader } from "./SplitWorkspace";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let container: globalThis.HTMLElement;
const tab: SessionTab = {
	id: "pane",
	kind: "agent",
	cwd: "/Users/test/Desktop/GitHub/omgdesk",
	title: "메인",
	status: "ready",
	unreadDone: false,
};

async function mount() {
	container = document.createElement("div") as unknown as globalThis.HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<SplitPaneHeader tab={tab} label="메인" />
			</I18nProvider>,
		);
	});
}

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = undefined;
	container?.remove();
	useSidebarPrefs.setState({ groupAliases: {} });
	useTabsStore.getState().reset();
});

describe("split pane breadcrumb", () => {
	it("shows muted project, title and the title-bar separator with cwd only in a tooltip", async () => {
		await mount();
		const project = container.querySelector(`[title="${tab.cwd}"]`);
		expect(project?.textContent).toBe("omgdesk");
		expect(project?.className).toContain("text-(--sc-text-muted)");
		expect(container.querySelector(".omp-titlebar-crumb-sep")).not.toBeNull();
		expect(container.textContent).toContain("메인");
		expect(container.textContent).not.toContain(tab.cwd);
		expect(container.querySelector("button")).not.toBeNull();
	});

	it("uses the same project alias as the title bar", async () => {
		useSidebarPrefs.setState({ groupAliases: { [tab.cwd]: "My project" } });
		await mount();
		expect(container.querySelector(`[title="${tab.cwd}"]`)?.textContent).toBe("My project");
	});
});
