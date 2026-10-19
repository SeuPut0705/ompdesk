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

async function mount(shown: SessionTab = tab) {
	container = document.createElement("div") as unknown as globalThis.HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<SplitPaneHeader tab={shown} label="메인" />
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

describe("split pane header light", () => {
	const light = () => container.querySelector("header .omp-live-edge");

	it("lights a running session's header with the shared light, and no spinner", async () => {
		await mount({ ...tab, status: "running" });
		expect(light()?.getAttribute("data-live-edge")).toBe("turn");
		expect(light()?.hasAttribute("data-live-edge-inside")).toBe(true);
		expect(container.querySelector("[role='status']")).toBeNull();
		expect(container.querySelector("header")?.getAttribute("data-pane-running")).toBe("true");
	});

	it("leaves idle, waiting and failed headers unlit; starting keeps the spinner", async () => {
		for (const state of [
			{ ...tab, status: "ready" as const },
			{ ...tab, status: "running" as const, awaitingInput: "input" as const },
			{ ...tab, status: "error" as const },
		]) {
			await mount(state);
			expect(light()).toBeNull();
			await act(async () => root?.unmount());
			container.remove();
		}
		await mount({ ...tab, status: "starting" });
		expect(light()).toBeNull();
		expect(container.querySelector("[role='status']")).not.toBeNull();
	});
});
