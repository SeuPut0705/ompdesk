/** The phone page's lost link, as the title bar shows it (link-status.ts). */
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LINK_NOTICE_GRACE_MS } from "../../shared/link-notice";
import type { WebRuntime } from "./runtime";
import type { WsConnectionState } from "./ws-transport";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });

// After the DOM globals: react-dom reads `document`/`window` when it loads.
const { createRoot } = await import("react-dom/client");

let root: Root | undefined;
let state: WsConnectionState = "open";
const listeners = new Set<(next: WsConnectionState) => void>();

/** A fresh module (its watch is once per page) under a page whose link starts in `initial`; null = a desktop window. */
async function load(initial: WsConnectionState | null) {
	vi.resetModules();
	listeners.clear();
	const runtime = await import("./runtime");
	if (initial !== null) {
		state = initial;
		runtime.setWebRuntime({
			connectionState: () => state,
			onConnectionState: listener => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		} as Partial<WebRuntime> as WebRuntime);
	}
	return import("./link-status");
}

async function show(useWebLinkLost: () => string | null): Promise<() => string> {
	function Probe() {
		return <span data-lost={useWebLinkLost() ?? "none"} />;
	}
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () => root?.render(<Probe />));
	return () => document.body.querySelector("[data-lost]")?.getAttribute("data-lost") ?? "";
}

const set = (next: WsConnectionState) =>
	act(async () => {
		state = next;
		for (const listener of listeners) listener(next);
	});
const pass = (ms: number) =>
	act(async () => {
		vi.advanceTimersByTime(ms);
	});

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	vi.useRealTimers();
});

describe("useWebLinkLost", () => {
	it("says nothing for a drop that heals inside the grace", async () => {
		const lost = await show((await load("open")).useWebLinkLost);
		await set("reconnecting");
		await pass(LINK_NOTICE_GRACE_MS - 1);
		expect(lost()).toBe("none");
		await set("open");
		await pass(60_000);
		expect(lost()).toBe("none");
	});

	it("says reconnecting once the link has stayed down past the grace, until the moment it is back", async () => {
		const lost = await show((await load("open")).useWebLinkLost);
		await set("reconnecting");
		await pass(LINK_NOTICE_GRACE_MS);
		expect(lost()).toBe("reconnecting");
		await pass(60_000);
		expect(lost()).toBe("reconnecting");
		await set("open");
		expect(lost()).toBe("none");
	});

	it("says connecting for a first connection that takes past the grace, and waits it out first", async () => {
		const lost = await show((await load("connecting")).useWebLinkLost);
		await pass(LINK_NOTICE_GRACE_MS - 1);
		expect(lost()).toBe("none");
		await pass(1);
		expect(lost()).toBe("connecting");
	});

	it("shows at once in a view that mounts during a long outage", async () => {
		const module = await load("open");
		const first = await show(module.useWebLinkLost);
		await set("reconnecting");
		await pass(30_000);
		expect(first()).toBe("reconnecting");
		await act(async () => root?.unmount());
		document.body.innerHTML = "";
		expect(await show(module.useWebLinkLost).then(read => read())).toBe("reconnecting");
	});

	it("says nothing for an unpaired or outdated page (it navigates or reloads itself) or in a desktop window", async () => {
		const lost = await show((await load("open")).useWebLinkLost);
		await set("unpaired");
		await pass(60_000);
		expect(lost()).toBe("none");
		await act(async () => root?.unmount());
		document.body.innerHTML = "";
		const desktop = await show((await load(null)).useWebLinkLost);
		await pass(60_000);
		expect(desktop()).toBe("none");
	});
});
