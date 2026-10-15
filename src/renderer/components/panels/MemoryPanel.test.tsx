/**
 * Side panel › Memory shows only what the active stock backend implements:
 * search, save and the pending queue each appear with their hook, a backend
 * turned off is one line plus the way to Settings, and Clear runs only after
 * the destructive confirmation. Same linkedom + react-dom harness as
 * PluginsSection.test.tsx; `window.omp.rpc` is stubbed.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcMemoryReport } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { resetTabRoute } from "../../lib/tab-routing";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { MemoryPanel } from "./MemoryPanel";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

interface TestElement {
	textContent: string | null;
	remove(): void;
	dispatchEvent(event: object): boolean;
	getAttribute(name: string): string | null;
}

/** Every button in the document (dialogs portal into the body). */
function buttons(): TestElement[] {
	return Array.from(document.querySelectorAll("button")) as unknown as TestElement[];
}

let root: Root | null = null;
let container: TestElement | null = null;

const ok = (data: unknown) => ({ success: true as const, data });

async function flush(): Promise<void> {
	await act(async () => {
		for (let i = 0; i < 4; i++) await Promise.resolve();
	});
}

async function mount(report: RpcMemoryReport, rpc: Record<string, unknown> = {}) {
	const getMemoryReport = vi.fn(async () => ok(report));
	const memoryQueue = vi.fn(async () => ok({ payload: "- pending delta" }));
	const memoryClear = vi.fn(async () => ok({ ok: true }));
	const stubs = { getMemoryReport, memoryQueue, memoryClear, ...rpc };
	(window as unknown as { omp: { rpc: typeof stubs } }).omp = { rpc: stubs };
	useSessionStore.setState({ status: "ready", cwd: "/repo" });
	useTabsStore.setState({
		activeTabId: "tab-1",
		tabs: [{ id: "tab-1", cwd: "/repo", status: "ready", kind: "agent", unreadDone: false }],
		bundles: new Map(),
	});
	resetTabRoute();
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<MemoryPanel />
			</I18nProvider>,
		);
	});
	await flush();
	return stubs;
}

function button(label: string): TestElement | undefined {
	return buttons().find(
		candidate => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label,
	);
}

async function click(target: TestElement | undefined): Promise<void> {
	if (!target) throw new Error("missing button");
	const event = new Event("click", { bubbles: true, cancelable: true });
	// linkedom's Event has a getter-only eventPhase React writes to.
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	await act(async () => {
		target.dispatchEvent(event);
	});
	await flush();
}

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	container?.remove();
	root = null;
	container = null;
	document.body.innerHTML = "";
	useSessionStore.getState().reset();
	useTabsStore.getState().reset();
	resetTabRoute();
	vi.restoreAllMocks();
});

describe("MemoryPanel", () => {
	it("shows the injection payload and only the save form of a backend without search or queue", async () => {
		const rpc = await mount({
			backend: "local",
			status: { active: true, writable: true, searchable: false },
			payload: "Remember: the user prefers tabs.",
			capabilities: { search: false, save: true, queue: false },
		});
		expect(document.querySelector("[data-memory-payload]")?.textContent).toContain(
			"Remember: the user prefers tabs.",
		);
		expect(document.querySelector("[data-memory-save]")).not.toBeNull();
		expect(document.querySelector("[data-memory-search]")).toBeNull();
		expect(document.querySelector("[data-memory-queue]")).toBeNull();
		expect(rpc.memoryQueue).not.toHaveBeenCalled();
	});

	it("shows search and the pending queue, without a save form, for a search-and-queue backend", async () => {
		const rpc = await mount({
			backend: "sharpshooter",
			status: { active: true, writable: false, searchable: true },
			capabilities: { search: true, save: false, queue: true },
		});
		expect(document.querySelector("[data-memory-search]")).not.toBeNull();
		expect(document.querySelector("[data-memory-save]")).toBeNull();
		expect(rpc.memoryQueue).toHaveBeenCalledTimes(1);
		expect(document.querySelector("[data-memory-queue]")?.textContent).toContain("pending delta");
		// No payload is one quiet line, not an empty section.
		expect(document.querySelector("[data-memory-payload]")?.textContent).toContain(
			"Memory adds nothing to the agent's prompt yet.",
		);
	});

	it("reduces a backend that is off to one line and the way to choose one", async () => {
		await mount({
			backend: "off",
			status: { active: false, writable: false, searchable: false, message: "Memory backend is off." },
			capabilities: { search: false, save: false, queue: false },
		});
		expect(document.querySelector("[data-memory-off]")).not.toBeNull();
		expect(document.querySelector("[data-memory-payload]")).toBeNull();
		expect(button("Clear memory")).toBeUndefined();
		expect(button("Consolidate now")).toBeUndefined();
		expect(button("Choose a memory backend")).toBeDefined();
	});

	it("clears only after the destructive confirmation", async () => {
		const rpc = await mount({
			backend: "local",
			capabilities: { search: false, save: true, queue: false },
		});
		await click(button("Clear memory"));
		expect(rpc.memoryClear).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain("Clear memory?");
		const confirm = buttons().filter(candidate => candidate.textContent?.trim() === "Clear memory");
		await click(confirm.at(-1));
		expect(rpc.memoryClear).toHaveBeenCalledTimes(1);
		// The report reloads after the clear.
		expect(rpc.getMemoryReport).toHaveBeenCalledTimes(2);
	});
});
