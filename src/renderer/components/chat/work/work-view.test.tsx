import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoreApi } from "zustand/vanilla";
import type { AgentProgress, RpcCommand, RpcResponse, SubagentFrame } from "../../../../shared/rpc-types";
import { I18nProvider, translate } from "../../../lib/i18n";
import { deleteSessionRuntime } from "../../../stores/session-runtime-context";
import type { SubagentsStore } from "../../../stores/subagents";
import { createSubagentsStore, useSubagentsStore } from "../../../stores/subagents";
import { createTabRuntime } from "../../../stores/tab-runtime";
import { useTabsStore } from "../../../stores/tabs";
import { type ToolEntry, toolEntriesState, useToolsStore } from "../../../stores/tools";
import { useUiStore } from "../../../stores/ui";
import { routeCommands } from "../../../test-support/route-commands";
import { WorkMedia } from "./WorkMedia";
import { workNarrative, workOutcomes } from "./work-view";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Node, IS_REACT_ACT_ENVIRONMENT: true });
// React DOM must load after linkedom globals are installed.
const { createRoot } = await import("react-dom/client");
const { LiveStepPeek } = await import("../LiveStepPeek");
const { ExecutionGroup } = await import("../ExecutionGroup");
const { TaskRenderer } = await import("../../tools/renderers/TaskRenderer");
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
			rpc: routeCommands({
				command: async (command: RpcCommand) => {
					commands.push(command);
					return { success: true, data: { messages: [] } };
				},
			}),
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
			assignment: progress.task,
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
	it("uses observed tools and reported usage while stock progress still reports zero", async () => {
		const store = useSubagentsStore.getState();
		store.applyFrame({
			type: "subagent_progress",
			payload: {
				index: 0,
				agent: "scout",
				agentSource: "bundled",
				task: progress.task,
				assignment: progress.task,
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
					<LiveStepPeek thinkingLive={false} toolCallIds={["parent", "skipped"]} state="complete" />
				</I18nProvider>,
			),
		);
		expect(container.querySelector(".omp-live-step")?.getAttribute("data-outcome")).toBe("true");
		expect(container.querySelector(".omp-work-narrative")?.textContent).toBe("Work complete");
		expect(container.querySelector(".omp-live-step")?.getAttribute("data-state")).toBe("complete");
		expect(container.querySelector(".omp-work-card-button")?.textContent).toContain("Twelve lines.");
		// The lane already states the agent's conclusion; the card draws no outcome list and no replay strip.
		expect(container.querySelector(".omp-live-work-heading")).toBeNull();
		expect(container.querySelector(".omp-live-work-strip, .omp-live-work-chips")).toBeNull();
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
				// Neither stock's registry nor the session's artifacts dir has the transcript.
				return command.type === "get_subagent_messages" || command.type === "get_subagent_transcript"
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
		expect(container.querySelector(".omp-work-stage .omp-live-step")?.getAttribute("data-surface")).toBe("bash");
	});
	it("auto-follows an active agent and leases events only while a surface is shown without polling", async () => {
		await mount();
		expect(container.textContent).toContain("Counting file lines");
		expect(container.textContent).toContain("3 tools · 42 tokens");
		expect(commands.filter(command => command.type === "set_subagent_subscription")).toEqual([
			{ type: "set_subagent_subscription", level: "events" },
		]);
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
		// Returning to auto-follow keeps the shown agent's event lease alive.
		expect(commands.filter(command => command.type === "set_subagent_subscription").at(-1)).toEqual({
			type: "set_subagent_subscription",
			level: "events",
		});
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
	it("keeps completed cards expandable and shows their command without an event lease", async () => {
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
					<LiveStepPeek thinkingLive={false} toolCallIds={["parent"]} state="complete" />
				</I18nProvider>,
			),
		);
		await act(async () => container.querySelector<HTMLButtonElement>(".omp-work-card-button")?.click());
		await flush();
		expect(container.querySelector(".omp-work-stage .omp-live-step")).not.toBeNull();
		expect(container.textContent).toContain("12 a.ts");
		expect(container.querySelector(".omp-work-stage .omp-live-step")?.getAttribute("data-surface")).toBe("bash");
		// One step has nothing to replay: the lane draws no strip of its own.
		expect(container.querySelector(".omp-work-stage .omp-live-work-strip")).toBeNull();
		expect(
			commands.filter(command => command.type === "set_subagent_subscription" && command.level === "events"),
		).toHaveLength(0);
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
		expect(container.querySelector(".omp-execution-group-summary")?.textContent).toBe("0 steps");
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
		const settled = useToolsStore.getState().finishedTools.get("missed-end|fc");
		expect(settled && workOutcomes([settled]).commands).toEqual([
			{ command: "wc -l a.ts", exitCode: null, failed: false, durationMs: 3000 },
		]);
	});
	it.each([true, false])("shares a pending replay and follows only a still-missing gap (served=%s)", async served => {
		const replies = [Promise.withResolvers<RpcResponse>(), Promise.withResolvers<RpcResponse>()];
		const followUpStarted = Promise.withResolvers<void>();
		let request = 0;
		const command = vi.fn(() => {
			const reply = replies[request++];
			if (request === 2) followUpStarted.resolve();
			return reply.promise;
		});
		const store = createSubagentsStore(command);
		const snapshot = (status: "running" | "completed", toolCount: number) => ({
			id: progress.id,
			index: 0,
			agent: "scout",
			status,
			lastUpdate: toolCount,
			progress: { ...progress, status, toolCount },
		});
		store.getState().setSnapshots([snapshot("running", 1)]);
		const first = store.getState().hydrateSurface(progress.id);
		await Promise.resolve();
		store.getState().setSnapshots([snapshot("running", 2)]);
		expect(store.getState().hydrateSurface(progress.id)).toBe(first);
		store.getState().setSnapshots([snapshot("completed", 3)]);
		expect(store.getState().hydrateSurface(progress.id)).toBe(first);
		expect(command).toHaveBeenCalledTimes(1);
		if (served) {
			const surface = store.getState().surface(progress.id);
			for (let index = 0; index < 3; index++)
				surface.getState().applyEvents([
					{ type: "tool_execution_start", toolCallId: `observed-${index}`, toolName: "bash", args: {} },
					{
						type: "tool_execution_end",
						toolCallId: `observed-${index}`,
						toolName: "bash",
						result: { content: [] },
						isError: false,
					},
				]);
		}
		replies[0].resolve({ type: "response", command: "get_subagent_messages", success: true, data: { messages: [] } });
		if (!served) {
			await followUpStarted.promise;
			expect(store.getState().hydrateSurface(progress.id)).not.toBe(first);
			expect(command).toHaveBeenCalledTimes(2);
			replies[1].resolve({
				type: "response",
				command: "get_subagent_messages",
				success: true,
				data: { messages: [] },
			});
		}
		await first;
		await store.getState().hydrateSurface(progress.id);
		expect(command).toHaveBeenCalledTimes(served ? 1 : 2);
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
			// A reused id is a new call only once its own message ends (a start alone is a replay).
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "parent", name: "task", arguments: {} }],
					timestamp: 2,
				},
			},
			{ type: "tool_execution_start", toolCallId: "parent", toolName: "task", args: {} },
		]);
		const key = useToolsStore.getState().entryKeyForCallId("parent");
		expect(key).not.toBe("parent");
		await mount([key]);
		expect(container.querySelectorAll(".omp-work-card-button")).toHaveLength(1);
	});
	it("shows stock success and wall time without inventing an exit code, and marks explicit aborts interrupted", async () => {
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
			interrupted: true,
		});
		useToolsStore.setState(
			toolEntriesState([
				["succeeded", succeeded],
				["unknown", unknown],
			]),
		);
	});
	it("summarizes changed files and exit statuses without a new diff engine", () => {
		const outcome = workOutcomes([
			entry("write", { path: "a.ts", content: "one\ntwo" }, { content: [] }),
			entry("bash", { command: "bun test" }, { details: { exitCode: 0 } }),
		]);
		expect(outcome.files).toEqual([{ path: "a.ts", added: 2, removed: 0 }]);
		expect(outcome.commands[0]).toEqual({ command: "bun test", exitCode: 0, failed: false });
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
	it("shows the screenshots the work read back without opening any step", async () => {
		const picture = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };
		useToolsStore.setState(
			toolEntriesState([
				["shot", entry("read", { path: "/tmp/menu_now/menu_1280x720.png" }, { content: [picture] })],
				["again", entry("read", { path: "/tmp/menu_now/menu_1280x720.png" }, { content: [picture] })],
			]),
		);
		await mount([]);
		await act(async () =>
			root.render(
				<I18nProvider>
					<WorkMedia toolCallIds={["shot", "again"]} />
				</I18nProvider>,
			),
		);
		const images = [...container.querySelectorAll(".omp-work-images img")];
		expect(images.map(image => image.getAttribute("src"))).toEqual(["data:image/png;base64,iVBORw0KGgo="]);
		expect(container.querySelector(".omp-work-images figcaption")?.textContent).toBe("menu_1280x720.png");
	});
	it("keeps the ledger behind a finished card's facts: files and commands by what they did", () => {
		const entries: Array<[string, ToolEntry]> = [
			["file", entry("write", { path: "a.ts", content: "one\ntwo" }, { content: [] })],
			["pass", entry("bash", { command: "bun test" }, { details: { exitCode: 0 } })],
			["fail", entry("bash", { command: "false" }, { details: { exitCode: 1 } })],
			["agents", entry("task", {}, { details: { results: [{ id: "LineCounter", output: "Two lines." }] } })],
		];
		const outcome = workOutcomes(entries.map(([, item]) => item));
		expect(outcome.files).toEqual([{ path: "a.ts", added: 2, removed: 0 }]);
		// Exit 0 carries no figure; a failing code is kept for the verdict block.
		expect(outcome.commands[0]).toEqual({ command: "bun test", exitCode: 0, failed: false });
		expect(outcome.commands[1]).toMatchObject({ command: "false", exitCode: 1 });
		// Conclusions live on the lanes, never in the ledger.
		expect(JSON.stringify(outcome)).not.toContain("Two lines.");
	});
	it("shows the no-output label after ten seconds using fake timers", async () => {
		vi.useFakeTimers();
		Object.assign(window, { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval });
		useToolsStore.setState(toolEntriesState([["command", entry("bash", { command: "slow command" })]]));
		await mount(["command"]);
		await act(async () => vi.advanceTimersByTime(11_000));
		expect(container.textContent).toContain("No output for 11s");
	});
	it("warns about a silent command inside an open subagent lane too", async () => {
		vi.useFakeTimers();
		Object.assign(window, { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval });
		useSubagentsStore
			.getState()
			.surface(progress.id)
			.getState()
			.applyEvents([
				{
					type: "tool_execution_start",
					toolCallId: "sub-bash",
					toolName: "bash",
					args: { command: "sleep 30" },
				},
			]);
		await mount();
		await act(async () => container.querySelector<HTMLButtonElement>(".omp-work-card-button")?.click());
		await act(async () => vi.advanceTimersByTime(11_000));
		const lane = container.querySelector(".omp-work-stage .omp-live-step");
		expect(lane?.getAttribute("data-surface")).toBe("bash");
		const clock = lane?.querySelector(".omp-work-clock");
		expect(clock?.textContent).toBe("No output for 11s");
		expect(clock?.getAttribute("data-stalled")).toBe("true");
	});
	it("omits motion classes under reduced motion", async () => {
		Object.assign(window, { matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
		await mount();
		expect(container.querySelector(".omp-work-motion, .omp-work-pulse")).toBeNull();
		Reflect.deleteProperty(window, "matchMedia");
	});
});
