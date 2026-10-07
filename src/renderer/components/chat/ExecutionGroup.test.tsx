import { parseHTML } from "linkedom";
import { act, type ReactNode, useState } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { type ToolEntry, toolEntriesState, useToolsStore } from "../../stores/tools";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = await import("react-dom/client");
const { ExecutionGroup } = await import("./ExecutionGroup");
const { ToolCard } = await import("../tools/ToolCard");

let container: HTMLElement;
let root: Root;

function toolEntry(status: "running" | "error", isError = false): ToolEntry {
	return {
		toolName: "bash",
		args: {},
		status,
		streamingArgs: "",
		result: null,
		isError,
		startTime: 1,
		endTime: status === "running" ? null : 2,
	};
}

function StatefulExecutionGroup({
	children,
	failureCount,
	live,
	toolCallIds,
}: {
	children: ReactNode;
	failureCount: number;
	live: boolean;
	toolCallIds: string[];
}) {
	const [expanded, setExpanded] = useState(false);
	return (
		<ExecutionGroup
			expanded={expanded}
			failureCount={failureCount}
			live={live}
			onExpandedChange={setExpanded}
			stepCount={2}
			toolCallIds={toolCallIds}
		>
			{children}
		</ExecutionGroup>
	);
}

async function mount(
	toolCallIds: string[] = [],
	live = false,
	children: ReactNode = <div data-testid="details">tool details</div>,
	failureCount = 0,
): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<StatefulExecutionGroup failureCount={failureCount} live={live} toolCallIds={toolCallIds}>
					{children}
				</StatefulExecutionGroup>
			</I18nProvider>,
		);
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	useToolsStore.getState().reset();
});

describe("ExecutionGroup", () => {
	it("keeps completed work to one summary line until requested", async () => {
		await mount();
		expect(container.textContent).toContain("2 steps complete");
		expect(container.querySelector('[data-testid="details"]')).toBeNull();

		await act(async () => {
			(container.querySelector("button") as unknown as { click: () => void }).click();
		});
		expect(container.querySelector('[data-testid="details"]')).not.toBeNull();
	});

	it("keeps failed work compact while preserving its error summary and details", async () => {
		useToolsStore.setState(toolEntriesState([["tool-1", toolEntry("error", true)]]));
		await mount(["tool-1"]);

		expect(container.textContent).toContain("1 failed · 2 steps");
		expect(container.querySelector('[data-testid="details"]')).toBeNull();

		await act(async () => {
			(container.querySelector("button") as unknown as { click: () => void }).click();
		});
		expect(container.querySelector('[data-testid="details"]')).not.toBeNull();
	});

	it("includes failed completion events in the existing group status", async () => {
		await mount([], false, undefined, 1);
		expect(container.textContent).toContain("1 failed · 2 steps");
		expect(container.querySelector('[data-state="failed"]')).not.toBeNull();
	});

	it("never overrides the user's disclosure while execution activity changes", async () => {
		useToolsStore.setState(toolEntriesState([["tool-1", toolEntry("running")]]));
		await mount(["tool-1"]);
		expect(container.querySelector('[data-testid="details"]')).toBeNull();

		await act(async () => {
			(container.querySelector("button") as unknown as { click: () => void }).click();
		});
		expect(container.querySelector('[data-testid="details"]')).not.toBeNull();

		await act(async () => {
			useToolsStore.setState(toolEntriesState([["tool-1", toolEntry("error", true)]]));
		});

		expect(container.textContent).toContain("1 failed · 2 steps");
		expect(container.querySelector('[data-testid="details"]')).not.toBeNull();

		await act(async () => {
			(container.querySelector("button") as unknown as { click: () => void }).click();
			useToolsStore.setState(toolEntriesState([["tool-1", toolEntry("running")]]));
		});
		expect(container.querySelector('[data-testid="details"]')).toBeNull();
	});

	it("keeps one animated status for a live group while running child steps remain visible", async () => {
		useToolsStore.setState(
			toolEntriesState([
				["tool-1", toolEntry("running")],
				["tool-2", toolEntry("running")],
			]),
		);
		await mount(
			["tool-1", "tool-2"],
			true,
			<>
				<ToolCard toolCallId="tool-1" toolName="edit" args={{}} runningIndicator="dot" />
				<ToolCard toolCallId="tool-2" toolName="bash" args={{ command: "bun check" }} runningIndicator="dot" />
			</>,
		);
		await act(async () => {
			(container.querySelector(".omp-execution-group-header") as unknown as { click: () => void }).click();
		});
		await act(async () => {
			for (const button of container.querySelectorAll(".omp-tool-header")) {
				(button as unknown as { click: () => void }).click();
			}
		});

		expect(container.querySelectorAll(".animate-spin, .animate-pulse")).toHaveLength(1);
		expect(container.querySelectorAll(".omp-tool-status-icon")).toHaveLength(2);
		expect(container.querySelector(".omp-execution-group-summary")?.textContent).toContain("2 running");
	});

	it("summarizes finished work by what it did, with the elapsed time", async () => {
		const done = (toolName: string, args: Record<string, unknown>, startTime: number, endTime: number) => ({
			...toolEntry("running"),
			toolName,
			args,
			status: "done" as const,
			startTime,
			endTime,
		});
		useToolsStore.setState(
			toolEntriesState([
				["read-1", done("read", { path: "src/a.ts" }, 1_000, 2_000)],
				["read-2", done("read", { path: "src/b.ts" }, 2_000, 3_000)],
				["edit-1", done("edit", { path: "src/a.ts" }, 3_000, 5_000)],
				["bash-1", done("bash", { command: "bun test" }, 5_000, 17_000)],
			]),
		);
		await mount(["read-1", "read-2", "edit-1", "bash-1"]);

		expect(container.textContent).toContain("Read 2 files · Edited 1 file · Ran 1 command");
		expect(container.textContent).toContain("16.0s");
		expect(container.querySelector('[data-state="complete"]')).not.toBeNull();
	});

	it("flows the running work through a fixed window under a collapsed live group, then drops it once finished", async () => {
		useToolsStore.setState(
			toolEntriesState([
				["read-1", { ...toolEntry("running"), toolName: "read", args: { path: "src/a.ts" }, status: "done" }],
			]),
		);
		await mount(["read-1", "bash-1"], true);

		const panel = container.querySelector(".omp-live-step");
		expect(panel).not.toBeNull();
		expect(panel?.getAttribute("aria-hidden")).toBe("true");
		expect(panel?.querySelector(".omp-live-step-scroll")).not.toBeNull();
		expect(panel?.textContent).toContain("a.ts");

		await act(async () => {
			useToolsStore.setState({
				...toolEntriesState([
					["read-1", { ...toolEntry("running"), toolName: "read", args: { path: "src/a.ts" }, status: "done" }],
					["bash-1", { ...toolEntry("running"), args: { command: "bun run check" }, startTime: 5 }],
				]),
				partialResults: new Map([
					["bash-1", { content: [{ type: "text", text: "step one\nstep two\n\nstep three\n" }] }],
				]),
			});
		});

		// Same window, earlier step still above, the command and its output appended below.
		expect(container.querySelector(".omp-live-step")).toBe(panel);
		expect(panel?.textContent).toContain("a.ts");
		expect(panel?.textContent).toContain("bun run check");
		expect(Array.from(panel?.querySelectorAll(".omp-live-step-output") ?? []).map(line => line.textContent)).toEqual([
			"step one",
			"step two",
			"step three",
		]);

		await act(async () => {
			useToolsStore.setState({
				...toolEntriesState([
					["read-1", { ...toolEntry("running"), toolName: "read", args: { path: "src/a.ts" }, status: "done" }],
					["bash-1", { ...toolEntry("running"), args: { command: "bun run check" }, startTime: 5 }],
				]),
				partialResults: new Map([
					["bash-1", { content: [{ type: "text", text: "step one\nstep two\n\nstep three\nstep four\n" }] }],
				]),
			});
		});
		expect(Array.from(panel?.querySelectorAll(".omp-live-step-output") ?? []).map(line => line.textContent)).toEqual([
			"step one",
			"step two",
			"step three",
			"step four",
		]);

		await act(async () => {
			root.render(
				<I18nProvider>
					<StatefulExecutionGroup failureCount={0} live={false} toolCallIds={["read-1", "bash-1"]}>
						<div data-testid="details">tool details</div>
					</StatefulExecutionGroup>
				</I18nProvider>,
			);
			useToolsStore.setState(
				toolEntriesState([
					["read-1", { ...toolEntry("running"), toolName: "read", args: { path: "src/a.ts" }, status: "done" }],
					["bash-1", { ...toolEntry("running"), args: { command: "bun run check" }, status: "done", endTime: 9 }],
				]),
			);
		});
		expect(container.querySelector(".omp-live-step")).toBeNull();
		expect(container.querySelector('[data-state="complete"]')).not.toBeNull();
	});
});
