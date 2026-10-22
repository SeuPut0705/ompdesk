import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSpend } from "../../../resources/gui-bridge/model-setup-contracts";
import { USAGE_POLL_MS } from "../lib/usage-reports";
import { useSessionStore } from "../stores/session";
import { useTabsStore } from "../stores/tabs";
import { useSessionSpend } from "./use-session-spend";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const spendOf = (cost: number): SessionSpend => ({
	providers: { openrouter: { billing: "metered", name: "OpenRouter", cost, today: cost } },
	billing: { openrouter: "metered" },
});

/** Each read waits until the test answers it, in the order asked. */
const pending: Array<(spend: SessionSpend) => void> = [];
const getSessionSpend = vi.fn(() => {
	const { promise, resolve } = Promise.withResolvers<{ success: true; data: SessionSpend }>();
	pending.push(spend => resolve({ success: true, data: spend }));
	return promise;
});
let shown: SessionSpend | null = null;

function Board() {
	shown = useSessionSpend();
	return null;
}

let root: Root;

beforeEach(() => {
	vi.useFakeTimers();
	pending.length = 0;
	getSessionSpend.mockClear();
	shown = null;
	Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
	Reflect.set(window, "omp", { rpc: { getSessionSpend } });
	useTabsStore.setState({ activeTabId: "tab-1" });
	useSessionStore.setState({ status: "ready", sessionId: "session-a" });
	root = createRoot(document.createElement("div") as unknown as Element);
});

afterEach(async () => {
	await act(async () => root.unmount());
	useSessionStore.setState({ status: "starting", sessionId: "" });
	vi.useRealTimers();
});

describe("useSessionSpend", () => {
	it("drops the old session's charge the moment the tab switches session, and its late reply never paints it back", async () => {
		await act(async () => root.render(<Board />));
		await act(async () => pending.shift()?.(spendOf(0.5)));
		expect(shown?.providers.openrouter?.cost).toBe(0.5);

		// A read of session A is on its way when the same ready tab switches to session B in place.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(USAGE_POLL_MS);
		});
		const lateForA = pending.shift();
		expect(lateForA).toBeDefined();
		await act(async () => useSessionStore.setState({ sessionId: "session-b" }));
		// B is read afresh at once, and nothing of A shows meanwhile.
		expect(shown).toBeNull();
		expect(getSessionSpend.mock.calls.length).toBeGreaterThanOrEqual(3);
		await act(async () => lateForA?.(spendOf(0.5)));
		expect(shown).toBeNull();
		await act(async () => pending.shift()?.(spendOf(0.02)));
		expect(shown?.providers.openrouter?.cost).toBe(0.02);
	});
});
