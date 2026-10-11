import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreApi } from "zustand/vanilla";
import type { AgentProgress, RpcCommand, SubagentFrame } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { deleteSessionRuntime, SessionRuntimeProvider } from "../../stores/session-runtime-context";
import type { SubagentsStore } from "../../stores/subagents";
import { useSubagentsStore } from "../../stores/subagents";
import { createTabRuntime } from "../../stores/tab-runtime";
import { useTabsStore } from "../../stores/tabs";
import type { ToolsStore } from "../../stores/tools";
import { type ToolEntry, toolEntriesState, useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
import { WorkOutcome } from "./WorkOutcome";
import { workConclusion, workNarrative, workOutcomes } from "./work-view";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Node, IS_REACT_ACT_ENVIRONMENT: true });
// React DOM must load after linkedom globals are installed.
const { createRoot } = await import("react-dom/client");
const { LiveStepPeek } = await import("./LiveStepPeek");
const { ExecutionGroup } = await import("./ExecutionGroup");
const { TaskRenderer } = await import("../tools/TaskRenderer");
let root: Root;
let container: HTMLElement;
const commands: RpcCommand[] = [];
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
const progress: AgentProgress = {
	id: "LineCounter",
	index: 0,
	agent: "scout",
	agentSource: "bundled",
	status: "running",
	task: "Count file lines",
	currentTool: "bash",
	currentToolArgs: '{"command":"wc -l a.ts"}',
	currentToolIntent: "Counting file lines",
	lastIntent: "Inspecting files",
	recentTools: [],
	recentOutput: [],
	toolCount: 3,
	requests: 1,
	tokens: 42,
	cost: 0,
	durationMs: 2000,
};
const entry = (toolName: string, args: Record<string, unknown>, result: unknown = null): ToolEntry => ({
	toolName,
	args,
	result,
	status: result ? "done" : "running",
	streamingArgs: "",
	isError: false,
	startTime: Date.now(),
	endTime: result ? Date.now() : null,
});
async function flush() {
	await act(async () => {
		const pending = [...frames.values()];
		frames.clear();
		for (const frame of pending) frame(0);
	});
}
async function mount(ids = ["parent"]) {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container);
	await act(async () =>
		root.render(
			<I18nProvider>
				<LiveStepPeek thinkingLive={false} toolCallIds={ids} />
			</I18nProvider>,
		),
	);
}
beforeEach(() => {
	commands.length = 0;
	Object.assign(window, {
		requestAnimationFrame: (callback: FrameRequestCallback) => {
			frames.set(++frameId, callback);
			return frameId;
		},
		cancelAnimationFrame: (id: number) => frames.delete(id),
		omp: {
			rpc: {
				command: async (command: RpcCommand) => {
					commands.push(command);
					return { success: true, data: { messages: [] } };
				},
			},
		},
	});
	useToolsStore.setState(toolEntriesState([["parent", entry("task", { intent: "Delegating line counts" })]]));
	useSubagentsStore.getState().applyFrame({
		type: "subagent_progress",
		payload: {
			index: 0,
			agent: "scout",
			agentSource: "bundled",
			task: progress.task,
			parentToolCallId: "parent",
			progress,
		},
	});
});
afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	frames.clear();
	useToolsStore.getState().reset();
	useSubagentsStore.getState().reset();
	useUiStore.getState().setTranscriptDetail("compact");
	deleteSessionRuntime("work-view-test");
	useTabsStore.setState({ activeTabId: null });
	vi.useRealTimers();
});
describe("live work", () => {
	it("uses stock intent precedence and localized tool target fallback", () => {
		const t = translate;
		expect(workNarrative("read", { intent: "Arg intent" }, t, progress, "Wire intent")).toBe("Wire intent");
		expect(workNarrative("read", { intent: "Exact intent", i: "Legacy intent", path: "a.ts" }, t, progress)).toBe(
			"Exact intent",
		);
		expect(workNarrative("read", {}, t, progress)).toBe("Counting file lines");
		expect(workNarrative("read", {}, t, { ...progress, currentToolIntent: undefined })).toBe("Inspecting files");
		expect(workNarrative("read", { path: "a.ts" }, t)).toContain("a.ts");
		expect(workNarrative("bash", { target: "wc -l a.ts" }, t)).toContain("wc -l a.ts");
		expect(workNarrative("task", { tasks: [{ name: "Counter" }] }, t)).toContain("Counter");
	});
	it("uses this group's final reply and never a later turn's text", () => {
		expect(
			workConclusion(
				[
					{ role: "toolResult", toolCallId: "parent", content: [] },
					{ role: "assistant", content: [{ type: "text", text: "Inspected the file. It has twelve lines." }] },
					{ role: "user", content: "Another task" },
					{ role: "assistant", content: [{ type: "text", text: "A different conclusion." }] },
				],
				[],
				id => id === "parent",
			),
		).toBe("It has twelve lines.");
	});
	it("uses observed tools and reported usage while stock progress still reports zero", async () => {
		const store = useSubagentsStore.getState();
		store.applyFrame({
			type: "subagent_progress",
			payload: {
				index: 0,
				agent: "scout",
				agentSource: "bundled",
				task: progress.task,
				parentToolCallId: "parent",
				progress: { ...progress, toolCount: 0, tokens: 0 },
			},
		});
		store.applyFrame({
			type: "subagent_event",
			payload: {
				id: progress.id,
				event: {
					type: "tool_execution_start",
					toolCallId: "observed",
					toolName: "bash",
					args: { command: "wc -l a.ts" },
				},
			},
		});
		const event: SubagentFrame = {
			type: "subagent_event",
			payload: {
				id: progress.id,
				event: {
					type: "message_end",
					message: { role: "assistant", content: [], timestamp: 123, usage: { output: 17 } },
				},
			},
		};
		store.applyFrame(event);
		store.applyFrame(event);
		await mount();
		expect(container.querySelector(".omp-work-card-button")?.textContent).toContain("1 tool · 17 tokens");
	});
	it("makes completion results primary and omits internal skipped waits from the surface and strip", async () => {
		useToolsStore.setState(
			toolEntriesState([
				["parent", entry("task", {}, { details: { results: [{ id: progress.id, output: "Twelve lines." }] } })],
				[
					"skipped",
					{
						...entry(
							"wait",
							{},
							{
								content: [{ type: "text", text: "Skipped due to an internal completion." }],
								details: { source: "interrupt_skipped" },
							},
						),
						status: "aborted",
						isError: true,
					},
				],
			]),
		);
		const store = useSubagentsStore.getState();
		store.setSnapshots([{ ...store.subagents.get(progress.id)!, status: "completed" }]);
		await mount(["parent", "skipped"]);
		await act(async () =>
			root.render(
				<I18nProvider>
					<LiveStepPeek thinkingLive={false} toolCallIds={["parent", "skipped"]} turnIsLive={false} />
				</I18nProvider>,
			),
		);
		expect(container.querySelector(".omp-live-step")?.getAttribute("data-outcome")).toBe("true");
		expect(container.querySelector(".omp-work-narrative")?.textContent).toBe("Work complete");
		expect(container.querySelector(".omp-work-main-card .omp-work-card-activity")?.textContent).toBe("Work complete");
		expect(container.querySelector(".omp-work-card-button")?.textContent).toContain("Twelve lines.");
		expect(container.querySelector(".omp-work-outcome")).not.toBeNull();
		expect(container.querySelector(".omp-live-work-heading")).toBeNull();
		expect(container.querySelectorAll(".omp-live-work-chips button")).toHaveLength(1);
		expect(container.textContent).not.toContain("Skipped due to");
	});
	it("renders the intent carried by stock tool_execution_start", async () => {
		useToolsStore.getState().reset();
		useToolsStore.getState().applyEvents([
			{
				type: "tool_execution_start",
				toolCallId: "wire",
				toolName: "bash",
				args: { command: "wc -l a.ts" },
				intent: "Stock wire intent",
			},
		]);
		await mount(["wire"]);
		expect(container.querySelector(".omp-work-narrative")?.textContent).toBe("Stock wire intent");
	});
	it("reports a hydration error without hiding tool events already received", async () => {
		Object.assign(window.omp.rpc, {
			command: async (command: RpcCommand) => {
				commands.push(command);
				return command.type === "get_subagent_messages"
					? { success: false, error: "Snapshot unavailable" }
					: { success: true };
			},
		});
		useSubagentsStore
			.getState()
			.surface(progress.id)
			.getState()
			.applyEvents([
				{ type: "tool_execution_start", toolCallId: "bash|fc", toolName: "bash", args: { command: "wc -l a.ts" } },
			]);
		await mount();
		await act(async () => container.querySelector<HTMLButtonElement>(".omp-work-card-button")?.click());
		await flush();
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("Snapshot unavailable");
		expect(container.querySelector(".omp-work-card .omp-live-step")?.getAttribute("data-surface")).toBe("bash");
	});
	it("builds cards from progress and subscribes only while expanded without polling", async () => {
		await mount();
		expect(container.textContent).toContain("Counting file lines");
		expect(container.textContent).toContain("3 tools · 42 tokens");
		expect(commands).toEqual([]);
		const card = container.querySelector<HTMLButtonElement>(".omp-work-card-button");
		await act(async () => card?.click());
		expect(commands.filter(command => command.type === "set_subagent_subscription")).toEqual([
			{ type: "set_subagent_subscription", level: "events" },
		]);
		await act(async () =>
			useSubagentsStore.getState().applyFrame({
				type: "subagent_event",
				payload: {
					id: progress.id,
					event: {
						type: "tool_execution_start",
						toolCallId: "child",
						toolName: "bash",
						args: { command: "wc -l a.ts" },
					},
				},
			}),
		);
		await act(async () =>
			useSubagentsStore.getState().applyFrame({
				type: "subagent_event",
				payload: {
					id: progress.id,
					event: {
						type: "tool_execution_update",
						toolCallId: "child",
						toolName: "bash",
						args: {},
						partialResult: { content: [{ type: "text", text: "12 a.ts" }] },
					},
				},
			}),
		);
		await flush();
		await flush();
		expect(container.textContent).toContain("12 a.ts");
		await act(async () => card?.click());
		expect(commands.at(-1)).toEqual({ type: "set_subagent_subscription", level: "progress" });
		expect(commands.filter(command => command.type === "get_subagent_messages")).toHaveLength(1);
		await act(async () => card?.click());
		await act(async () =>
			root.render(
				<I18nProvider>
					<div />
				</I18nProvider>,
			),
		);
		expect(commands.at(-1)).toEqual({ type: "set_subagent_subscription", level: "progress" });
		expect(commands.filter(command => command.type === "get_subagent_messages")).toHaveLength(1);
	});
	it("keeps completed cards expandable and replays their command without an event lease", async () => {
		const tools = useSubagentsStore.getState().surface(progress.id);
		tools.getState().applyEvents([
			{
				type: "tool_execution_start",
				toolCallId: "call_alpha|fc_alpha",
				toolName: "bash",
				args: { command: "wc -l a.ts" },
			},
			{
				type: "tool_execution_end",
				toolCallId: "call_alpha|fc_alpha",
				toolName: "bash",
				result: { content: [{ type: "text", text: "12 a.ts" }], details: { exitCode: 0 } },
				isError: false,
			},
		]);
		useSubagentsStore
			.getState()
			.setSnapshots([{ ...useSubagentsStore.getState().subagents.get(progress.id)!, status: "completed" }]);
		await mount();
		await act(async () =>
			root.render(
				<I18nProvider>
					<LiveStepPeek thinkingLive={false} toolCallIds={["parent"]} turnIsLive={false} />
				</I18nProvider>,
			),
		);
		await act(async () => container.querySelector<HTMLButtonElement>(".omp-work-card-button")?.click());
		await flush();
		expect(container.querySelector(".omp-work-card .omp-live-step")).not.toBeNull();
		expect(container.textContent).toContain("12 a.ts");
		expect(container.querySelector(".omp-work-card .omp-live-work-follow")?.textContent).toContain("Latest");
		expect(container.querySelector(".omp-work-card .omp-live-work-follow")?.getAttribute("aria-pressed")).toBe(
			"true",
		);
		expect(
			commands.filter(command => command.type === "set_subagent_subscription" && command.level === "events"),
		).toHaveLength(0);
		await act(async () => container.querySelector<HTMLButtonElement>(".omp-work-card .omp-live-work-chip")?.click());
		expect(container.querySelector(".omp-work-card .omp-live-step")?.getAttribute("data-surface")).toBe("bash");
		expect(container.querySelector(".omp-work-card .omp-live-work-mode")?.textContent).toBe("Replay");
		expect(commands.filter(command => command.type === "get_subagent_messages")).toHaveLength(1);
	});
	it("classifies stock interrupt_skipped as aborted, not failed or completed work", async () => {
		const result = {
			content: [{ type: "text", text: "Skipped due to a queued background completion." }],
			details: { __interrupted: true, source: "interrupt_skipped", execution: "started" },
		};
		useToolsStore.getState().applyEvents([
			{ type: "tool_execution_start", toolCallId: "skipped", toolName: "wait", args: {} },
			{ type: "tool_execution_end", toolCallId: "skipped", toolName: "wait", result, isError: true },
		]);
		expect(useToolsStore.getState().finishedTools.get("skipped")?.status).toBe("aborted");
		expect(useToolsStore.getState().finishedTools.get("skipped")?.isError).toBe(true);
		await mount(["skipped"]);
		await act(async () =>
			root.render(
				<I18nProvider>
					<ExecutionGroup
						expanded={false}
						onExpandedChange={() => undefined}
						stepCount={1}
						toolCallIds={["skipped"]}
					>
						{null}
					</ExecutionGroup>
				</I18nProvider>,
			),
		);
		expect(container.querySelector(".omp-execution-group")?.getAttribute("data-state")).toBe("complete");
		expect(container.textContent).toContain("0 steps complete");
	});
	it("shows lifecycle-only workers as running after the detached task tool returned", async () => {
		const subagents = useSubagentsStore.getState();
		subagents.reset();
		subagents.applyFrame({
			type: "subagent_lifecycle",
			payload: {
				id: "LineCounter",
				index: 0,
				agent: "task",
				agentSource: "bundled",
				status: "started",
				parentToolCallId: "parent",
			},
		});
		await mount();
		await act(async () =>
			root.render(
				<I18nProvider>
					<TaskRenderer
						args={{}}
						result={{ details: { progress: [{ id: "LineCounter", status: "pending" }] } }}
						isPartial={false}
						livePreview
						toolCallId="parent"
					/>
				</I18nProvider>,
			),
		);
		expect(container.querySelector('[data-agent-status="running"]')?.textContent).toContain("running");
		expect(container.querySelector("[data-agent-work]")?.textContent).not.toContain("completed");
	});
	it("settles a missed end event from the completion transcript instead of preserving stale running state", async () => {
		await mount();
		const tools = useToolsStore.getState();
		tools.applyEvents([
			{
				type: "tool_execution_start",
				toolCallId: "missed-end|fc",
				toolName: "bash",
				args: { command: "wc -l a.ts" },
			},
		]);
		tools.hydrateMessages(
			[
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "missed-end|fc", name: "bash", arguments: { command: "wc -l a.ts" } }],
				},
				{
					role: "toolResult",
					toolCallId: "missed-end|fc",
					toolName: "bash",
					content: [{ type: "text", text: "12 a.ts" }],
					details: { wallTimeMs: 3000 },
					isError: false,
				},
			],
			{ keepChangedSince: 0 },
		);
		expect(useToolsStore.getState().liveTools.has("missed-end|fc")).toBe(false);
		expect(useToolsStore.getState().finishedTools.get("missed-end|fc")?.status).toBe("done");
		await act(async () =>
			root.render(
				<I18nProvider>
					<WorkOutcome toolCallIds={["missed-end|fc"]} />
				</I18nProvider>,
			),
		);
		expect(container.textContent).toContain("wc -l a.ts · Succeeded");
		expect(container.textContent).toContain("Wall time 3.0s");
	});
	it.each([true, false])(
		"hydrates a completion gap once, but not fully observed events (missing=%s)",
		async missing => {
			await mount();
			const store = useSubagentsStore.getState();
			await act(async () => store.hydrateSurface(progress.id));
			const tools = store.surface(progress.id);
			tools.getState().applyEvents([
				{ type: "tool_execution_start", toolCallId: "bash|fc", toolName: "bash", args: { command: "wc -l a.ts" } },
				{
					type: "tool_execution_end",
					toolCallId: "bash|fc",
					toolName: "bash",
					result: { content: [{ type: "text", text: "12 a.ts" }] },
					isError: false,
				},
			]);
			if (!missing)
				tools.getState().applyEvents([
					{ type: "tool_execution_start", toolCallId: "yield|fc", toolName: "yield", args: {} },
					{
						type: "tool_execution_end",
						toolCallId: "yield|fc",
						toolName: "yield",
						result: { content: [] },
						isError: false,
					},
				]);
			await act(async () =>
				store.setSnapshots([
					{
						...store.subagents.get(progress.id)!,
						status: "completed",
						progress: { ...progress, status: "completed", toolCount: 2 },
					},
				]),
			);
			await act(async () => {
				await store.hydrateSurface(progress.id);
				await store.hydrateSurface(progress.id);
			});
			expect(commands.filter(command => command.type === "get_subagent_messages")).toHaveLength(missing ? 2 : 1);
		},
	);
	it("keeps hydration from downgrading an expanded event lease", async () => {
		const runtime = createTabRuntime("work-view-test");
		const subagents = runtime.stores.get("subagents") as StoreApi<SubagentsStore>;
		subagents.setState({ eventConsumers: 1 });
		await runtime.command({ type: "set_subagent_subscription", level: "progress" });
		expect(commands.at(-1)).toEqual({ type: "set_subagent_subscription", level: "events" });
		subagents.setState({ eventConsumers: 0 });
		await runtime.command({ type: "set_subagent_subscription", level: "progress" });
		expect(commands.at(-1)).toEqual({ type: "set_subagent_subscription", level: "progress" });
	});
	it("attributes cards to the latest occurrence when stock reuses a call id", async () => {
		useToolsStore.getState().reset();
		useToolsStore.getState().applyEvents([
			{ type: "tool_execution_start", toolCallId: "parent", toolName: "task", args: {} },
			{
				type: "tool_execution_end",
				toolCallId: "parent",
				toolName: "task",
				result: { content: [] },
				isError: false,
			},
			{ type: "tool_execution_start", toolCallId: "parent", toolName: "task", args: {} },
		]);
		const key = useToolsStore.getState().entryKeyForCallId("parent");
		expect(key).not.toBe("parent");
		await mount([key]);
		expect(container.querySelectorAll(".omp-work-card-button")).toHaveLength(1);
	});
	it("shows stock success and wall time without inventing an exit code, and reserves unknown for missing results", async () => {
		const succeeded = entry("bash", { command: "wc -l a.ts" }, { details: { wallTimeMs: 3000 } });
		const unknown: ToolEntry = {
			...entry("bash", { command: "interrupted command" }),
			status: "aborted",
			isError: true,
		};
		const outcomes = workOutcomes([succeeded, unknown]);
		expect(outcomes.commands[0]).toEqual({ command: "wc -l a.ts", exitCode: null, failed: false, durationMs: 3000 });
		expect(outcomes.commands[1]).toEqual({
			command: "interrupted command",
			exitCode: null,
			failed: false,
			unknown: true,
		});
		useToolsStore.setState(
			toolEntriesState([
				["succeeded", succeeded],
				["unknown", unknown],
			]),
		);
		await mount(["succeeded", "unknown"]);
		await act(async () =>
			root.render(
				<I18nProvider>
					<WorkOutcome toolCallIds={["succeeded", "unknown"]} />
				</I18nProvider>,
			),
		);
		expect(container.textContent).toContain("Succeeded · Wall time 3");
		expect(container.textContent).toContain("Status unknown");
		expect(container.textContent).not.toContain("exit 0");
	});
	it("summarizes changed files, exit statuses and task conclusions without a new diff engine", () => {
		const outcome = workOutcomes([
			entry("write", { path: "a.ts", content: "one\ntwo" }, { content: [] }),
			entry("bash", { command: "bun test" }, { details: { exitCode: 0 } }),
			entry("task", {}, { details: { results: [{ id: "LineCounter", output: "Two lines.\nMore detail" }] } }),
		]);
		expect(outcome.files).toEqual([{ path: "a.ts", added: 2, removed: 0 }]);
		expect(outcome.commands[0]).toEqual({ command: "bun test", exitCode: 0, failed: false });
		expect(outcome.conclusions).toEqual([{ name: "LineCounter", summary: "Two lines." }]);
		const child = workOutcomes([
			{ entry: entry("bash", { command: "wc -l a.ts" }, { details: { exitCode: 0 } }), agentName: "LineCounter" },
		]);
		expect(child.commands[0]).toEqual({
			command: "wc -l a.ts",
			exitCode: 0,
			failed: false,
			agentName: "LineCounter",
		});
	});
	it("uses structured stock result summaries rather than a JSON opening brace", () => {
		const outcome = workOutcomes([
			entry(
				"task",
				{},
				{
					details: {
						results: [
							{ id: "AlphaCounter", output: '{\n"summary": "Alpha has three lines."\n}' },
							{
								id: "BetaCounter",
								output: "Fallback",
								extractedToolData: { yield: [{ type: "result", data: { summary: "Beta has two lines." } }] },
							},
						],
					},
				},
			),
		]);
		expect(outcome.conclusions).toEqual([
			{ name: "AlphaCounter", summary: "Alpha has three lines." },
			{ name: "BetaCounter", summary: "Beta has two lines." },
		]);
	});
	it("renders detached task conclusions from stock's completed progress yield", async () => {
		useToolsStore.setState(
			toolEntriesState([["parent", { ...entry("task", {}, { content: [] }), status: "done", endTime: Date.now() }]]),
		);
		useSubagentsStore.getState().applyFrame({
			type: "subagent_progress",
			payload: {
				index: 0,
				agent: "scout",
				agentSource: "bundled",
				task: progress.task,
				parentToolCallId: "parent",
				progress: {
					...progress,
					status: "completed",
					extractedToolData: { yield: [{ data: { summary: "The file has twelve lines." }, status: "success" }] },
				},
			},
		});
		await mount([]);
		await act(async () =>
			root.render(
				<I18nProvider>
					<WorkOutcome toolCallIds={["parent"]} />
				</I18nProvider>,
			),
		);
		expect(container.textContent).toContain("The file has twelve lines.");
	});
	it("renders outcome evidence and respects transcript detail", async () => {
		const entries: Array<[string, ToolEntry]> = [
			["file", entry("write", { path: "a.ts", content: "one\ntwo" }, { content: [] })],
			["pass", entry("bash", { command: "bun test" }, { details: { exitCode: 0 } })],
			["fail", entry("bash", { command: "false" }, { details: { exitCode: 1 } })],
			["agents", entry("task", {}, { details: { results: [{ id: "LineCounter", output: "Two lines." }] } })],
		];
		useToolsStore.setState(toolEntriesState(entries));
		await mount([]);
		await act(async () =>
			root.render(
				<I18nProvider>
					<WorkOutcome toolCallIds={entries.map(([id]) => id)} />
				</I18nProvider>,
			),
		);
		expect(container.textContent).toContain("a.ts +2 −0");
		expect(container.textContent).toContain("Passed · exit 0");
		expect(container.textContent).toContain("Failed · exit 1");
		expect(container.textContent).toContain("LineCounter · Two lines.");
		expect(container.querySelector("details")?.hasAttribute("open")).toBe(false);
		await act(async () => useUiStore.getState().setTranscriptDetail("full"));
		expect(container.querySelector("details")?.hasAttribute("open")).toBe(true);
	});
	it("shows the no-output label after ten seconds using fake timers", async () => {
		vi.useFakeTimers();
		Object.assign(window, { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval });
		useToolsStore.setState(toolEntriesState([["command", entry("bash", { command: "slow command" })]]));
		await mount(["command"]);
		await act(async () => vi.advanceTimersByTime(11_000));
		expect(container.textContent).toContain("Running for 11s without output");
	});
	it("counts only steps advanced outside visibility", async () => {
		await mount();
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
		await act(async () => document.dispatchEvent(new Event("visibilitychange")));
		useToolsStore.setState(
			toolEntriesState([
				["parent", entry("bash", {})],
				["second", entry("read", { path: "b.ts" })],
			]),
		);
		await act(async () =>
			root.render(
				<I18nProvider>
					<LiveStepPeek thinkingLive={false} toolCallIds={["parent", "second"]} />
				</I18nProvider>,
			),
		);
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
		await act(async () => document.dispatchEvent(new Event("visibilitychange")));
		expect(container.textContent).toContain("1 step advanced while you were away");
	});
	it("preserves the away baseline across a cached tab remount until hydration", async () => {
		const runtime = createTabRuntime("work-view-test");
		const tools = runtime.stores.get("tools") as StoreApi<ToolsStore>;
		tools.setState(toolEntriesState([["parent", entry("read", { path: "a.ts" })]]));
		useTabsStore.setState({ activeTabId: runtime.tabId });
		await mount([]);
		const view = (ids: string[]) => (
			<I18nProvider>
				<SessionRuntimeProvider runtime={runtime}>
					<LiveStepPeek thinkingLive={false} toolCallIds={ids} />
				</SessionRuntimeProvider>
			</I18nProvider>
		);
		await act(async () => root.render(view(["parent"])));
		await act(async () => {
			useTabsStore.setState({ activeTabId: "other" });
			root.render(<div />);
		});
		await act(async () => {
			useTabsStore.setState({ activeTabId: runtime.tabId });
			root.render(view(["parent"]));
		});
		expect(container.querySelector(".omp-work-catch-up")).toBeNull();
		await act(async () => {
			tools.getState().hydrateMessages(
				[
					{
						role: "assistant",
						content: [{ type: "toolCall", id: "parent", name: "read", arguments: { path: "a.ts" } }],
						timestamp: 1,
					},
					{
						role: "toolResult",
						toolCallId: "parent",
						toolName: "read",
						content: [{ type: "text", text: "a" }],
						timestamp: 2,
					},
					{
						role: "assistant",
						content: [{ type: "toolCall", id: "second", name: "read", arguments: { path: "b.ts" } }],
						timestamp: 3,
					},
				],
				{ turnIsLive: true },
			);
			root.render(view(["parent", "second"]));
		});
		await flush();
		expect(container.textContent).toContain("1 step advanced while you were away");
	});
	it("omits motion classes under reduced motion", async () => {
		Object.assign(window, { matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
		await mount();
		expect(container.querySelector(".omp-work-motion, .omp-work-pulse")).toBeNull();
		Reflect.deleteProperty(window, "matchMedia");
	});
});
