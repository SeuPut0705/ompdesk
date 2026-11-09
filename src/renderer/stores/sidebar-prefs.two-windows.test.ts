/**
 * Two renderers (a desktop window and a paired phone page) share one stored `sidebar` pref in main. Each keeps its own
 * copy of the store; main applies each change to what it stores and tells every window and page but the one that sent.
 * Main's side here is the real `updateSidebarPrefs`; only the transport is faked.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { updateSidebarPrefs } from "../../main/sidebar-prefs";
import type { useSidebarPrefs } from "./sidebar-prefs";

type Listener = (event: { key: string }) => void;

interface Renderer {
	name: string;
	listeners: Set<Listener>;
	api: { prefs: Record<string, unknown> };
	store: typeof useSidebarPrefs;
	/** While set, a change this renderer sent waits for it before main processes it (a request still on its way). */
	hold: Promise<void> | null;
}

const stored = new Map<string, unknown>();
const renderers: Renderer[] = [];
const wholeBlobWrites: unknown[] = [];
let current: Renderer | null = null;

(globalThis as Record<string, unknown>).window = {
	get omp() {
		return current?.api;
	},
};

/** `window.omp` is this renderer's while `fn` runs; a listener runs synchronously, so its first call lands on the right one. */
function withRenderer<T>(renderer: Renderer, fn: () => T): T {
	const previous = current;
	current = renderer;
	try {
		return fn();
	} finally {
		current = previous;
	}
}

async function as<T>(renderer: Renderer, fn: () => Promise<T> | T): Promise<T> {
	const previous = current;
	current = renderer;
	try {
		return await fn();
	} finally {
		current = previous;
	}
}

function pushChanged(writer: Renderer, key: string): void {
	for (const other of renderers) {
		if (other === writer) continue;
		for (const listener of other.listeners) withRenderer(other, () => listener({ key }));
	}
}

async function openRenderer(name: string): Promise<Renderer> {
	const renderer: Renderer = { name, listeners: new Set(), api: { prefs: {} }, store: undefined as never, hold: null };
	renderer.api.prefs = {
		get: async (key: string) => structuredClone(stored.get(key)),
		set: async (key: string, value: unknown) => {
			if (key === "sidebar") {
				wholeBlobWrites.push(value);
				throw new Error("[invalid_preference_key] The sidebar prefs change through prefs.updateSidebar");
			}
			stored.set(key, structuredClone(value));
			pushChanged(renderer, key);
		},
		updateSidebar: async (change: unknown) => {
			await renderer.hold;
			updateSidebarPrefs(
				{
					get: key => structuredClone(stored.get(key)),
					set: (key, value) => void stored.set(key, structuredClone(value)),
				},
				structuredClone(change),
				"window",
				() => {},
			);
			pushChanged(renderer, "sidebar");
		},
		onChanged: (listener: Listener) => {
			renderer.listeners.add(listener);
			return () => renderer.listeners.delete(listener);
		},
	};
	renderers.push(renderer);
	vi.resetModules();
	const module = await as(renderer, () => import("./sidebar-prefs"));
	renderer.store = module.useSidebarPrefs;
	await as(renderer, () => renderer.store.getState().hydrate());
	return renderer;
}

function storedSidebar(): Record<string, unknown> {
	return (stored.get("sidebar") ?? {}) as Record<string, unknown>;
}

afterEach(() => {
	stored.clear();
	renderers.length = 0;
	wholeBlobWrites.length = 0;
	current = null;
});

describe("sidebar prefs shared by two renderers", () => {
	it("keeps the order one set when the other, hydrated earlier, records a workspace", async () => {
		stored.set("sidebar", { sessionOrder: { "/work/a": ["/s/1.jsonl", "/s/2.jsonl"] }, pinnedGroups: ["/work/a"] });
		const desktop = await openRenderer("desktop");
		const phone = await openRenderer("phone");

		await as(desktop, () => desktop.store.getState().setSessionOrder("/work/a", ["/s/2.jsonl", "/s/1.jsonl"]));
		await as(phone, async () => phone.store.getState().touchWorkspace("/work/b"));

		expect(storedSidebar().sessionOrder).toEqual({ "/work/a": ["/s/2.jsonl", "/s/1.jsonl"] });
		expect(Object.keys(storedSidebar().workspaceLastUsed as object)).toEqual(["/work/b"]);
		await vi.waitFor(() => {
			for (const renderer of [desktop, phone]) {
				expect(renderer.store.getState().sessionOrder, renderer.name).toEqual({
					"/work/a": ["/s/2.jsonl", "/s/1.jsonl"],
				});
			}
		});
		await vi.waitFor(() => expect(Object.keys(desktop.store.getState().workspaceLastUsed)).toEqual(["/work/b"]));
		expect(wholeBlobWrites).toEqual([]);
	});

	it("keeps both pins when two renderers pin different sessions from their own copies", async () => {
		const desktop = await openRenderer("desktop");
		const phone = await openRenderer("phone");

		await as(desktop, () => desktop.store.getState().toggleSessionPin("/s/1.jsonl"));
		await as(phone, () => phone.store.getState().toggleSessionPin("/s/2.jsonl"));

		expect(storedSidebar().pinnedSessions).toEqual(["/s/1.jsonl", "/s/2.jsonl"]);
		await vi.waitFor(() => {
			for (const renderer of [desktop, phone]) {
				expect(renderer.store.getState().pinnedSessions, renderer.name).toEqual(["/s/1.jsonl", "/s/2.jsonl"]);
			}
		});
		expect(wholeBlobWrites).toEqual([]);
	});

	it("keeps showing a change of its own that main has not processed yet while another page's change arrives", async () => {
		const desktop = await openRenderer("desktop");
		const phone = await openRenderer("phone");

		const gate = Promise.withResolvers<void>();
		desktop.hold = gate.promise;
		const ordering = as(desktop, () =>
			desktop.store.getState().setSessionOrder("/work/a", ["/s/2.jsonl", "/s/1.jsonl"]),
		);
		await as(phone, () => phone.store.getState().toggleSessionPin("/s/3.jsonl"));
		for (let tick = 0; tick < 20; tick++) await Promise.resolve();

		// The phone's pin reached the desktop, whose own order is still on its way to main: a read now would drop it.
		expect(desktop.store.getState().sessionOrder).toEqual({ "/work/a": ["/s/2.jsonl", "/s/1.jsonl"] });

		gate.resolve();
		await ordering;
		await vi.waitFor(() => {
			expect(desktop.store.getState().pinnedSessions).toEqual(["/s/3.jsonl"]);
			expect(desktop.store.getState().sessionOrder).toEqual({ "/work/a": ["/s/2.jsonl", "/s/1.jsonl"] });
			expect(phone.store.getState().sessionOrder).toEqual({ "/work/a": ["/s/2.jsonl", "/s/1.jsonl"] });
		});
		expect(storedSidebar().sessionOrder).toEqual({ "/work/a": ["/s/2.jsonl", "/s/1.jsonl"] });
		expect(storedSidebar().pinnedSessions).toEqual(["/s/3.jsonl"]);
	});
});
