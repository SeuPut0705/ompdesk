/**
 * Side panel (PanelContainer): Changes · Files · Logs · Queue · Tree · Jobs,
 * the same in an agent and a chat tab (a chat is a full agent outside any
 * project). Todo/plan/agents cards stay in the center dock. Docked width
 * defaults into the spec's 360–460px range and stays resizable.
 * Same linkedom + react-dom harness as mode-visibility.test.tsx.
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { MarkdownRenderer } from "../../lib/markdown";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { migrateDefaultPanelTab, PANEL_TABS, useUiStore } from "../../stores/ui";
import { PanelContainer } from "./PanelContainer";

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

async function openViewMenu(): Promise<void> {
	const button = document.querySelector('button[aria-label="View options"]') as HTMLElement;
	button.getBoundingClientRect = () => ({ left: 0, right: 32, bottom: 48 }) as DOMRect;
	await act(async () => {
		const event = new Event("click", { bubbles: true });
		Object.defineProperty(event, "eventPhase", { value: 0, writable: true });
		button.dispatchEvent(event);
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
		it(`renders every side panel view in an ${kind} tab, labelled as one region`, async () => {
			seedActiveTab(kind);
			useUiStore.setState({ panelTab: "files", panelVisible: true });
			await mount(<PanelContainer />);
			expect(document.querySelector(".omp-panel-topbar")?.querySelectorAll("button")).toHaveLength(6);
			expect(document.querySelector(".omp-panel-topbar")?.querySelector('[aria-label="Refresh"]')).toBeNull();
			expect(document.querySelector("[data-panel-actions]")).not.toBeNull();

			await openViewMenu();
			const views = [...document.querySelectorAll('[role="menuitemcheckbox"]')].map(button =>
				button.textContent?.trim(),
			);
			expect(views).toEqual(["Background tasks", "Plan", "Logs", "Queue", "Tree", "Memory"]);
			for (const label of ["Terminal", "Changes", "Preview", "Files"]) {
				const button = document.querySelector(`button[aria-label="${label}"]`);
				expect(button).not.toBeNull();
				expect(button?.getAttribute("aria-pressed")).toBe(String(label === "Files"));
			}
			const tree = document.querySelectorAll('[role="menuitemcheckbox"]')[4]!;
			await act(async () => {
				const event = new Event("click", { bubbles: true });
				Object.defineProperty(event, "eventPhase", { value: 0, writable: true });
				tree.dispatchEvent(event);
			});
			expect(useUiStore.getState().panelTab).toBe("tree");
			expect(document.querySelector(".omp-panel-topbar")?.textContent).toContain("Tree");
			await openViewMenu();
			expect(document.querySelectorAll('[role="menuitemcheckbox"]')[4]?.getAttribute("aria-checked")).toBe("true");
			expect(document.querySelector("aside")?.getAttribute("aria-label")).toBe("Side panel");
			expect(document.querySelector('button[aria-label="Close side panel"]')).not.toBeNull();
		});
	}

	it("opens Queue, Tree and Jobs through the store like the other views", async () => {
		seedActiveTab("agent");
		useUiStore.setState({ panelVisible: false });
		useUiStore.getState().openJobs();
		expect(useUiStore.getState()).toMatchObject({ panelVisible: true, panelTab: "jobs" });
		useUiStore.getState().openSessionTree();
		expect(useUiStore.getState().panelTab).toBe("tree");
		seedActiveTab("chat");
		useUiStore.getState().setPanelTab("diff");
		expect(useUiStore.getState().panelTab).toBe("diff");
		useUiStore.getState().setPanelTab("queue");
		expect(useUiStore.getState().panelTab).toBe("queue");
		useUiStore.getState().openPreview("http://localhost:3000");
		expect(useUiStore.getState()).toMatchObject({
			panelTab: "preview",
			panelVisible: true,
			previewUrl: "http://localhost:3000",
		});
	});

	it("keeps legacy default views and accepts every current view", () => {
		for (const view of PANEL_TABS) expect(migrateDefaultPanelTab(view)).toBe(view);
		expect(migrateDefaultPanelTab("retired")).toBe("diff");
		expect(migrateDefaultPanelTab(null)).toBe("diff");
	});

	it("reaches secondary views with menu keyboard navigation", async () => {
		seedActiveTab("agent");
		useUiStore.setState({ panelTab: "files" });
		await mount(<PanelContainer />);
		await openViewMenu();
		const menu = document.querySelector('[role="menu"]')!;
		for (const key of ["ArrowDown", "Enter"]) {
			await act(async () => {
				const event = new Event("keydown", { bubbles: true, cancelable: true });
				Object.defineProperty(event, "key", { value: key });
				menu.dispatchEvent(event);
			});
		}
		expect(useUiStore.getState().panelTab).toBe("plan");
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
