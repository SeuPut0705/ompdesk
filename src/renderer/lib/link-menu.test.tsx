/**
 * The link menu: web links open in Preview or the browser, local paths open,
 * open natively, reveal or copy — the native pair only for this machine's
 * tabs — and a chosen item never reaches the link's ancestors.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTabsStore } from "../stores/tabs";
import { useUiStore } from "../stores/ui";
import { I18nProvider } from "./i18n";
import { type LinkMenuTarget, useLinkMenu } from "./link-menu";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

const system = {
	openExternal: vi.fn(async () => {}),
	openPath: vi.fn(async () => ({ ok: true })),
	revealPath: vi.fn(async () => ({ ok: true })),
};
let container: HTMLElement;
let root: Root;
const parentClick = vi.fn();

function Harness({ target, tabId }: { target: LinkMenuTarget; tabId: string | null }) {
	const menu = useLinkMenu(tabId);
	return (
		<div onClick={parentClick}>
			<a data-link href="#x" onContextMenu={event => menu.onContextMenu(event, target)}>
				link
			</a>
			{menu.menu}
		</div>
	);
}

async function openMenu(target: LinkMenuTarget, tabId: string | null = "tab-1"): Promise<string[]> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () =>
		root.render(
			<I18nProvider>
				<Harness tabId={tabId} target={target} />
			</I18nProvider>,
		),
	);
	await act(async () => {
		container
			.querySelector("[data-link]")
			?.dispatchEvent(new Event("contextmenu", { bubbles: true, cancelable: true }));
	});
	return [...document.querySelectorAll("[data-menu-item]")].map(item => item.textContent ?? "");
}

async function choose(label: string): Promise<void> {
	const item = [...document.querySelectorAll<HTMLElement>("[data-menu-item]")].find(
		node => node.textContent === label,
	);
	if (!item) throw new Error(`no menu item ${label}`);
	await act(async () => item.dispatchEvent(new Event("click", { bubbles: true })));
}

beforeEach(() => {
	Reflect.set(window, "omp", { system });
	useTabsStore.setState({
		tabs: [{ id: "tab-1" }, { id: "tab-remote", device: "host-b" }] as never,
		activeTabId: "tab-1",
	});
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	useUiStore.setState({ previewUrl: null, filePreviewPath: null, filePreviewLine: null });
	useTabsStore.setState({ tabs: [], activeTabId: null });
	vi.clearAllMocks();
});

describe("link menu", () => {
	it("opens a web link in Preview or the browser", async () => {
		expect(await openMenu({ kind: "web", url: "https://example.com/a" })).toEqual([
			"Open in Preview",
			"Open in browser",
			"Copy link",
		]);
		await choose("Open in Preview");
		expect(useUiStore.getState()).toMatchObject({ previewUrl: "https://example.com/a", panelTab: "preview" });
		expect(parentClick).not.toHaveBeenCalled();
		// A choice closes the menu.
		expect(document.querySelector('[role="menu"]')).toBeNull();
	});

	it("offers the mail app for a mail link", async () => {
		expect(await openMenu({ kind: "web", url: "mailto:kim@example.com" })).toEqual([
			"Open in mail app",
			"Copy address",
		]);
		await choose("Open in mail app");
		expect(system.openExternal).toHaveBeenCalledWith("mailto:kim@example.com");
	});

	it("opens, opens natively and reveals a local file of this machine's tab", async () => {
		expect(await openMenu({ kind: "path", path: "src/a.ts", line: 4, dir: false })).toEqual([
			"Preview",
			"Open in default app",
			"Reveal in Finder",
			"Save a copy…",
			"Copy path",
		]);
		await choose("Reveal in Finder");
		expect(system.revealPath).toHaveBeenCalledWith("src/a.ts", "tab-1");
		expect(parentClick).not.toHaveBeenCalled();
	});

	it("opens a file at its line and shows a folder in Files", async () => {
		await openMenu({ kind: "path", path: "src/a.ts", line: 4, dir: false });
		await choose("Preview");
		expect(useUiStore.getState()).toMatchObject({ filePreviewPath: "src/a.ts", filePreviewLine: 4 });
		await act(async () => root.unmount());
		container.remove();
		expect(await openMenu({ kind: "path", path: "out/", dir: true })).toContain("Show in Files");
	});

	it("keeps native actions off a paired host's tab and saves its file here instead", async () => {
		expect(await openMenu({ kind: "path", path: "src/a.ts", dir: false }, "tab-remote")).toEqual([
			"Preview",
			"Save to this computer",
			"Copy path",
		]);
	});
});
