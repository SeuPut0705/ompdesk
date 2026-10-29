/**
 * Test rig for the Memory page's components (linkedom, no browser): fake `window.omp.aiMemory`, fixtures, a mount
 * that wraps `I18nProvider`, and the click/change helpers the repo's other component tests use. Not shipped: only
 * `*.test.tsx` files import it.
 */
import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";
import type {
	AiMemoryCareSummary,
	AiMemoryHandoff,
	AiMemoryLintFinding,
	AiMemoryObservations,
	AiMemoryPage,
	AiMemoryPageRef,
	AiMemoryProfile,
	AiMemoryProject,
	AiMemorySession,
	AiMemoryState,
} from "../../../../shared/ai-memory";
import { I18nProvider } from "../../../lib/i18n";
import { resetLastReadForTest } from "../../../lib/last-read";
import { useAiMemoryStore } from "../../../stores/ai-memory";
import { useMemoryPageStore } from "../../../stores/memory-page";
import { useToastStore } from "../../../stores/toast";

const dom = parseHTML("<html><body></body></html>");
export const document = dom.document;
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = dom.window;
globals.Event = dom.Event;
globals.HTMLElement = dom.HTMLElement;
globals.Element = dom.Element;
globals.Node = dom.Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

export const PROJECT = { workspace: "work", project: "app" };
export const OTHER = { workspace: "work", project: "api" };

export function memoryState(extra: Partial<AiMemoryState> = {}): AiMemoryState {
	return {
		phase: "ready",
		step: null,
		version: "3.1.1",
		binary: "/app/memory",
		dataDir: "/data",
		serverUrl: "http://127.0.0.1:49374",
		webUrl: "http://127.0.0.1:49374/web",
		wiring: { app: true, terminal: false },
		stats: { pages: 5, sessions: 2, observations: 9, diskBytes: 2048 },
		detail: null,
		unsupported: null,
		...extra,
	};
}

export const APP: AiMemoryProject = { ...PROJECT, pages: 3, lastUpdated: "2026-10-18T10:00:00Z" };
export const API: AiMemoryProject = { ...OTHER, pages: 1, lastUpdated: "2026-10-17T10:00:00Z" };

export const ref = (path: string, title: string, extra: Partial<AiMemoryPageRef> = {}): AiMemoryPageRef => ({
	...PROJECT,
	path,
	title,
	updatedAt: "2026-10-18T10:00:00Z",
	kind: "note",
	tier: "semantic",
	...extra,
});

export const handoff = (id: string, state: string, extra: Partial<AiMemoryHandoff> = {}): AiMemoryHandoff => ({
	...PROJECT,
	id,
	agent: "omp",
	createdAt: "2026-10-18T09:00:00Z",
	summary: `Summary of ${id}`,
	openQuestions: [],
	nextSteps: [],
	state,
	...extra,
});

export const pageOf = (path: string, title: string, extra: Partial<AiMemoryPage> = {}): AiMemoryPage => ({
	...PROJECT,
	path,
	title,
	updatedAt: "2026-10-18T10:00:00Z",
	kind: "note",
	tier: "semantic",
	markdown: `# ${title}\n\nBody of **${title}**.`,
	id: "v1",
	pinned: false,
	createdAt: "2026-10-17T10:00:00Z",
	tags: ["t"],
	...extra,
});

/** A fake `window.omp.aiMemory`; every method is a `vi.fn` the test can re-stub. */
export function fakeMemoryApi() {
	return {
		getState: vi.fn(async () => memoryState()),
		onState: vi.fn(() => () => {}),
		retry: vi.fn(async () => {}),
		purge: vi.fn(async () => {}),
		setTerminal: vi.fn(async (_enabled: boolean) => {}),
		openWeb: vi.fn(async () => {}),
		copyWebPassword: vi.fn(async () => {}),
		revealData: vi.fn(async () => {}),
		projects: vi.fn(async (): Promise<AiMemoryProject[]> => [APP, API]),
		search: vi.fn(async (_query: string, _project?: unknown): Promise<AiMemoryPageRef[]> => []),
		recent: vi.fn(async (_project?: unknown): Promise<AiMemoryPageRef[]> => []),
		handoffs: vi.fn(async (_project?: unknown): Promise<AiMemoryHandoff[]> => []),
		readPage: vi.fn(async (r: { path: string }): Promise<AiMemoryPage> => pageOf(r.path, "Page")),
		overview: vi.fn(async (_project: unknown) => ({
			pages: 3,
			sessions: 2,
			observations: 7,
			lastCaptureAt: "2026-10-18T09:00:00Z",
			openHandoffs: 1,
			activity7d: { sessions: 2, observations: 7, pagesUpdated: 3 },
			health: { stale: 0, duplicates: 1, contradictions: 0, orphans: 2 },
		})),
		pages: vi.fn(async (_project: unknown): Promise<AiMemoryPageRef[]> => []),
		sessions: vi.fn(async (_project: unknown): Promise<AiMemorySession[]> => []),
		observations: vi.fn(
			async (_project: unknown, _id: string, _offset?: number): Promise<AiMemoryObservations> => ({
				session: {
					id: "",
					cwd: "",
					agent: "",
					startedAt: null,
					endedAt: null,
					observations: 0,
					consolidation: null,
				},
				observations: [],
				total: 0,
				offset: 0,
			}),
		),
		profile: vi.fn(
			async (): Promise<AiMemoryProfile> => ({
				enabled: true,
				injected: true,
				digestBytes: 0,
				scope: null,
				entries: [],
			}),
		),
		lint: vi.fn(async (_project: unknown): Promise<AiMemoryLintFinding[]> => []),
		sweep: vi.fn(async (_project: unknown, dryRun: boolean) => ({
			dryRun,
			evaluated: 0,
			evicted: 0,
			compacted: 0,
			merged: 0,
			expired: 0,
			observationsPruned: 0,
		})),
		writePage: vi.fn(async (_input: unknown) => {}),
		deletePage: vi.fn(async (r: { workspace: string; project: string; path: string; title?: string }) => ({
			workspace: r.workspace,
			project: r.project,
			path: r.path,
			title: r.title ?? r.path,
			rev: "rev-1",
			deletedAt: "2026-10-19T00:00:00Z",
		})),
		restorePage: vi.fn(async (_ref: unknown, _rev: string) => {}),
		feedback: vi.fn(async (_ref: unknown, _signal: string) => {}),
		cancelHandoff: vi.fn(async (_project: unknown, _id: string) => {}),
		care: vi.fn(async (): Promise<AiMemoryCareSummary | null> => null),
		undoCare: vi.fn(async () => 0),
	};
}

export type FakeMemoryApi = ReturnType<typeof fakeMemoryApi>;

export function installApi(api: FakeMemoryApi): void {
	Object.assign(dom.window as unknown as Record<string, unknown>, {
		omp: { aiMemory: api, prefs: { get: async () => undefined, set: async () => undefined } },
	});
}

let root: Root | null = null;

export async function settle(): Promise<void> {
	for (let i = 0; i < 6; i++)
		await act(async () => {
			await Promise.resolve();
		});
}

export async function mount(node: ReactNode): Promise<void> {
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(<I18nProvider>{node}</I18nProvider>);
	});
	await settle();
}

export async function cleanup(): Promise<void> {
	if (root) await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
	useAiMemoryStore.getState().reset();
	useMemoryPageStore.getState().reset();
	useToastStore.setState({ toasts: [] });
	resetLastReadForTest();
}

export const q = (selector: string): Element | null => document.body.querySelector(selector);
export const qa = (selector: string): Element[] => [...document.body.querySelectorAll(selector)];
export const text = (selector: string): string => q(selector)?.textContent ?? "";

export function reactProps(element: object): Record<string, (...args: unknown[]) => void> {
	const record = element as Record<string, unknown>;
	const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
	if (!key) throw new Error("react props not found");
	return record[key] as Record<string, (...args: unknown[]) => void>;
}

export async function click(element: object | null): Promise<void> {
	if (!element) throw new Error("click: element missing");
	await act(async () => reactProps(element).onClick?.({ preventDefault() {}, stopPropagation() {} }));
	await settle();
}

export function button(label: string): Element | null {
	return qa("button").find(item => item.textContent?.trim() === label) ?? null;
}

export async function type(element: object | null, value: string): Promise<void> {
	if (!element) throw new Error("type: element missing");
	await act(async () => {
		reactProps(element).onChange?.({ target: { value }, currentTarget: { value } });
	});
	await settle();
}

export async function submit(element: object | null): Promise<void> {
	if (!element) throw new Error("submit: element missing");
	await act(async () => reactProps(element).onSubmit?.({ preventDefault() {} }));
	await settle();
}
