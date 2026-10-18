import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../lib/i18n";
import { useSubagentsStore } from "../../../stores/subagents";
import { useTabsStore } from "../../../stores/tabs";
import { useTodoStore } from "../../../stores/todo";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});
const getJobs = vi.fn(async () => ({ type: "response", command: "get_jobs", success: true, data: { jobs: [] } }));
Reflect.set(window, "omp", { rpc: { getJobs }, prefs: { get: vi.fn(async () => undefined), set: vi.fn() } });

const { createRoot } = await import("react-dom/client");
const { WorkBoardChip } = await import("./WorkBoardChip");

let container: HTMLElement;
let root: Root;

async function mount(): Promise<void> {
	useTabsStore.setState({
		tabs: [{ id: "t1", cwd: "/w", status: "ready", kind: "agent", unreadDone: false }],
		activeTabId: "t1",
		bundles: new Map(),
	});
	await act(async () => {
		root.render(
			<I18nProvider>
				<WorkBoardChip>{null}</WorkBoardChip>
			</I18nProvider>,
		);
	});
}

beforeEach(() => {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	useTodoStore.getState().reset();
	useSubagentsStore.getState().reset();
});

describe("WorkBoardChip, the phone's work strip", () => {
	it("shows nothing when there is nothing to say", async () => {
		await mount();
		expect(container.querySelector("[data-work-chip]")).toBeNull();
	});

	it("says the plan's progress with the current task, and counts running subagents", async () => {
		useTodoStore.getState().setPhases([
			{
				name: "Fix",
				tasks: [
					{ content: "Reproduce", status: "completed" },
					{ content: "Wait for the row", status: "in_progress" },
					{ content: "Run the suite", status: "pending" },
				],
			},
		]);
		useSubagentsStore.getState().setSnapshots([
			{ id: "a1", index: 1, agent: "scout", status: "running", lastUpdate: Date.now() },
			{ id: "a2", index: 2, agent: "worker", status: "running", lastUpdate: Date.now() },
		]);
		await mount();
		const strip = container.querySelector("[data-work-chip]");
		expect(strip?.textContent).toContain("1/3");
		expect(strip?.textContent).toContain("Wait for the row");
		expect(strip?.querySelector('[data-count="agents"]')?.textContent).toBe("2");
		expect(strip?.querySelector('[data-count="jobs"]')).toBeNull();
		// The live region still carries the spoken label.
		expect(strip?.querySelector('[role="status"] .sr-only')?.textContent).toBe("1 of 3 done");
	});
});
