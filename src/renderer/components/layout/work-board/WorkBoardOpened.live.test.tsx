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
const { OpenedSection } = await import("./WorkBoardOpened");
const { LIVE_REVIEW_MS } = await import("../../../hooks/use-live-review");

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

describe("what each child is doing, under its title", () => {
	const container = () => document.body.lastElementChild as unknown as HTMLElement;
	async function show(rows: OpenedChildRow[]) {
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host as unknown as Element);
		await mount(rows);
	}
	const activity = (key: string) =>
		container().querySelector(`[data-board-opened="${key}"] [data-board-child-activity]`)?.textContent ?? null;
	const label = (key: string) =>
		container().querySelector(`[data-board-opened="${key}"] .truncate`)?.textContent ?? null;

	it("shows a running child's step, a waiting one's question and a finished one's report, title first", async () => {
		await show([
			{ ...row("running"), key: "r", step: "bun run check:changed" },
			{
				...row("waiting"),
				key: "w",
				title: "Asker",
				report: { kind: "question", text: "Should a failed bump open an issue\nor only log it?", at: 1 },
			},
			{ ...row("done"), key: "d", title: "Finisher", report: { kind: "done", text: "Fixed the flake.", at: 1 } },
			{ ...row("running"), key: "q", title: "Quiet" },
		]);
		expect(label("r")).toBe("Kid");
		expect(activity("r")).toBe("bun run check:changed");
		expect(activity("w")).toBe("Should a failed bump open an issue or only log it?");
		expect(activity("d")).toBe("Fixed the flake.");
		// Nothing said yet: no empty second line.
		expect(activity("q")).toBeNull();
	});

	it("follows the step main pushes, with nothing of its own to poll", async () => {
		await show([{ ...row("running"), step: "Editing Sidebar.tsx" }]);
		expect(activity("c1")).toBe("Editing Sidebar.tsx");
		await mount([{ ...row("running"), step: "bun run check:changed" }]);
		expect(activity("c1")).toBe("bun run check:changed");
	});
});
