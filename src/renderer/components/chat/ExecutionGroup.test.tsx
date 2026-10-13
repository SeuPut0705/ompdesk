import { parseHTML } from "linkedom";
import { act, type ReactNode, useState } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { useMessagesStore } from "../../stores/messages";
import { useSubagentsStore } from "../../stores/subagents";
import { type ToolEntry, toolEntriesState, useToolsStore } from "../../stores/tools";
import { resolveWorkGroup } from "./WorkStatus";

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
		// The summary row rides in the work card's head; the card's own mark says it is running.
		const header = container.querySelector(".omp-work-head .omp-execution-group-header");
		expect(header?.querySelector(".omp-execution-group-summary")?.textContent).toBe("1 step");
		expect(header?.getAttribute("aria-label")).toBe("Steps: 1 running · 1 step");
	});

	it("counts the command a user stop cut short as interrupted, keeping an earlier real failure", async () => {
		Object.assign(window, { omp: { rpc: { command: async () => ({ success: true, data: { messages: [] } }) } } });
		const failure = (command: string, endTime: number): ToolEntry => ({
			...toolEntry("error", true),
			args: { command },
			result: { content: [{ type: "text", text: "failed" }], details: {} },
			endTime,
		});
		useToolsStore.setState(
			toolEntriesState([
				["exit", failure("exit 3", 5_000)],
				["sleep", failure("sleep 40", 20_000)],
			]),
		);
		await mount(["exit", "sleep"]);
		await act(async () => {
			root.render(
				<I18nProvider>
					<ExecutionGroup
						expanded={false}
						onExpandedChange={() => {}}
						stepCount={2}
						stoppedAt={20_000}
						toolCallIds={["exit", "sleep"]}
					>
						<div />
					</ExecutionGroup>
				</I18nProvider>,
			);
		});
		expect(container.querySelector(".omp-execution-group-summary")?.textContent).toBe("1 failed · 2 steps");
		const rows = [...container.querySelectorAll('.omp-work-outcome li[data-kind="command"]')];
		expect(rows.map(row => row.querySelector('[role="img"]')?.getAttribute("aria-label"))).toEqual([
			"Failed",
			"Interrupted",
		]);
		expect(container.querySelector(".omp-work-outcome summary")?.textContent).toContain("1 failed");
	});

	it("counts a file written and then edited in one group as one edited file", async () => {
		const done = (toolName: string): ToolEntry => ({
			...toolEntry("error"),
			toolName,
			args: { path: "notes.txt", content: "alpha" },
			status: "done",
		});
		useToolsStore.setState(
			toolEntriesState([
				["write", done("write")],
				["edit", done("edit")],
			]),
		);
		await mount(["write", "edit"]);
		expect(container.querySelector(".omp-execution-group-summary")?.textContent).toBe("Edited 1 file");
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

	it("shows no clock for a step that has not run a full second yet, then whole seconds", async () => {
		// Frozen clock: the assertions must not depend on how long the runner takes.
		const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
		try {
			const running = (startTime: number) =>
				toolEntriesState([["fresh", { ...toolEntry("running"), args: { command: "sleep 60" }, startTime }]]);
			useToolsStore.setState(running(1_000_000 - 300));
			await mount(["fresh"], true);
			expect(container.querySelector(".omp-work-clock")).toBeNull();
			expect(container.textContent).not.toMatch(/\dms\b/);
			await act(async () => useToolsStore.setState(running(1_000_000 - 3_400)));
			await flushFrame();
			expect(container.querySelector(".omp-work-clock")?.textContent).toBe("3s");
		} finally {
			clock.mockRestore();
		}
	});

	it("lists calls running at the same time, one row each, and opens the one picked", async () => {
		useToolsStore.setState(
			toolEntriesState([
				["lint", { ...toolEntry("running"), args: { command: "bun lint" }, startTime: 1 }],
				["test", { ...toolEntry("running"), args: { command: "bun test" }, startTime: 2 }],
			]),
		);
		await mount(["lint", "test"], true);
		const rows = [...container.querySelectorAll(".omp-work-parallel-row")];
		expect(rows.map(row => row.textContent)).toEqual([
			expect.stringContaining("bun lint"),
			expect.stringContaining("bun test"),
		]);
		expect(container.querySelector(".omp-work-sub")?.textContent).toContain("2 running at once");
		// The newest call is the one on screen until another is picked.
		expect(rows[1]?.getAttribute("aria-current")).toBe("true");
		await act(async () => (rows[0] as unknown as { click(): void }).click());
		expect(container.querySelector(".omp-live-step-scroll")?.textContent).toContain("bun lint");
	});

	it("keeps the step that just finished on screen while the model thinks about the next one", async () => {
		useToolsStore.setState(
			toolEntriesState([["done", { ...toolEntry("running"), args: { command: "bun check" }, status: "done" }]]),
		);
		await mount(["done"], true);
		await act(async () => {
			root.render(
				<I18nProvider>
					<ExecutionGroup
						expanded={false}
						onExpandedChange={() => {}}
						stepCount={2}
						toolCallIds={["done"]}
						live
						thinkingLive
					>
						<div />
					</ExecutionGroup>
				</I18nProvider>,
			);
		});
		expect(container.querySelector(".omp-work-narrative")?.textContent).toBe("Thinking…");
		const surface = container.querySelector(".omp-live-step-scroll");
		expect(surface?.getAttribute("data-settled")).toBe("true");
		expect(surface?.textContent).toContain("bun check");
		expect(container.querySelector(".omp-live-work-heading")?.textContent).toContain("Just finished");
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

		// One running mark, the card's head status; the summary row carries no spinner of its own.
		expect(container.querySelectorAll(".animate-spin")).toHaveLength(0);
		expect(container.querySelectorAll('.omp-work-head .omp-work-status[data-state="running"]')).toHaveLength(1);
		expect(container.querySelectorAll(".omp-tool-status-icon")).toHaveLength(2);
		expect(container.querySelector(".omp-execution-group-header")?.getAttribute("aria-label")).toContain("2 running");
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
		const terminalLines = () =>
			[...(panel?.querySelectorAll(".omp-bash-terminal .omp-bash-line") ?? [])].map(line => line.textContent);
		expect(terminalLines()).toEqual(["step one", "step two"]);
		await act(async () => {
			useToolsStore.setState({
				partialResults: new Map([
					["bash-1", { content: [{ type: "text", text: "step one\nstep two\nstep three\n" }] }],
				]),
			});
		});
		await flushFrame();
		expect(terminalLines()).toEqual(["step one", "step two", "step three"]);
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
		expect(container.querySelector(".omp-live-step")?.getAttribute("data-outcome")).toBe("true");
		expect(container.querySelector(".omp-work-stage-shell")?.getAttribute("data-open")).toBe("false");
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
		// Following draws no "live" label: the strip holds only the two steps.
		expect(container.querySelectorAll(".omp-live-work-strip button")).toHaveLength(2);
		expect(container.querySelector(".omp-live-work-follow")).toBeNull();
	});

	it("collapses consecutive identical waits to one elapsed line in the head and one chip", async () => {
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
		// A calm wait has no output of its own: the head says it, no empty surface is drawn.
		expect(container.querySelector(".omp-work-surface")).toBeNull();
		expect(container.querySelectorAll("[data-step-id]")).toHaveLength(1);
		expect(container.querySelector(".omp-work-sub")?.textContent).toContain("Waiting for background activity");
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

	it("shows each detached task agent's activity on its lane and counts the group by its agents", async () => {
		useToolsStore.setState(
			toolEntriesState([
				[
					"task",
					// Stock returns a detached task call at once; only its agents keep running.
					{
						...toolEntry("running"),
						toolName: "task",
						args: { tasks: [{ name: "Scout", task: "Find code" }] },
						status: "done",
					},
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
		// The agent's lane carries its activity; the task tool's own list would only repeat it.
		expect(container.querySelector(".omp-work-card-button")?.textContent).toContain("Scout");
		expect(container.querySelector(".omp-work-card-button")?.textContent).toContain("Reading source files");
		expect(container.querySelector("[data-agent-work]")).toBeNull();
		expect(container.querySelector(".omp-execution-group-header")?.getAttribute("aria-label")).toBe(
			"Steps: 1 agent working",
		);
	});

	it("reports a cancelled task with an agent as interrupted, never as completed work", async () => {
		// A finished agent's transcript is fetched once for the outcome; an empty one is enough here.
		Object.assign(window, { omp: { rpc: { command: async () => ({ success: true, data: { messages: [] } }) } } });
		useToolsStore.setState(
			toolEntriesState([
				[
					"task",
					{
						...toolEntry("running"),
						toolName: "task",
						args: { tasks: [{ name: "Scout", task: "Find code" }] },
						status: "aborted",
						isError: true,
						endTime: 20,
					},
				],
			]),
		);
		useSubagentsStore.getState().setSnapshots([
			{
				id: "Scout",
				index: 0,
				agent: "scout",
				agentSource: "project",
				status: "cancelled",
				lastUpdate: 1,
				parentToolCallId: "task",
			},
		]);
		await mount(["task"]);
		const work = container.querySelector(".omp-live-step");
		expect(work?.getAttribute("data-state")).toBe("stopped");
		expect(work?.querySelector(".omp-work-narrative")?.textContent).toBe("Work interrupted");
		expect(work?.querySelector(".omp-work-head [role='img']")?.getAttribute("aria-label")).toBe("cancelled");
		expect(container.querySelector(".omp-execution-group-summary")?.textContent).toMatch(/^1 interrupted · /);
		expect(container.textContent).not.toContain("Work complete");
	});

	it.each([
		["failed", "1 failed · ", "Work failed", "failed"],
		["cancelled", "1 interrupted · ", "Work interrupted", "cancelled"],
	])(
		"ends a detached task by its agent's own %s end, never with a success check",
		async (status, summary, head, label) => {
			Object.assign(window, { omp: { rpc: { command: async () => ({ success: true, data: { messages: [] } }) } } });
			useToolsStore.setState(
				toolEntriesState([
					[
						"task",
						// Stock returned the detached call successfully before the agent ended.
						{ ...toolEntry("running"), toolName: "task", args: {}, status: "done", endTime: 20 },
					],
				]),
			);
			useSubagentsStore.getState().setSnapshots([
				{
					id: "Scout",
					index: 0,
					agent: "scout",
					agentSource: "project",
					status,
					lastUpdate: 1,
					parentToolCallId: "task",
				},
			]);
			await mount(["task"]);
			expect(container.querySelector(".omp-execution-group-summary")?.textContent?.startsWith(summary)).toBe(true);
			expect(container.querySelector(".omp-live-step .omp-work-narrative")?.textContent).toBe(head);
			expect(container.querySelector(".omp-work-head [role='img']")?.getAttribute("aria-label")).toBe(label);
			expect(container.querySelector(".omp-work-card-button")?.textContent).toContain(head);
		},
	);
});

describe("resolveWorkGroup", () => {
	const base = { live: false, runningTools: 0, failedTools: 0, reportedFailures: 0, interruptedTools: 0, agents: [] };
	it("counts a failure its parent call already reported once", () => {
		expect(
			resolveWorkGroup({ ...base, failedTools: 1, agents: [{ status: "failed", parent: "failed" }] }),
		).toMatchObject({ state: "failed", failed: 1 });
	});
	it("counts an interruption its parent call already reported once, and failure over interruption", () => {
		expect(
			resolveWorkGroup({ ...base, interruptedTools: 1, agents: [{ status: "cancelled", parent: "interrupted" }] }),
		).toMatchObject({ state: "interrupted", interrupted: 1 });
		expect(
			resolveWorkGroup({
				...base,
				agents: [
					{ status: "cancelled", parent: "done" },
					{ status: "failed", parent: "done" },
				],
			}),
		).toMatchObject({ state: "failed", failed: 1, interrupted: 1 });
	});
	it("stays running while any agent runs, and settles complete when all completed", () => {
		expect(resolveWorkGroup({ ...base, agents: [{ status: "pending", parent: "done" }] })).toMatchObject({
			state: "running",
			runningAgents: 1,
		});
		expect(resolveWorkGroup({ ...base, agents: [{ status: "completed", parent: "done" }] }).state).toBe("complete");
	});
});
