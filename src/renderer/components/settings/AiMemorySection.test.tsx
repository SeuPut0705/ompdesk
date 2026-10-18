import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiMemoryState } from "../../../shared/ai-memory";
import { I18nProvider } from "../../lib/i18n";
import { useAiMemoryStore } from "../../stores/ai-memory";
import { AiMemorySection } from "./AiMemorySection";

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

function ready(extra: Partial<AiMemoryState> = {}): AiMemoryState {
	return {
		enabled: true,
		phase: "ready",
		step: null,
		source: "bundled",
		version: "3.1.1",
		binary: "/app/ai-memory",
		dataDir: "/Users/me/.local/share/ai-memory",
		serverUrl: "http://127.0.0.1:49374",
		webUrl: "http://127.0.0.1:49374/web",
		wiring: { extension: true, mcp: true },
		stats: { pages: 12, sessions: 3, observations: 40, diskBytes: 2048 },
		detail: null,
		...extra,
	};
}

let current = ready();
const api = {
	getState: vi.fn(async () => current),
	onState: vi.fn(() => () => {}),
	setEnabled: vi.fn(async (_enabled: boolean) => {}),
	retry: vi.fn(async () => {}),
	purge: vi.fn(async () => {}),
	openWeb: vi.fn(async () => {}),
	copyWebPassword: vi.fn(async () => {}),
	revealData: vi.fn(async () => {}),
};
Object.assign(window as unknown as Record<string, unknown>, { omp: { aiMemory: api } });

let root: Root | null = null;

async function mount(state: AiMemoryState): Promise<void> {
	current = state;
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<AiMemorySection />
			</I18nProvider>,
		);
	});
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

function reactProps(element: object): Record<string, (...args: unknown[]) => void> {
	const record = element as Record<string, unknown>;
	const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
	if (!key) throw new Error("react props not found");
	return record[key] as Record<string, (...args: unknown[]) => void>;
}

async function click(element: object | null): Promise<void> {
	if (!element) throw new Error("click: element missing");
	await act(async () => reactProps(element).onClick?.({ preventDefault() {}, stopPropagation() {} }));
	await act(async () => {
		await Promise.resolve();
	});
}

function button(label: string): object | null {
	return (
		[...document.body.querySelectorAll("button")].find(
			item => item.getAttribute("aria-label") === label || (item.textContent ?? "").trim() === label,
		) ?? null
	);
}

const text = () => document.body.textContent ?? "";

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockClear();
});

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
	useAiMemoryStore.getState().reset();
});

describe("Settings › Memory (ai-memory)", () => {
	it("shows the status, version, data location with its counts, and the privacy note", async () => {
		await mount(ready());
		const status = document.body.querySelector("[data-ai-memory-status]")?.textContent ?? "";
		expect(status).toContain("Running");
		expect(status).toContain("v3.1.1");
		expect(status).toContain("built in");
		expect(document.body.querySelector("[data-ai-memory-dir]")?.textContent).toBe("/Users/me/.local/share/ai-memory");
		expect(document.body.querySelector("[data-ai-memory-stats]")?.textContent).toBe(
			"12 pages · 3 sessions · 40 observations · 2.0 KB",
		);
		const privacy = document.body.querySelector("[data-ai-memory-privacy]")?.textContent ?? "";
		expect(privacy).toContain("127.0.0.1:49374");
		expect(privacy).toContain("not detected");
		expect(privacy).toContain("replies are not recorded");
		expect(privacy).toContain(".ai-memory.toml");
		expect(privacy).toContain("ignore_paths");
		// Nothing of stock's memory backends remains.
		expect(text()).not.toContain("backend");
	});

	it("turns memory off through ai-memory, not a prefs write", async () => {
		await mount(ready());
		const toggle = document.body.querySelector("[role=switch]");
		if (!toggle) throw new Error("missing switch");
		expect(toggle.getAttribute("aria-checked")).toBe("true");
		await click(toggle);
		expect(api.setEnabled).toHaveBeenCalledWith(false);
	});

	it("shows the step while starting and keeps the switch from being flipped", async () => {
		await mount(ready({ phase: "starting", step: "wire", stats: null }));
		expect(text()).toContain("Starting: connecting it to omp");
		expect(document.body.querySelector("[role=switch]")?.hasAttribute("disabled")).toBe(true);
	});

	it("offers Try again only after a failure or an unreachable server", async () => {
		await mount(ready());
		expect(button("Try again")).toBeNull();
		await act(async () => root?.unmount());
		root = null;
		document.body.innerHTML = "";
		useAiMemoryStore.getState().reset();
		await mount(ready({ phase: "failed", detail: "could not stage the binary", stats: null }));
		expect(text()).toContain("could not stage the binary");
		await click(button("Try again"));
		expect(api.retry).toHaveBeenCalledTimes(1);
	});

	it("opens the console, copies its password and reveals the data folder", async () => {
		await mount(ready());
		await click(button("Open console"));
		expect(api.openWeb).toHaveBeenCalledTimes(1);
		await click(button("Copy console password"));
		expect(api.copyWebPassword).toHaveBeenCalledTimes(1);
		await click(button("Reveal"));
		expect(api.revealData).toHaveBeenCalledTimes(1);
		expect(text()).toContain("any username");
	});

	it("asks before erasing everything, says what goes, then purges", async () => {
		await mount(ready());
		await click(button("Delete all memory"));
		expect(api.purge).not.toHaveBeenCalled();
		const dialogText = text();
		expect(dialogText).toContain("Delete all memory?");
		expect(dialogText).toContain("every page, handoff, recorded session and observation");
		const confirm = [...document.body.querySelectorAll("button")].filter(
			item => (item.textContent ?? "").trim() === "Delete all memory",
		);
		await click(confirm.at(-1) ?? null);
		expect(api.purge).toHaveBeenCalledTimes(1);
	});

	it("hides the console and data rows while memory is off, and says unsupported plainly", async () => {
		await mount(ready({ enabled: false, phase: "off", stats: null }));
		expect(text()).toContain("Off");
		expect(button("Open console")).toBeNull();
		await act(async () => root?.unmount());
		root = null;
		document.body.innerHTML = "";
		useAiMemoryStore.getState().reset();
		await mount(ready({ enabled: true, phase: "unsupported", version: null, stats: null }));
		expect(text()).toContain("Not available on this system");
		expect(document.body.querySelector("[role=switch]")?.hasAttribute("disabled")).toBe(true);
	});
});
