import { parseHTML } from "linkedom";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentProgress, RpcCommand } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import type { SubagentNode } from "../../stores/subagents";
import { useSubagentsStore } from "../../stores/subagents";
import { toolEntriesState, useToolsStore } from "../../stores/tools";

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
const command = vi.fn(async (request: RpcCommand) => ({
	type: "response" as const,
	command: request.type,
	success: true as const,
	data: { messages: [] },
}));
Object.assign(window as unknown as Record<string, unknown>, {
	requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	omp: { rpc: { command } },
});
// Load React DOM and the component after linkedom installs the browser globals.
const { createRoot } = await import("react-dom/client");
const { WorkMap } = await import("./WorkMap");
let root: Root;
let container: HTMLElement;

function progress(id: string, overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		id,
		index: 0,
		agent: "scout",
		agentSource: "bundled",
		status: "running",
		task: "Raw model prompt",
		recentTools: [],
		recentOutput: [],
		toolCount: 1,
		requests: 1,
		tokens: 12,
		cost: 0,
		durationMs: 2000,
		currentTool: "read",
		currentToolArgs: JSON.stringify({ path: "src/alpha.ts" }),
		currentToolIntent: "Inspecting the implementation",
		...overrides,
	};
}
function node(id: string, index: number, overrides: Partial<SubagentNode> = {}): SubagentNode {
	return {
		id,
		index,
		agent: "scout",
		status: "running",
		description: "Reviewing the component",
		lastUpdate: 0,
		parentToolCallId: "task",
		progress: progress(id),
		...overrides,
	};
}
function Harness({ motion = true, active = true }: { motion?: boolean; active?: boolean }) {
	const [expanded, setExpanded] = useState<string | null>(null);
	return (
		<WorkMap
			toolCallIds={["task"]}
			active={active}
			motion={motion}
			expanded={expanded}
			onExpandedChange={setExpanded}
		/>
	);
}
async function render(motion = true, active = true) {
	await act(async () =>
		root.render(
			<I18nProvider>
				<Harness motion={motion} active={active} />
			</I18nProvider>,
		),
	);
}
function buttons() {
	return [...container.querySelectorAll<HTMLButtonElement>(".omp-work-card-button")];
}
async function click(index: number) {
	await act(async () => buttons()[index]?.click());
}

beforeEach(() => {
	command.mockClear();
	useToolsStore.setState(
		toolEntriesState([
			[
				"task",
				{
					toolName: "task",
					args: {},
					streamingArgs: "",
					result: undefined,
					isError: false,
					endTime: null,
					status: "running",
					startTime: 1,
				},
			],
		]),
	);
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	useSubagentsStore.getState().reset();
	useToolsStore.getState().reset();
	Reflect.deleteProperty(window, "matchMedia");
	vi.unstubAllGlobals();
});

describe("concurrent worker lanes", () => {
	it("keeps all eight lanes in spawn order as activity and progress change without remounting rows", async () => {
		useSubagentsStore
			.getState()
			.setSnapshots(Array.from({ length: 8 }, (_, index) => node(`Worker${7 - index}`, 7 - index)));
		await render();
		expect(buttons().map(button => button.querySelector(".omp-work-card-name")?.textContent)).toEqual(
			Array.from({ length: 8 }, (_, index) => `Worker${index}`),
		);
		const row = buttons()[0];
		const activity = row?.querySelector(".omp-work-card-activity-text");
		expect(row?.textContent).toContain("Inspecting the implementation");
		expect(row?.textContent).toContain("src/alpha.ts");
		expect(row?.textContent).toContain("1 tool · 12 tokens");
		expect(row?.textContent).toContain("2s");
		expect(container.textContent).not.toContain("Raw model prompt");
		useSubagentsStore.getState().setSnapshots(
			Array.from({ length: 8 }, (_, index) =>
				node(`Worker${index}`, index, {
					progress: progress(`Worker${index}`, {
						currentTool: "bash",
						currentToolArgs: JSON.stringify({ command: "bun test" }),
						currentToolIntent: "Running component tests",
						toolCount: 2,
						durationMs: 5000,
					}),
				}),
			),
		);
		await render();
		expect(buttons()[0]).toBe(row);
		expect(row?.querySelector(".omp-work-card-activity-text")).not.toBe(activity);
		expect(row?.textContent).toContain("Running component tests");
		expect(row?.textContent).toContain("2 tools · 12 tokens");
		expect(row?.textContent).toContain("5s");
		const currentActivity = row?.querySelector(".omp-work-card-activity-text");
		useSubagentsStore.getState().setSnapshots([
			node("Worker0", 0, {
				progress: progress("Worker0", {
					currentTool: "bash",
					currentToolArgs: JSON.stringify({ command: "bun test" }),
					currentToolIntent: "Running component tests",
					toolCount: 3,
					durationMs: 6000,
				}),
			}),
		]);
		await render();
		expect(row?.querySelector(".omp-work-card-activity-text")).toBe(currentActivity);
	});

	it("settles into conclusions and uses the shared failure and cancellation marks", async () => {
		useSubagentsStore.getState().setSnapshots([
			node("Complete", 0, {
				status: "completed",
				progress: progress("Complete", {
					extractedToolData: { yield: [{ data: { summary: "Component tests pass." } }] },
				}),
			}),
			node("Failed", 1, { status: "failed", progress: undefined }),
			node("Cancelled", 2, { status: "cancelled", progress: undefined }),
		]);
		await render();
		expect(buttons()[0]?.textContent).toContain("Component tests pass.");
		expect(buttons().map(button => button.querySelector(".omp-work-status")?.getAttribute("data-state"))).toEqual([
			"complete",
			"failed",
			"stopped",
		]);
		expect(buttons()[1]?.querySelector(".omp-work-card-activity")?.textContent).toBe("Work failed");
		expect(buttons()[2]?.querySelector(".omp-work-card-activity")?.textContent).toBe("Work interrupted");
	});

	it.each([
		["en", "Work interrupted", "Interrupted", "no turn"],
		["ko", "작업이 중단됐어요", "중단됨", "턴 없음"],
	])("labels aborted and stale workers as interrupted in %s", async (language, activity, abortedLabel, staleLabel) => {
		vi.stubGlobal("localStorage", { getItem: () => language, setItem: vi.fn() });
		useSubagentsStore
			.getState()
			.setSnapshots([
				node("Aborted", 0, { status: "aborted", progress: undefined }),
				node("Stale", 1, { status: "stale", progress: undefined }),
			]);
		await render();
		expect(buttons().map(button => button.querySelector(".omp-work-card-activity")?.textContent)).toEqual([
			activity,
			activity,
		]);
		expect(buttons().map(button => button.querySelector(".omp-work-status")?.getAttribute("data-state"))).toEqual([
			"stopped",
			"stopped",
		]);
		expect(buttons().map(button => button.querySelector(".omp-work-status")?.getAttribute("aria-label"))).toEqual([
			abortedLabel,
			staleLabel,
		]);
		await click(0);
		expect(useSubagentsStore.getState().eventConsumers).toBe(0);
		expect(command.mock.calls.some(([request]) => request.type === "set_subagent_subscription")).toBe(false);
	});

	it("preserves the queued ring and localizes the pending status label", async () => {
		useSubagentsStore.getState().setSnapshots([node("Queued", 0, { status: "pending", progress: undefined })]);
		await render();
		const mark = buttons()[0]?.querySelector(".omp-work-status");
		expect(mark?.getAttribute("data-state")).toBe("pending");
		expect(mark?.getAttribute("aria-label")).toBe("pending");
		expect(mark?.classList.contains("omp-work-pulse")).toBe(false);
		await click(0);
		expect(useSubagentsStore.getState().eventConsumers).toBe(1);
	});

	it("selects one lane in the stage and releases the unchanged event lease", async () => {
		useSubagentsStore.getState().setSnapshots([node("First", 0), node("Second", 1)]);
		await render();
		expect(command).not.toHaveBeenCalled();
		await click(0);
		expect(buttons()[0]?.getAttribute("aria-current")).toBe("true");
		expect(useSubagentsStore.getState().eventConsumers).toBe(1);
		expect(command).toHaveBeenCalledWith({ type: "set_subagent_subscription", level: "events" }, undefined);
		await click(1);
		expect(buttons().map(button => button.getAttribute("aria-current"))).toEqual([null, "true"]);
		expect(useSubagentsStore.getState().eventConsumers).toBe(1);
		expect(container.querySelector(".omp-work-lane-surface")).toBeNull();
		await click(1);
		expect(useSubagentsStore.getState().eventConsumers).toBe(0);
		expect(command).toHaveBeenLastCalledWith({ type: "set_subagent_subscription", level: "progress" }, undefined);
	});

	it("closes immediately and keeps activity static when reduced motion is requested", async () => {
		Object.assign(window as unknown as Record<string, unknown>, {
			matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
		});
		useSubagentsStore.getState().setSnapshots([node("First", 0)]);
		await render();
		expect(container.querySelector(".omp-work-card")?.getAttribute("data-motion")).toBe("false");
		await click(0);
		await click(0);
		expect(container.querySelector(".omp-work-lane-surface")).toBeNull();
	});

	it("never leases events for an inactive work map", async () => {
		useSubagentsStore.getState().setSnapshots([node("First", 0)]);
		await render(false, false);
		await click(0);
		expect(useSubagentsStore.getState().eventConsumers).toBe(0);
		expect(command.mock.calls.some(([request]) => request.type === "set_subagent_subscription")).toBe(false);
	});

	it("uses whole-second live lane clocks and precise finished durations", async () => {
		useSubagentsStore.getState().setSnapshots([
			node("Fresh", 0, { progress: progress("Fresh", { durationMs: 300 }) }),
			node("Running", 1, { progress: progress("Running", { durationMs: 3400 }) }),
			node("Finished", 2, {
				status: "completed",
				progress: progress("Finished", { status: "completed", durationMs: 810 }),
			}),
		]);
		await render();
		const elapsed = [...container.querySelectorAll(".omp-work-card-elapsed")].map(element => element.textContent);
		expect(elapsed).toEqual(["", " · 3s", " · 810ms"]);
	});
});
