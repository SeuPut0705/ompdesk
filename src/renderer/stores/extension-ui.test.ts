/**
 * The extension-UI reducer every tab bundle runs (`applyExtensionUiRequest`): status texts, widgets and the title
 * replace or clear their key, a `cancel` takes the card and its arrival time away, a question queues behind the
 * open ones with its arrival time, and a sign-in page's host is kept for the paste card that names no provider.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionUIRequest } from "../../shared/rpc-types";
import { applyExtensionUiRequest, type ExtensionUiSnapshot, openUrlTarget } from "./extension-ui";

const viewer = vi.hoisted(() => ({ web: false }));
vi.mock("../web/pwa", () => ({ webPwa: () => (viewer.web ? {} : null) }));
afterEach(() => {
	viewer.web = false;
});

const empty: ExtensionUiSnapshot = {
	pendingRequests: [],
	arrivedAt: {},
	statusWidgets: {},
	widgetPanels: {},
	widgetPlacements: {},
	title: null,
	lastOpenUrlHost: null,
};

const req = (request: Record<string, unknown>) =>
	({ type: "extension_ui_request", ...request }) as unknown as ExtensionUIRequest;
const apply = (snapshot: ExtensionUiSnapshot, ...requests: ExtensionUIRequest[]) =>
	requests.reduce((state, request, index) => applyExtensionUiRequest(state, request, 1000 + index), snapshot);

describe("applyExtensionUiRequest", () => {
	it("keeps the latest status per key and clears a key sent without text", () => {
		const shown = apply(
			empty,
			req({ id: "1", method: "setStatus", statusKey: "lint", statusText: "checking" }),
			req({ id: "2", method: "setStatus", statusKey: "lint", statusText: "clean" }),
			req({ id: "3", method: "setStatus", statusKey: "git", statusText: "main" }),
		);
		expect(shown.statusWidgets).toEqual({ lint: "clean", git: "main" });
		expect(apply(shown, req({ id: "4", method: "setStatus", statusKey: "lint" })).statusWidgets).toEqual({
			git: "main",
		});
		// Status traffic never becomes a card.
		expect(shown.pendingRequests).toEqual([]);
	});

	it("places a widget above the editor unless it asks for below, and clears it with its placement", () => {
		const shown = apply(
			empty,
			req({ id: "1", method: "setWidget", widgetKey: "plan", widgetLines: ["a"] }),
			req({ id: "2", method: "setWidget", widgetKey: "todo", widgetLines: ["b"], widgetPlacement: "belowEditor" }),
			req({ id: "3", method: "setWidget", widgetKey: "odd", widgetLines: ["c"], widgetPlacement: "sideways" }),
		);
		expect(shown.widgetPlacements).toEqual({ plan: "aboveEditor", todo: "belowEditor", odd: "aboveEditor" });
		const cleared = apply(shown, req({ id: "4", method: "setWidget", widgetKey: "todo", widgetLines: [] }));
		expect(Object.keys(cleared.widgetPanels)).toEqual(["plan", "odd"]);
		expect(cleared.widgetPlacements).not.toHaveProperty("todo");
	});

	it("queues a question behind the open ones with its arrival time, and a cancel takes both away", () => {
		const asked = apply(
			empty,
			req({ id: "a", method: "confirm", title: "Deploy?", message: "" }),
			req({ id: "b", method: "input", title: "Name" }),
		);
		expect(asked.pendingRequests.map(request => request.id)).toEqual(["a", "b"]);
		expect(asked.arrivedAt).toEqual({ a: 1000, b: 1001 });
		const cancelled = apply(asked, req({ id: "c", method: "cancel", targetId: "a" }));
		expect(cancelled.pendingRequests.map(request => request.id)).toEqual(["b"]);
		expect(cancelled.arrivedAt).toEqual({ b: 1001 });
		// A cancel for a card already gone changes nothing.
		expect(apply(cancelled, req({ id: "d", method: "cancel", targetId: "zz" })).pendingRequests).toHaveLength(1);
	});

	it("keeps the title per tab and a sign-in page's host, and no host for an address that does not parse", () => {
		const titled = apply(empty, req({ id: "1", method: "setTitle", title: "Review" }));
		expect(titled.title).toBe("Review");
		const opened = apply(titled, req({ id: "2", method: "open_url", url: "https://auth.example.com/login?x=1" }));
		expect(opened.lastOpenUrlHost).toBe("auth.example.com");
		expect(opened.pendingRequests.map(request => request.id)).toEqual(["2"]);
		expect(apply(opened, req({ id: "3", method: "open_url", url: "not a url" })).lastOpenUrlHost).toBeNull();
	});

	it("never changes the snapshot it was given", () => {
		const before = structuredClone(empty);
		apply(
			empty,
			req({ id: "1", method: "setStatus", statusKey: "k", statusText: "v" }),
			req({ id: "2", method: "input" }),
		);
		expect(empty).toEqual(before);
	});
});

describe("openUrlTarget", () => {
	const open = req({
		id: "1",
		method: "open_url",
		url: "https://provider.example/authorize",
		launchUrl: "http://localhost:51121/launch",
	}) as Extract<ExtensionUIRequest, { method: "open_url" }>;

	it("opens omp's local launch page on this computer and the provider's page for a paired host's tab", () => {
		expect(openUrlTarget(open, false)).toBe("http://localhost:51121/launch");
		// The host's localhost is not this device's.
		expect(openUrlTarget(open, true)).toBe("https://provider.example/authorize");
		expect(openUrlTarget({ ...open, launchUrl: undefined }, false)).toBe("https://provider.example/authorize");
	});

	it("never opens the host's loopback launch page in a web viewer, regardless of the tab's device", () => {
		viewer.web = true;
		expect(openUrlTarget(open, false)).toBe("https://provider.example/authorize");
		expect(openUrlTarget(open, true)).toBe("https://provider.example/authorize");
		expect(openUrlTarget({ ...open, launchUrl: undefined }, false)).toBe("https://provider.example/authorize");
	});
});
