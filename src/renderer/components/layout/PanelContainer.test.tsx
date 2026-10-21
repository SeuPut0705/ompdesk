/**
 * Side panel (PanelContainer): Changes · Files · Logs · Queue · Tree · Jobs,
 * the same in an agent and a chat tab (a chat is a full agent outside any
 * project). Todo/plan/agents cards stay in the center dock. Docked width
 * defaults into the spec's 360–460px range and stays resizable.
 * Same linkedom + react-dom harness as composer/ComposerModes.chip.test.tsx.
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { MarkdownRenderer } from "../../lib/markdown";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { migrateDefaultPanelTab, PANEL_TABS, useUiStore } from "../../stores/ui";
import { PanelContainer, preloadPanelViews } from "./PanelContainer";

// The views are a lazy chunk (PanelViews.tsx); the desktop has it before a panel mounts, and so do these tests.
beforeAll(() => preloadPanelViews());

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.defineProperties(window, {
	innerWidth: { configurable: true, value: 1440 },
	innerHeight: { configurable: true, value: 900 },
});

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);
const ompWindow = window as unknown as { omp?: unknown };
const initialOmp = ompWindow.omp;

interface TestElement {
	textContent: string | null;
	remove: () => void;
}

let container: TestElement;
let root: Root;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
	await flush();
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	useSessionStore.getState().reset();
	useTabsStore.getState().reset();
	useUiStore.setState({ panelTab: "files", panelVisible: true, filePreviewPath: null, filePreviewExpanded: false });
	if (initialOmp === undefined) delete ompWindow.omp;
	else ompWindow.omp = initialOmp;
	Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
});

function seedActiveTab(kind: "agent" | "chat"): void {
	useTabsStore.setState({
		tabs: [{ id: "t0", cwd: "/work", status: "ready", kind, unreadDone: false }],
		activeTabId: "t0",
		bundles: new Map(),
	});
}

function dispatchPointer(element: Element, type: string, clientX: number): void {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperties(event, {
		clientX: { value: clientX },
		pointerId: { value: 1 },
	});
	element.dispatchEvent(event);
}

function FileLinkHarness({ content = "[report](docs/report.md)" }: { content?: string }) {
	const panelVisible = useUiStore(s => s.panelVisible);
	return (
		<>
			<MarkdownRenderer content={content} />
			{panelVisible && <PanelContainer />}
		</>
	);
}

describe("PanelContainer", () => {
	for (const kind of ["agent", "chat"] as const) {
		it(`shows four views and no View options list in an ${kind} tab, labelled as one region`, async () => {
			seedActiveTab(kind);
			useUiStore.setState({ panelTab: "files", panelVisible: true });
			await mount(<PanelContainer />);
			// The four views and the close button; nothing more in the header.
			expect(document.querySelector(".omp-panel-topbar")?.querySelectorAll("button")).toHaveLength(5);
			expect(document.querySelector('button[aria-label="View options"]')).toBeNull();
			expect(document.querySelector(".omp-panel-topbar")?.querySelector('[aria-label="Refresh"]')).toBeNull();
			expect(document.querySelector("[data-panel-actions]")).not.toBeNull();
			for (const label of ["Terminal", "Changes", "Preview", "Files"]) {
				const button = document.querySelector(`button[aria-label="${label}"]`);
				expect(button).not.toBeNull();
				expect(button?.getAttribute("aria-pressed")).toBe(String(label === "Files"));
			}
			expect(document.querySelector("aside")?.getAttribute("aria-label")).toBe("Side panel");
			expect(document.querySelector('button[aria-label="Close side panel"]')).not.toBeNull();
		});
	}

	it("opens Jobs and the session tree as sheets and the panel's views in the panel", async () => {
		seedActiveTab("agent");
		useUiStore.setState({ panelVisible: false, viewSheet: null });
		useUiStore.getState().openJobs();
		expect(useUiStore.getState().viewSheet?.view).toBe("jobs");
		useUiStore.getState().openSessionTree();
		expect(useUiStore.getState().viewSheet?.view).toBe("tree");
		expect(useUiStore.getState().panelVisible).toBe(false);
		useUiStore.getState().closeViewSheet();
		useUiStore.getState().openPreview("http://localhost:3000");
		expect(useUiStore.getState()).toMatchObject({
			panelTab: "preview",
			panelVisible: true,
			previewUrl: "http://localhost:3000",
			viewSheet: null,
		});
	});

	it("keeps legacy default views and accepts every current view", () => {
		for (const view of PANEL_TABS) expect(migrateDefaultPanelTab(view)).toBe(view);
		expect(migrateDefaultPanelTab("retired")).toBe("diff");
		expect(migrateDefaultPanelTab(null)).toBe("diff");
	});

	it("defaults to the docked 360–460px range on wide windows", async () => {
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 2400 });
		seedActiveTab("agent");
		await mount(<PanelContainer />);

		expect((document.querySelector("aside") as HTMLElement | null)?.style.width).toBe("460px");
	});

	it("resizes from the window edge in both directions without snapping closed", async () => {
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
		seedActiveTab("agent");
		await mount(<PanelContainer />);

		const aside = document.querySelector("aside") as HTMLElement;
		const separator = document.querySelector('[role="separator"]') as HTMLElement & {
			setPointerCapture: (pointerId: number) => void;
		};
		separator.setPointerCapture = vi.fn();

		await act(async () => {
			dispatchPointer(separator, "pointerdown", 1037);
			dispatchPointer(separator, "pointermove", 900);
		});
		expect(aside.style.width).toBe("540px");

		await act(async () => {
			dispatchPointer(separator, "pointermove", 1000);
			dispatchPointer(separator, "pointerup", 1000);
		});
		expect(aside.style.width).toBe("440px");
		expect(useUiStore.getState().panelVisible).toBe(true);
	});

	it("widens for an expanded file viewer and restores the dragged width", async () => {
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
		seedActiveTab("agent");
		ompWindow.omp = {
			fs: {
				list: vi.fn(async () => ({ ok: true, entries: [], truncated: false })),
				read: vi.fn(async () => ({ ok: true, content: "x", truncated: false, binary: false, size: 1 })),
			},
		};
		useUiStore.setState({ panelTab: "files", panelVisible: true, filePreviewPath: "src/a.ts" });
		await mount(<PanelContainer />);
		const aside = document.querySelector("aside") as HTMLElement;
		expect(aside.style.width).toBe("403px");

		const expand = document.querySelector('button[aria-label="Expand panel"]') as HTMLElement;
		await act(async () => {
			expand.dispatchEvent(new Event("click", { bubbles: true }));
		});
		// 55% of the window, never past the 56px the transcript keeps.
		expect(aside.style.width).toBe("792px");
		expect(aside.getAttribute("data-expanded")).toBe("true");

		await act(async () => {
			useUiStore.getState().closeFilePreview();
		});
		expect(aside.style.width).toBe("403px");
		expect(useUiStore.getState().filePreviewExpanded).toBe(false);
	});

	it("opens a local markdown link inside the Files drawer", async () => {
		seedActiveTab("agent");
		useUiStore.setState({ panelVisible: false, filePreviewPath: null });
		const read = vi.fn(async () => ({
			ok: true,
			content: "# Preview heading\n\nRendered body.",
			truncated: false,
			binary: false,
			size: 34,
		}));
		ompWindow.omp = {
			fs: {
				list: vi.fn(async () => ({ ok: true, entries: [], truncated: false })),
				read,
			},
			system: {
				openExternal: vi.fn(async () => {}),
				openPath: vi.fn(async () => ({ ok: true })),
			},
		};
		await mount(<FileLinkHarness />);

		await act(async () => {
			document.querySelector("a")?.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
		});
		await flush();

		expect(useUiStore.getState()).toMatchObject({
			panelVisible: true,
			panelTab: "files",
			filePreviewPath: "docs/report.md",
		});
		expect(read).toHaveBeenCalledWith("docs/report.md", 200_000);
		expect(document.querySelector("aside h1")?.textContent).toBe("Preview heading");
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});

	it("decodes an absolute file URL and renders non-Markdown text as code", async () => {
		seedActiveTab("agent");
		useUiStore.setState({ panelVisible: false, filePreviewPath: null });
		const read = vi.fn(async () => ({
			ok: true,
			content: "SELECT 1;",
			truncated: false,
			binary: false,
			size: 9,
		}));
		ompWindow.omp = {
			fs: {
				list: vi.fn(async () => ({ ok: true, entries: [], truncated: false })),
				read,
			},
			system: {
				openExternal: vi.fn(async () => {}),
				openPath: vi.fn(async () => ({ ok: true })),
			},
		};
		await mount(<FileLinkHarness content="[sql](file:///tmp/my%20query.sql)" />);

		await act(async () => {
			document.querySelector("a")?.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
		});
		await flush();

		expect(read).toHaveBeenCalledWith("/tmp/my query.sql", 200_000);
		expect(document.querySelector("aside pre")?.textContent).toContain("SELECT 1;");
	});

	it("closes the tab a held close named once its unsaved Files edits were discarded", async () => {
		const original = useTabsStore.getState().closeTab;
		const closeTab = vi.fn(async () => {});
		try {
			seedActiveTab("agent");
			useTabsStore.setState({ closeTab });
			await mount(<PanelContainer />);
			expect(closeTab).not.toHaveBeenCalled();
			await act(async () => {
				useUiStore.setState({ discardedForTabClose: "t0" });
			});
			expect(closeTab).toHaveBeenCalledExactlyOnceWith("t0");
			expect(useUiStore.getState().discardedForTabClose).toBeNull();
		} finally {
			useTabsStore.setState({ closeTab: original });
		}
	});
});
