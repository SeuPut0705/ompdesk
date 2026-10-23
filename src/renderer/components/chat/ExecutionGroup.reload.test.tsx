import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { en } from "../../locales/en";
import { ko } from "../../locales/ko";
import { useMessagesStore } from "../../stores/messages";
import { useSubagentsStore } from "../../stores/subagents";
import { type ToolEntry, toolEntriesState, useToolsStore } from "../../stores/tools";

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
Object.assign(window, { requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} });

// React DOM must initialize after linkedom globals; static imports initialize it too early.
const { createRoot } = await import("react-dom/client");
const { ExecutionGroup } = await import("./ExecutionGroup");
const { MessageBubble } = await import("./MessageBubble");
const { buildHistoryRows } = await import("./chat-stream-utils");
const { workNarrative } = await import("./work/work-view");

const realLocalStorage = (globalThis as Record<string, unknown>).localStorage;
let container: HTMLElement;
let root: Root | undefined;

function setLanguage(lang: "en" | "ko"): void {
	(globalThis as Record<string, unknown>).localStorage = {
		getItem: (key: string) => (key === "omp.lang" ? lang : null),
		setItem: () => {},
	};
}

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => root?.render(<I18nProvider>{element}</I18nProvider>));
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	root = undefined;
	(globalThis as Record<string, unknown>).localStorage = realLocalStorage;
	useToolsStore.getState().reset();
	useMessagesStore.getState().reset();
	useSubagentsStore.getState().reset();
});

/** Exactly what stock's todo-tracker `checkCompletion` appends to the session journal. */
const reminder: AgentMessage = {
	role: "developer",
	content: [
		{
			type: "text",
			text: "<system-reminder>\nYou stopped with 2 incomplete todo item(s):\n- Tasks\n  - Count\n  - Report\n\nPlease continue working on these tasks or mark them complete if finished.\n(Reminder 1/3)\n</system-reminder>",
		},
	],
	attribution: "agent",
	timestamp: 1_791_810_748_237,
};
const RAW = /You stopped with|Please continue working|system-reminder|Reminder 1\/3/;

const user = (text: string, timestamp: number): AgentMessage => ({
	role: "user",
	content: [{ type: "text", text }],
	timestamp,
});
const reply = (text: string, timestamp: number): AgentMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	stopReason: "stop",
	timestamp,
});
const call = (id: string, name: string, args: Record<string, unknown>, timestamp: number): AgentMessage => ({
	role: "assistant",
	content: [{ type: "toolCall", id, name, arguments: args }],
	stopReason: "toolUse",
	timestamp,
});
const result = (id: string, toolName: string, text: string, timestamp: number, details?: unknown): AgentMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName,
	content: [{ type: "text", text }],
	details,
	isError: false,
	timestamp,
});

describe("stock todo reminder after a reload", () => {
	it("joins the run it followed, never a raw transcript row", async () => {
		const at = reminder.timestamp as number;
		const rows = buildHistoryRows(
			[
				user("Run twenty commands", at - 9_000),
				call("b1", "bash", { command: "echo 1" }, at - 8_000),
				result("b1", "bash", "1", at - 7_000),
				reply("done", at - 6_000),
				reminder,
				reply("Count와 Report는 그대로 두겠습니다.", at + 1_000),
			],
			"compact",
		);
		expect(rows.map(row => row.kind)).toEqual(["message", "process", "message", "message"]);
		expect(rows.some(row => row.kind === "message" && row.message.role === "developer")).toBe(false);
		const work = rows[1];
		expect(work?.kind === "process" ? work.notes : undefined).toEqual([reminder]);

		setLanguage("en");
		await mount(
			<ExecutionGroup
				expanded={false}
				onExpandedChange={() => {}}
				stepCount={1}
				toolCallIds={[]}
				notes={work?.kind === "process" ? work.notes : undefined}
			>
				<div />
			</ExecutionGroup>,
		);
		const line = container.querySelector<HTMLButtonElement>(".omp-live-step .omp-work-notes [data-todo-reminder]");
		expect(line?.textContent).toContain("Todo reminder");
		expect(line?.textContent).toContain("Needs attention: 2 todos");
		expect(container.textContent).not.toMatch(RAW);
		await act(async () => line?.click());
		expect([...container.querySelectorAll(".omp-todo-reminder-list li li")].map(item => item.textContent)).toEqual([
			"Count",
			"Report",
		]);
	});

	it("leads the run it restarted", () => {
		const at = reminder.timestamp as number;
		const rows = buildHistoryRows(
			[
				user("Use your todo tool", at - 9_000),
				call("b1", "bash", { command: "ls" }, at - 8_000),
				result("b1", "bash", "a", at - 7_000),
				reply("Stopping here.", at - 6_000),
				reminder,
				call("b2", "bash", { command: "wc -l a" }, at + 1_000),
				result("b2", "bash", "1 a", at + 2_000),
				reply("done", at + 3_000),
			],
			"compact",
		);
		expect(rows.map(row => row.kind)).toEqual(["message", "process", "message", "process", "message"]);
		const restarted = rows[3];
		expect(restarted?.kind === "process" ? restarted.notes : undefined).toEqual([reminder]);
		const stopped = rows[1];
		expect(stopped?.kind === "process" ? stopped.notes : undefined).toBeUndefined();
	});

	it("stands alone as the reminder line in a turn without work, in Korean too", async () => {
		const at = reminder.timestamp as number;
		const rows = buildHistoryRows(
			[user("Reply with hello", at - 2_000), reply("hello", at - 1_000), reminder, reply("그대로 둘게요.", at + 1)],
			"compact",
		);
		expect(rows.map(row => (row.kind === "message" ? row.message.role : row.kind))).toEqual([
			"user",
			"assistant",
			"developer",
			"assistant",
		]);
		setLanguage("ko");
		await mount(<MessageBubble message={reminder} />);
		const line = container.querySelector(".omp-todo-reminder [data-todo-reminder]");
		expect(line?.textContent).toContain(ko["todoPanel.reminder"]);
		expect(line?.textContent).toContain("확인이 필요한 할 일 2개");
		expect(container.textContent).not.toMatch(RAW);
	});

	it("hides stock's other developer messages, as the TUI does", async () => {
		setLanguage("en");
		const at = reminder.timestamp as number;
		// agent-session.ts `#enforceRewindBeforeYield` and a synthetic auto-continue prompt, as persisted.
		const checkpoint: AgentMessage = {
			role: "developer",
			content: [
				{
					type: "text",
					text: "<system-warning>\nYou are in an active checkpoint. You MUST call rewind with your investigation findings before yielding. Do NOT yield without completing the checkpoint.\n</system-warning>",
				},
			],
			attribution: "agent",
			timestamp: at,
		};
		const resume: AgentMessage = {
			role: "developer",
			content: [{ type: "text", text: "Continue." }],
			synthetic: true,
			timestamp: at + 1,
		};
		const rows = buildHistoryRows(
			[
				user("Investigate", at - 3_000),
				call("b1", "bash", { command: "ls" }, at - 2_000),
				result("b1", "bash", "a", at - 1_000),
				checkpoint,
				resume,
				call("b2", "bash", { command: "pwd" }, at + 2),
				result("b2", "bash", "/", at + 3),
				reply("done", at + 4),
			],
			"compact",
		);
		// Hidden context never splits the run or leaves a blank row behind.
		expect(rows.map(row => row.kind)).toEqual(["message", "process", "message"]);
		for (const message of [checkpoint, resume]) {
			await mount(<MessageBubble message={message} />);
			expect(container.textContent).toBe("");
			await act(async () => root?.unmount());
			container.remove();
		}
	});
});

describe("task step narrative", () => {
	const t =
		(locale: Record<string, string>) =>
		(key: string, params?: Record<string, string | number>): string =>
			Object.entries(params ?? {}).reduce(
				(text, [name, value]) => text.replace(`{${name}}`, String(value)),
				locale[key] ?? key,
			);
	const spec = (name?: string, agent = "task") => ({ name, agent, task: "Measure CI", solutionSpace: "open" });

	it("reads as a sentence naming the agents, never the tool label", () => {
		expect(workNarrative("task", spec("CiSpeed"), t(en))).toBe("Running CiSpeed");
		expect(workNarrative("task", spec("CiSpeed"), t(ko))).toBe("CiSpeed 실행 중");
		expect(workNarrative("task", { context: "c", tasks: [spec("Reader"), spec("Writer")] }, t(en))).toBe(
			"Running Reader, Writer",
		);
		expect(
			workNarrative("task", { context: "c", tasks: ["A", "B", "C", "D", "E"].map(name => spec(name)) }, t(ko)),
		).toBe("A, B, C 외 2개 실행 중");
		// Unnamed specs fall back to their agent; a legacy spec to its description.
		expect(workNarrative("task", spec(undefined, "scout"), t(en))).toBe("Running scout");
		expect(workNarrative("task", { description: "Audit renderer" }, t(en))).toBe("Running Audit renderer");
		expect(workNarrative("task", {}, t(en))).toBe("Running a subagent");
		expect(workNarrative("task", spec("CiSpeed"), t(en), undefined, "Measuring CI speed")).toBe("Measuring CI speed");
		for (const locale of [en, ko])
			expect(workNarrative("task", spec("CiSpeed"), t(locale))).not.toContain(locale["tools.label.task"]);
	});

	it("heads a running card with the agent sentence", async () => {
		setLanguage("en");
		const task: ToolEntry = {
			toolName: "task",
			args: spec("CiSpeed"),
			status: "running",
			streamingArgs: "",
			result: null,
			isError: false,
			startTime: 1,
			endTime: null,
		};
		useToolsStore.setState(toolEntriesState([["task", task]]));
		await mount(
			<ExecutionGroup expanded={false} onExpandedChange={() => {}} stepCount={1} toolCallIds={["task"]} live>
				<div />
			</ExecutionGroup>,
		);
		expect(container.querySelector(".omp-work-narrative")?.textContent).toBe("Running CiSpeed");
	});
});

describe("todo row after a reload", () => {
	it("rebuilds from stock's persisted todo call and result", async () => {
		// The journal shape stock's TodoTool.execute persists: details `{ op, phases, storage }`.
		const phases = [
			{
				name: "Tasks",
				tasks: [
					{ content: "Read", status: "completed" },
					{ content: "Count", status: "in_progress" },
					{ content: "Report", status: "pending" },
				],
			},
		];
		const messages: AgentMessage[] = [
			user("Use your todo tool", 1_000),
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "toolu_todo",
						name: "todo",
						arguments: { op: "done", task: "Read", i: "Marking Read done" },
						intent: "Marking Read done",
					},
				],
				stopReason: "toolUse",
				timestamp: 2_000,
			},
			result(
				"toolu_todo",
				"todo",
				"Remaining items (2):\n  - Count [in_progress] (Tasks)\n  - Report [pending] (Tasks)",
				2_100,
				{ op: "done", phases, storage: "session", completedTasks: [{ phase: "Tasks", content: "Read" }] },
			),
			reply("Read is done.", 3_000),
		];
		useToolsStore.getState().hydrateMessages(messages);
		const work = buildHistoryRows(messages, "compact").find(row => row.kind === "process");
		expect(work?.kind).toBe("process");
		setLanguage("en");
		await mount(
			<ExecutionGroup
				expanded={false}
				onExpandedChange={() => {}}
				stepCount={1}
				toolCallIds={work?.kind === "process" ? work.toolCallIds : []}
			>
				<div />
			</ExecutionGroup>,
		);
		const row = container.querySelector<HTMLButtonElement>(
			".omp-live-step [data-todo-snapshot] .omp-work-todo-toggle",
		);
		expect(row?.getAttribute("aria-label")).toBe("Todos: 1/3");
		await act(async () => row?.click());
		expect(
			[...container.querySelectorAll(".omp-work-todo-list li")].map(item => item.getAttribute("data-status")),
		).toEqual(["completed", "in_progress", "pending"]);
	});
});

describe("agents after a relaunch", () => {
	const at = 1_791_900_000_000;
	// Lanes settle by replaying each agent's transcript once; an empty one is enough here.
	const rpc = () =>
		Object.assign(window, { omp: { rpc: { command: async () => ({ success: true, data: { messages: [] } }) } } });
	async function mountRun(messages: AgentMessage[]) {
		useToolsStore.getState().hydrateMessages(messages);
		const work = buildHistoryRows(messages, "compact").find(row => row.kind === "process");
		await mount(
			<ExecutionGroup
				expanded={false}
				onExpandedChange={() => {}}
				stepCount={work?.kind === "process" ? work.toolCallIds.length : 0}
				toolCallIds={work?.kind === "process" ? work.toolCallIds : []}
			>
				<div />
			</ExecutionGroup>,
		);
	}

	it("keeps the lane of a task its process left unanswered, named by its spec", async () => {
		rpc();
		setLanguage("en");
		// The journal a relaunch reopens: the task and the command after it never got a result.
		await mountRun([
			user("Build, map and test", at),
			call("b1", "bash", { command: "bun run build" }, at + 1_000),
			result("b1", "bash", "built", at + 2_000, { exitCode: 0 }),
			call("t1", "task", { context: "c", tasks: [{ name: "Scout", task: "Map the code" }] }, at + 3_000),
			call("b2", "bash", { command: "bun test" }, at + 4_000),
		]);
		const group = container.querySelector(".omp-execution-group");
		expect(group?.getAttribute("data-state")).toBe("interrupted");
		const lanes = [...container.querySelectorAll(".omp-work-card-button")];
		expect(lanes.map(lane => lane.querySelector(".omp-work-card-name")?.textContent)).toEqual(["Scout"]);
		expect(lanes[0]?.querySelector(".omp-work-card-activity")?.textContent).toBe("Work interrupted");
		expect(container.querySelector(".omp-execution-group-summary")?.textContent).toBe(
			"2 interrupted · build OK · 1 command · 1 agent",
		);
	});

	it("heads a finished run with one agent by how the run ended, never the agent's own task", async () => {
		rpc();
		setLanguage("en");
		await mountRun([
			user("Map the code", at),
			call("t1", "task", { tasks: [{ name: "Scout", task: "Map the code" }] }, at + 1_000),
			result("t1", "task", "Scout finished", at + 2_000, {
				results: [
					{
						id: "Scout",
						agent: "explore",
						description: "Scout task",
						exitCode: 0,
						output: "Mapped.",
						durationMs: 900,
					},
				],
			}),
			reply("Mapped it.", at + 3_000),
		]);
		expect(container.querySelector(".omp-work-head .omp-work-narrative")?.textContent).toBe("Work complete");
		expect(container.querySelector(".omp-work-card-name")?.textContent).toBe("Scout");
	});
});

describe("background job that fails after its run", () => {
	const at = 1_791_900_000_000;
	// Stock's shapes: the call's background start (tools/bash.ts `#buildBackgroundStartResult`) and
	// the later delivery (session/async-job-delivery.ts) of a job the manager recorded as failed.
	const started = result(
		"exit",
		"bash",
		"Backgrounded as job bg_1 (killed once it has run 300s in total; `timeout: 0` disables the deadline)",
		at + 2_000,
		{ async: { state: "running", jobId: "bg_1", type: "bash" }, timeoutSeconds: 300 },
	);
	const delivery = (status: "failed" | "completed", output: string): AgentMessage => ({
		role: "custom",
		customType: "async-result",
		content: `<system-notice>\nBackground job bg_1 has completed. Resume your work using the result below.\n${output}\n</system-notice>`,
		display: true,
		attribution: "agent",
		details: {
			meta: { source: { type: "report", value: "background job delivery" } },
			jobs: [{ jobId: "bg_1", type: "bash", status, label: "exit 3", durationMs: 19 }],
		},
		timestamp: at + 9_000,
	});
	const transcript = (notice: AgentMessage) => [
		user("Run the bash command `exit 3` exactly once.", at),
		call("exit", "bash", { command: "exit 3" }, at + 1_000),
		started,
		reply("It moved to the background as bg_1.", at + 3_000),
		notice,
		reply("exit 3 finished with exit code 3.", at + 10_000),
	];
	const markColored = (token: string) =>
		[...container.querySelectorAll("svg")].some(svg => svg.getAttribute("class")?.includes(token));

	it("fails the run that started it and marks its completion line red", async () => {
		const failed = delivery("failed", "(no output)\n\nCommand exited with code 3");
		const rows = buildHistoryRows(transcript(failed), "compact");
		const work = rows.find(row => row.kind === "process");
		expect(work?.kind === "process" ? work.failedEvents : undefined).toBe(1);
		// The delivery keeps its own place in the transcript.
		expect(rows.some(row => row.kind === "message" && row.message === failed)).toBe(true);

		setLanguage("en");
		useToolsStore.getState().hydrateMessages(transcript(failed));
		await mount(
			<ExecutionGroup
				expanded={false}
				onExpandedChange={() => {}}
				stepCount={1}
				failureCount={work?.kind === "process" ? work.failedEvents : 0}
				toolCallIds={work?.kind === "process" ? work.toolCallIds : []}
			>
				<div />
			</ExecutionGroup>,
		);
		expect(container.querySelector(".omp-execution-group")?.getAttribute("data-state")).toBe("failed");
		expect(container.querySelector(".omp-execution-group-summary")?.textContent).toMatch(/^1 failed/);
		await act(async () => root?.unmount());
		container.remove();

		await mount(<MessageBubble message={failed} />);
		expect(container.textContent).toContain("Background job failed");
		expect(container.textContent).toContain("exit 3");
		expect(markColored("--omp-error")).toBe(true);
		expect(markColored("--omp-success")).toBe(false);
	});

	it("leaves a job that succeeded green and the run complete", async () => {
		const done = delivery("completed", "ok");
		const work = buildHistoryRows(transcript(done), "compact").find(row => row.kind === "process");
		expect(work?.kind === "process" ? work.failedEvents : undefined).toBe(0);
		setLanguage("en");
		await mount(<MessageBubble message={done} />);
		expect(container.textContent).toContain("Background job completed");
		expect(markColored("--omp-success")).toBe(true);
	});
});
