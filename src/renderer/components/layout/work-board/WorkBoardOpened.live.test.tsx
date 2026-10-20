import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../lib/i18n";
import type { OpenedChildRow } from "./opened-children";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const command = vi.fn(async (_command: { type: string; live?: boolean }) => ({
	type: "response",
	success: true,
	data: null,
}));
Reflect.set(window, "omp", { rpc: { command } });

// Imported after the DOM globals exist (React DOM reads them at load), as the other board tests do.
const { createRoot } = await import("react-dom/client");
const { OpenedSection, LIVE_REVIEW_MS } = await import("./WorkBoardOpened");

const row = (status: OpenedChildRow["status"]): OpenedChildRow => ({ key: "c1", tabId: "c1", title: "Kid", status });
const counts = { total: 1, running: 1, waiting: 0, done: 0, closed: 0 };

let root: Root;

function setVisibility(state: "visible" | "hidden"): void {
	Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
	document.dispatchEvent(new Event("visibilitychange"));
}

async function mount(rows: OpenedChildRow[]): Promise<void> {
	await act(async () =>
		root.render(
			<I18nProvider>
				<OpenedSection counts={counts} now={Date.now()} rows={rows} />
			</I18nProvider>,
		),
	);
}

const asked = () => command.mock.calls.filter(([sent]) => sent.type === "agent_control_review" && sent.live).length;

beforeEach(() => {
	vi.useFakeTimers();
	command.mockClear();
	Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
	root = createRoot(document.createElement("div") as unknown as Element);
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.useRealTimers();
});

describe("a board showing the sessions this one opened", () => {
	it("asks main for a running child's step and cost while shown and in view, and stops when hidden or unmounted", async () => {
		await mount([row("running")]);
		await act(async () => vi.advanceTimersByTime(LIVE_REVIEW_MS * 3));
		expect(asked()).toBe(3);
		await act(async () => setVisibility("hidden"));
		await act(async () => vi.advanceTimersByTime(LIVE_REVIEW_MS * 5));
		expect(asked()).toBe(3);
		// Back in view: at once, then on the schedule.
		await act(async () => setVisibility("visible"));
		expect(asked()).toBe(4);
		await act(async () => root.unmount());
		root = createRoot(document.createElement("div") as unknown as Element);
		await act(async () => vi.advanceTimersByTime(LIVE_REVIEW_MS * 5));
		expect(asked()).toBe(4);
	});

	it("asks nothing while no child runs", async () => {
		await mount([row("done")]);
		await act(async () => vi.advanceTimersByTime(LIVE_REVIEW_MS * 5));
		expect(asked()).toBe(0);
	});
});
