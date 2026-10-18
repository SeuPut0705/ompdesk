import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AiMemoryHandoff,
	AiMemoryPage,
	AiMemoryPageRef,
	AiMemoryProject,
	AiMemoryProjectRef,
	AiMemoryState,
} from "../../../shared/ai-memory";
import { I18nProvider } from "../../lib/i18n";
import { useAiMemoryStore } from "../../stores/ai-memory";
import { AiMemoryPanel } from "./AiMemoryPanel";

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

function state(extra: Partial<AiMemoryState> = {}): AiMemoryState {
	return {
		enabled: true,
		phase: "ready",
		step: null,
		source: "bundled",
		version: "3.1.1",
		binary: "/app/ai-memory",
		dataDir: "/data",
		serverUrl: "http://127.0.0.1:49374",
		webUrl: "http://127.0.0.1:49374/web",
		wiring: { app: true, terminal: false },
		stats: { pages: 5, sessions: 2, observations: 9, diskBytes: 1024 },
		detail: null,
		...extra,
	};
}

const APP: AiMemoryProject = { workspace: "work", project: "app", pages: 3, lastUpdated: "2026-10-18T10:00:00Z" };
const API: AiMemoryProject = { workspace: "work", project: "api", pages: 1, lastUpdated: "2026-10-17T10:00:00Z" };

const page = (project: AiMemoryProject, path: string, title: string, extra: Partial<AiMemoryPageRef> = {}) => ({
	workspace: project.workspace,
	project: project.project,
	path,
	title,
	updatedAt: "2026-10-18T10:00:00Z",
	...extra,
});

let current = state();
const api = {
	getState: vi.fn(async () => current),
	onState: vi.fn(() => () => {}),
	openWeb: vi.fn(async () => {}),
	projects: vi.fn(async (): Promise<AiMemoryProject[]> => [APP, API]),
	search: vi.fn(
		async (_query: string, _project?: AiMemoryProjectRef): Promise<AiMemoryPageRef[]> => [
			page(APP, "decisions/0007-db.md", "Use sqlite", { snippet: "we chose sqlite for the cache" }),
		],
	),
	recent: vi.fn(
		async (_project?: AiMemoryProjectRef): Promise<AiMemoryPageRef[]> => [
			page(APP, "sessions/s1.md", "Session one"),
			page(API, "sessions/s2.md", "Session two"),
		],
	),
	handoffs: vi.fn(
		async (_project?: AiMemoryProjectRef): Promise<AiMemoryHandoff[]> => [
			{
				workspace: "work",
				project: "app",
				id: "h1",
				agent: "omp",
				createdAt: "2026-10-18T09:00:00Z",
				summary: "Finish the cache layer",
				state: "accepted",
			},
			{
				workspace: "work",
				project: "app",
				id: "h2",
				agent: "omp",
				createdAt: "2026-10-17T09:00:00Z",
				summary: "Wire the tests",
				state: "open",
			},
		],
	),
	readPage: vi.fn(
		async (ref: AiMemoryProjectRef & { path: string }): Promise<AiMemoryPage> => ({
			...page(APP, ref.path, "Use sqlite"),
			markdown: "# Use sqlite\n\nBecause it is **small**.",
		}),
	),
};
Object.assign(window as unknown as Record<string, unknown>, { omp: { aiMemory: api } });

let root: Root | null = null;

async function settle(): Promise<void> {
	for (let i = 0; i < 4; i++)
		await act(async () => {
			await Promise.resolve();
		});
}

async function mount(next: AiMemoryState): Promise<void> {
	current = next;
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<AiMemoryPanel />
			</I18nProvider>,
		);
	});
	await settle();
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
	await settle();
}

const q = (selector: string) => document.body.querySelector(selector);

beforeEach(() => {
	for (const fn of Object.values(api)) fn.mockClear();
});

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
	useAiMemoryStore.getState().reset();
});

describe("AiMemoryPanel", () => {
	it("shows the status header and, for all projects, the recent pages and handoffs (open ones first)", async () => {
		await mount(state());
		const header = q("[data-ai-memory-header]")?.textContent ?? "";
		expect(header).toContain("Running");
		expect(header).toContain("v3.1.1");
		expect(header).toContain("5 pages · 2 sessions · 9 observations");
		expect(api.recent).toHaveBeenCalledWith(undefined);
		expect(api.handoffs).toHaveBeenCalledWith(undefined);
		expect(q("[data-ai-memory-recent]")?.textContent).toContain("Session two");
		const handoffs = [...document.body.querySelectorAll("[data-ai-memory-handoff]")].map(
			item => item.textContent ?? "",
		);
		expect(handoffs).toHaveLength(2);
		expect(handoffs[0]).toContain("Wire the tests");
		expect(handoffs[0]).toContain("From omp");
		expect(handoffs[1]).toContain("accepted");
	});

	it("opens the console from the header", async () => {
		await mount(state());
		const open = [...document.body.querySelectorAll("button")].find(
			item => item.textContent?.trim() === "Open console",
		);
		await click(open ?? null);
		expect(api.openWeb).toHaveBeenCalledTimes(1);
	});

	it("filters by project", async () => {
		await mount(state());
		const select = q("select");
		if (!select) throw new Error("missing project filter");
		await act(async () => {
			reactProps(select).onChange?.({ target: { value: "work\napi" } });
		});
		await settle();
		expect(api.recent).toHaveBeenLastCalledWith({ workspace: "work", project: "api" });
		expect(api.handoffs).toHaveBeenLastCalledWith({ workspace: "work", project: "api" });
	});

	it("searches, shows hits with snippet and project, and opens a page as markdown", async () => {
		await mount(state());
		const input = q("input");
		if (!input) throw new Error("missing search box");
		await act(async () => {
			reactProps(input).onChange?.({ target: { value: "sqlite" }, currentTarget: { value: "sqlite" } });
		});
		const form = q("[data-ai-memory-search]");
		if (!form) throw new Error("missing search form");
		await act(async () => {
			reactProps(form).onSubmit?.({ preventDefault() {} });
		});
		await settle();
		expect(api.search).toHaveBeenCalledWith("sqlite", undefined);
		const results = q("[data-ai-memory-results]")?.textContent ?? "";
		expect(results).toContain("Use sqlite");
		expect(results).toContain("we chose sqlite for the cache");
		expect(results).toContain("work / app");
		await click(q('[data-ai-memory-page="decisions/0007-db.md"]'));
		expect(api.readPage).toHaveBeenCalledWith({
			workspace: "work",
			project: "app",
			path: "decisions/0007-db.md",
		});
		expect(q("[data-ai-memory-page-text]")?.textContent).toContain("Because it is small.");
		expect(q("strong")?.textContent).toBe("small");
	});

	it("says so when a list is empty, and when a read fails", async () => {
		api.recent.mockResolvedValueOnce([]);
		api.handoffs.mockRejectedValueOnce(new Error("server said no"));
		await mount(state());
		expect(q("[data-ai-memory-recent]")?.textContent).toContain("No pages yet.");
		const handoffs = q("[data-ai-memory-handoffs]")?.textContent ?? "";
		expect(handoffs).toContain("Couldn't read memory");
		expect(handoffs).toContain("server said no");
	});

	it.each([
		["off", "Memory is off. Turn it on in Settings › Memory (ai-memory)."],
		["unreachable", "The memory server isn't answering."],
		["failed", "Memory couldn't start."],
		["starting", "Memory is starting…"],
		["unsupported", "Memory isn't available on this system."],
	] as const)("shows the %s message and reads nothing", async (phase, message) => {
		await mount(state({ phase, enabled: phase !== "off", stats: null, detail: "details here" }));
		expect(q(`[data-ai-memory-unavailable="${phase}"]`)?.textContent).toContain(message);
		expect(api.projects).not.toHaveBeenCalled();
		expect(api.recent).not.toHaveBeenCalled();
		expect(api.handoffs).not.toHaveBeenCalled();
	});
});
