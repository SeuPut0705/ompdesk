import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../lib/i18n";
import { useAutopilotStore } from "../../../stores/autopilot";
import { useExtensionUiStore } from "../../../stores/extension-ui";
import { useSessionStore } from "../../../stores/session";
import { useSubagentsStore } from "../../../stores/subagents";
import { useTabsStore } from "../../../stores/tabs";
import { useTodoStore } from "../../../stores/todo";
import { useToolsStore } from "../../../stores/tools";

// The back gesture itself is lib/back-layer's (its own test); here only what a layer's close does to the strip.
const backLayer = vi.hoisted(() => ({ close: null as (() => void) | null }));
vi.mock("../../../hooks/use-back-layer", () => ({
	useBackLayer: (open: boolean, onClose: () => void) => {
		backLayer.close = open ? onClose : null;
	},
}));

const { document, window, Element, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Element,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});
const getJobs = vi.fn(async () => ({ type: "response", command: "get_jobs", success: true, data: { rows: [] } }));
Reflect.set(window, "omp", { rpc: { getJobs }, prefs: { get: vi.fn(async () => undefined), set: vi.fn() } });

const { createRoot } = await import("react-dom/client");
const { WorkBoardChip } = await import("./WorkBoardChip");

let container: HTMLElement;
let root: Root;

async function mount(children: ReactNode = null): Promise<void> {
	useTabsStore.setState({
		tabs: [{ id: "t1", cwd: "/w", status: "ready", kind: "agent", unreadDone: false }],
		activeTabId: "t1",
		bundles: new Map(),
	});
	await act(async () => {
		root.render(
			<I18nProvider>
				<WorkBoardChip>{children}</WorkBoardChip>
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
	useExtensionUiStore.setState({ pendingRequests: [] });
	useToolsStore.getState().reset();
});

describe("WorkBoardChip, the phone's work strip", () => {
	it("shows nothing when there is nothing to say", async () => {
		await mount();
		expect(container.querySelector("[data-work-chip]")).toBeNull();
	});

	it("marks its pane while it shows, for the dock rows that give way (perf: no :has() on the pane)", async () => {
		container.className = "omp-session-pane";
		await mount();
		expect(container.hasAttribute("data-work-board-strip")).toBe(false);
		await act(async () => useTodoStore.setState({ turnActive: true }));
		expect(container.querySelector("[data-work-chip]")).not.toBeNull();
		expect(container.hasAttribute("data-work-board-strip")).toBe(true);
		await act(async () => useTodoStore.setState({ turnActive: false }));
		expect(container.querySelector("[data-work-chip]")).toBeNull();
		expect(container.hasAttribute("data-work-board-strip")).toBe(false);
	});

	it("names a live Autopilot run and its cycle, never just its Goal, even with the run's plan open", async () => {
		useSessionStore.setState({ goal: { objective: "Autopilot: keep developing" }, goalState: { status: "active" } });
		useTodoStore.getState().setPhases([{ name: "Cycle", tasks: [{ content: "Reproduce", status: "in_progress" }] }]);
		useAutopilotStore.getState().apply({
			active: true,
			state: "running",
			cycle: 3,
			now: { n: 3, area: "bugs", startedAt: 1 },
			branch: "autopilot/2026-10-20",
		});
		try {
			await mount();
			const label = container.querySelector("[data-work-chip] [role=status]")?.textContent ?? "";
			expect(label).toContain("Autopilot");
			expect(label).toContain("Cycle 3");
		} finally {
			await act(async () => {
				useAutopilotStore.getState().reset();
				useSessionStore.getState().reset();
			});
		}
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

	it("says the figure Needs you counts, ahead of the plan's progress", async () => {
		useTodoStore.getState().setPhases([{ name: "Fix", tasks: [{ content: "Reproduce", status: "in_progress" }] }]);
		for (const id of ["c1", "c2"])
			useExtensionUiStore
				.getState()
				.pushRequest({ type: "extension_ui_request", id, method: "confirm", title: "Go?", message: "" });
		await mount();
		const strip = container.querySelector("[data-work-chip]");
		expect(strip?.querySelector('[role="status"]')?.textContent).toBe("2 need you");
		expect(strip?.getAttribute("data-state")).toBe("waiting");
		await act(async () => useExtensionUiStore.setState({ pendingRequests: [] }));
		expect(strip?.querySelector('[role="status"] .sr-only')?.textContent).toBe("0 of 1 done");
	});

	it("works only while a subagent is at work: a parked one is live but leaves the strip's pulse idle", async () => {
		useSubagentsStore
			.getState()
			.setSnapshots([{ id: "a1", index: 1, agent: "scout", status: "parked", lastUpdate: Date.now() }]);
		await mount();
		const strip = container.querySelector("[data-work-chip]");
		expect(strip?.getAttribute("data-state")).toBe("idle");
		await act(async () =>
			useSubagentsStore
				.getState()
				.setSnapshots([{ id: "a1", index: 1, agent: "scout", status: "running", lastUpdate: Date.now() }]),
		);
		expect(strip?.getAttribute("data-state")).toBe("working");
	});

	describe("expanding in place", () => {
		const rowTaps = vi.fn();
		async function mountPlan(): Promise<void> {
			useTodoStore.getState().setPhases([{ name: "Fix", tasks: [{ content: "Reproduce", status: "in_progress" }] }]);
			await mount(
				<ul>
					<li>
						<button className="omp-work-board-row" onClick={rowTaps} type="button">
							row
						</button>
					</li>
				</ul>,
			);
		}
		const strip = () => container.querySelector<HTMLElement>("[data-work-chip]");
		// A closing panel stays mounted for its 160 ms height transition, flagged `data-leaving` and inert.
		const panel = () => {
			const found = container.querySelector("[data-work-strip-panel]");
			return found?.hasAttribute("data-leaving") ? null : found;
		};
		const click = async (element: Element | null | undefined) => {
			await act(async () => {
				(element as HTMLElement | null | undefined)?.click();
			});
		};

		it("starts collapsed, expands on a tap and collapses on the next, with no scrim or sheet", async () => {
			await mountPlan();
			expect(panel()).toBeNull();
			expect(strip()?.getAttribute("aria-expanded")).toBe("false");
			await click(strip());
			expect(strip()?.getAttribute("aria-expanded")).toBe("true");
			expect(panel()).not.toBeNull();
			// Inline under the strip: the panel is inside the strip's own wrapper, and nothing dims the screen.
			expect(container.querySelector("[data-work-strip]")?.contains(panel())).toBe(true);
			expect(document.querySelector("[data-sheet-placement], [data-sheet-overlay], [data-scrim]")).toBeNull();
			expect(document.querySelector('[role="dialog"], [aria-modal="true"]')).toBeNull();
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			try {
				await click(strip());
				expect(strip()?.getAttribute("aria-expanded")).toBe("false");
				// It leaves the DOM once its exit transition is over.
				await act(async () => {
					await vi.advanceTimersByTimeAsync(220);
				});
			} finally {
				vi.useRealTimers();
			}
			expect(container.querySelector("[data-work-strip-panel]")).toBeNull();
		});

		it("collapses on a row tap after the row acted, but not on a fold toggle", async () => {
			rowTaps.mockClear();
			await mountPlan();
			await click(strip());
			await click(container.querySelector("button.omp-work-board-row"));
			expect(rowTaps).toHaveBeenCalledOnce();
			expect(panel()).toBeNull();
		});

		it("stays open for a row that expands in place (the memory row), so its titles can show", async () => {
			const expands = vi.fn();
			useTodoStore.getState().setPhases([{ name: "Fix", tasks: [{ content: "Reproduce", status: "in_progress" }] }]);
			await mount(
				<button className="omp-work-board-row" data-board-expands="" onClick={expands} type="button">
					memory
				</button>,
			);
			await click(strip());
			await click(container.querySelector("button[data-board-expands]"));
			expect(expands).toHaveBeenCalledOnce();
			expect(panel()).not.toBeNull();
			expect(strip()?.getAttribute("aria-expanded")).toBe("true");
		});

		it("collapses on a tap outside, and on the back gesture's layer", async () => {
			await mountPlan();
			await click(strip());
			await act(async () => {
				document.body.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
			});
			expect(panel()).toBeNull();
			await click(strip());
			expect(panel()).not.toBeNull();
			expect(backLayer.close).not.toBeNull();
			await act(async () => {
				backLayer.close?.();
			});
			expect(panel()).toBeNull();
		});
	});

	it("points its chevron the way the panel will open: upward from a strip low in its pane", async () => {
		const rects: Record<string, { top: number; bottom: number }> = {
			"omp-session-pane": { top: 48, bottom: 800 },
			"omp-work-strip": { top: 560, bottom: 600 },
			"omp-composer-box": { top: 690, bottom: 790 },
		};
		const original = Element.prototype.getBoundingClientRect;
		Element.prototype.getBoundingClientRect = function (this: Element) {
			const rect = Object.entries(rects).find(([name]) => this.classList?.contains(name))?.[1] ?? {
				top: 0,
				bottom: 0,
			};
			return { ...rect, left: 0, right: 0, width: 0, height: rect.bottom - rect.top, x: 0, y: rect.top } as DOMRect;
		};
		try {
			container.className = "omp-session-pane";
			const opens = () => container.querySelector("[data-work-chip]")?.getAttribute("data-opens");
			// Mounted with nothing to say, the strip renders nothing; the room is measured once it shows.
			await mount();
			expect(container.querySelector("[data-work-chip]")).toBeNull();
			await act(async () => useTodoStore.setState({ turnActive: true }));
			expect(opens()).toBe("up");
			// Gone and back, it is measured again where it shows now.
			await act(async () => useTodoStore.setState({ turnActive: false }));
			expect(container.querySelector("[data-work-chip]")).toBeNull();
			rects["omp-work-strip"] = { top: 60, bottom: 100 };
			await act(async () => useTodoStore.setState({ turnActive: true }));
			expect(opens()).toBeNull();
		} finally {
			Element.prototype.getBoundingClientRect = original;
			container.className = "";
		}
	});
});
