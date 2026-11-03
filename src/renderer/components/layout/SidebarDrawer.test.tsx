import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useUiStore } from "../../stores/ui";
import { SidebarDrawer } from "./SidebarDrawer";
import { loadSidebar } from "./sidebar-chunk";

// The list's chunk arrives when the test says so, as it does over a phone's link.
const chunk = vi.hoisted(() => Promise.withResolvers<void>());
vi.mock("./sidebar/Sidebar", async () => {
	await chunk.promise;
	return { Sidebar: () => <nav data-list="">Sessions</nav> };
});

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
Object.assign(window, { history: { pushState: () => {}, back: () => {} } });

let root: Root | undefined;

afterEach(async () => {
	await act(async () => root?.unmount());
	document.body.innerHTML = "";
	useUiStore.setState({ sidebarVisible: false });
});

it("opens only once the session list's chunk is here, with the list in it, never empty", async () => {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () => root?.render(<SidebarDrawer />));

	// ☰ tapped before the chunk came: nothing slides in yet.
	await act(async () => useUiStore.setState({ sidebarVisible: true }));
	const loading = loadSidebar();
	expect(document.querySelector("[data-drawer]")).toBeNull();

	await act(async () => {
		chunk.resolve();
		await loading;
	});
	expect(document.querySelector("[data-drawer] [data-list]")?.textContent).toBe("Sessions");
});
