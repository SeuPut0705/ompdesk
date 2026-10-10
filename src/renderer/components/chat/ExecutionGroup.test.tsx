import { parseHTML } from "linkedom";
import { act, type ReactNode, useState } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { useMessagesStore } from "../../stores/messages";
import { useSubagentsStore } from "../../stores/subagents";
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

let frameId = 0;
const frames = new Map<number, FrameRequestCallback>();
Object.assign(window, {
	requestAnimationFrame: (callback: FrameRequestCallback) => {
		const id = ++frameId;
		frames.set(id, callback);
		return id;
	},
	cancelAnimationFrame: (id: number) => frames.delete(id),
});

async function flushFrame() {
	const pending = [...frames.values()];
	frames.clear();
	await act(async () => {
		for (const callback of pending) callback(0);
	});
}

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
	useMessagesStore.getState().reset();
	useSubagentsStore.getState().reset();
	frames.clear();
});

describe("ExecutionGroup", () => {
	it("uses singular English for a one-step running group", async () => {
		useToolsStore.setState(toolEntriesState([["one", toolEntry("running")]]));
		await mount(["one"], true);
		await act(async () => {
			root.render(
				<I18nProvider>
					<ExecutionGroup expanded={false} onExpandedChange={() => {}} stepCount={1} toolCallIds={["one"]} live>
						<div />
					</ExecutionGroup>
				</I18nProvider>,
			);
		});
		expect(container.querySelector(".omp-execution-group-summary")?.textContent).toBe("1 running · 1 step");
	});

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

	it("switches surfaces, appends streamed bash output, and collapses after completion", async () => {
		useToolsStore.setState(
			toolEntriesState([
				["read-1", { ...toolEntry("running"), toolName: "read", args: { path: "src/a.ts" }, status: "done" }],
			]),
		);
		await mount(["read-1", "bash-1"], true);
		const panel = container.querySelector(".omp-live-step");
		expect(panel?.getAttribute("aria-hidden")).toBeNull();
		expect(panel?.getAttribute("data-surface")).toBe("read");
		expect(panel?.textContent).toContain("a.ts");
		await act(async () => {
			useToolsStore.setState({
				...toolEntriesState([
					["read-1", { ...toolEntry("running"), toolName: "read", args: { path: "src/a.ts" }, status: "done" }],
					["bash-1", { ...toolEntry("running"), args: { command: "bun run check" }, startTime: 5 }],
				]),
				partialResults: new Map([["bash-1", { content: [{ type: "text", text: "step one\nstep two\n" }] }]]),
			});
		});
		await flushFrame();
		expect(panel?.getAttribute("data-surface")).toBe("bash");
		expect(panel?.querySelector(".omp-bash-terminal")?.textContent).toContain("step one\nstep two");
		await act(async () => {
			useToolsStore.setState({
				partialResults: new Map([
					["bash-1", { content: [{ type: "text", text: "step one\nstep two\nstep three\n" }] }],
				]),
			});
		});
		await flushFrame();
		expect(panel?.querySelector(".omp-bash-terminal")?.textContent).toContain("step one\nstep two\nstep three");
		expect(panel?.querySelector(".omp-live-step-scroll")?.textContent).not.toContain("a.ts");
		await act(async () => {
			root.render(
				<I18nProvider>
					<StatefulExecutionGroup failureCount={0} live={false} toolCallIds={["read-1", "bash-1"]}>
						<div />
					</StatefulExecutionGroup>
				</I18nProvider>,
			);
			useToolsStore.setState(
				toolEntriesState([
					["read-1", { ...toolEntry("running"), toolName: "read", status: "done" }],
					["bash-1", { ...toolEntry("running"), status: "done", endTime: 9 }],
				]),
			);
		});
		expect(container.querySelector(".omp-live-step")).toBeNull();
	});

	it("replays a past step and resumes live following using keyboard-reachable controls", async () => {
		useToolsStore.setState(
			toolEntriesState([
				[
					"read",
					{
						...toolEntry("running"),
						toolName: "read",
						args: { path: "src/a.ts" },
						status: "done",
						result: { content: [{ type: "text", text: "read contents" }] },
					},
				],
				["bash", { ...toolEntry("running"), args: { command: "bun test" }, startTime: 5 }],
			]),
		);
		await mount(["read", "bash"], true);
		await act(async () => {
			container.querySelector<HTMLButtonElement>('[data-step-id="read"]')?.click();
		});
		expect(container.querySelector(".omp-live-step")?.getAttribute("data-surface")).toBe("read");
		expect(container.querySelector(".omp-live-step")?.getAttribute("data-following")).toBe("false");
		await act(async () => {
			container.querySelector<HTMLButtonElement>(".omp-live-work-follow")?.click();
		});
		expect(container.querySelector(".omp-live-step")?.getAttribute("data-surface")).toBe("bash");
		expect(container.querySelector(".omp-live-step")?.getAttribute("data-following")).toBe("true");
		expect(container.querySelectorAll(".omp-live-work-strip button")).toHaveLength(3);
	});

	it("collapses consecutive identical waits to one elapsed line and one chip", async () => {
		useToolsStore.setState(
			toolEntriesState([
				[
					"wait-1",
					{ ...toolEntry("running"), toolName: "wait", args: { i: "background activity" }, status: "done" },
				],
				["wait-2", { ...toolEntry("running"), toolName: "wait", args: { i: "background activity" }, startTime: 5 }],
			]),
		);
		await mount(["wait-1", "wait-2"], true);
		expect(container.querySelectorAll("[data-wait-line]")).toHaveLength(1);
		expect(container.querySelectorAll("[data-step-id]")).toHaveLength(1);
		expect(container.querySelector("[data-wait-line]")?.textContent).toContain("Waiting for background activity");
	});

	it("shows an editor and screenshot surfaces using the shared renderers", async () => {
		useToolsStore.setState(
			toolEntriesState([
				[
					"write",
					{
						...toolEntry("running"),
						toolName: "write",
						args: { path: "src/new.ts", content: "export const live = true;" },
					},
				],
			]),
		);
		await mount(["write", "browser", "computer"], true);
		expect(container.querySelector(".omp-live-step")?.getAttribute("data-surface")).toBe("write");
		expect(container.querySelector(".omp-live-step-scroll")?.textContent).toContain("export const live = true;");
		for (const name of ["browser", "computer"]) {
			await act(async () => {
				useToolsStore.setState(
					toolEntriesState([
						[
							name,
							{
								...toolEntry("running"),
								toolName: name,
								args: { action: "screenshot", url: "https://example.com" },
								status: "done",
								result: { content: [{ type: "image", data: "cG5n", mimeType: "image/png" }] },
							},
						],
					]),
				);
			});
			await flushFrame();
			expect(container.querySelector(".omp-live-step")?.getAttribute("data-surface")).toBe(name);
			expect(container.querySelector(".omp-live-step img")?.getAttribute("src")).toBe("data:image/png;base64,cG5n");
		}
	});

	it("shows the latest lines of a long live write and streams search results", async () => {
		const lines = Array.from({ length: 700 }, (_, index) => `line ${index}`);
		useToolsStore.setState(
			toolEntriesState([
				[
					"write",
					{ ...toolEntry("running"), toolName: "write", args: { path: "long.txt", content: lines.join("\n") } },
				],
			]),
		);
		await mount(["write", "search"], true);
		expect(container.querySelector(".omp-live-step-scroll")?.textContent).toContain("line 699");
		await act(async () => {
			useToolsStore.setState({
				...toolEntriesState([
					[
						"search",
						{ ...toolEntry("running"), toolName: "web_search", args: { query: "keyboard accessibility" } },
					],
				]),
				partialResults: new Map([["search", { content: [{ type: "text", text: "Live search result" }] }]]),
			});
		});
		await flushFrame();
		expect(container.querySelector(".omp-live-step-scroll")?.textContent).toContain("Live search result");
	});

	it("shows each task agent's current activity from the subagents store", async () => {
		useToolsStore.setState(
			toolEntriesState([
				[
					"task",
					{ ...toolEntry("running"), toolName: "task", args: { tasks: [{ name: "Scout", task: "Find code" }] } },
				],
			]),
		);
		useSubagentsStore.getState().setSnapshots([
			{
				id: "Scout",
				index: 0,
				agent: "scout",
				agentSource: "project",
				status: "running",
				lastUpdate: 1,
				parentToolCallId: "task",
				progress: {
					id: "Scout",
					index: 0,
					agent: "scout",
					agentSource: "project",
					task: "Find code",
					status: "running",
					lastIntent: "Reading source files",
					recentTools: [],
					recentOutput: [],
					toolCount: 1,
					requests: 1,
					tokens: 10,
					cost: 0,
					durationMs: 100,
				},
			},
		]);
		await mount(["task"], true);
		expect(container.querySelector("[data-agent-work]")?.textContent).toContain("Scout");
		expect(container.querySelector("[data-agent-work]")?.textContent).toContain("Reading source files");
	});
});
