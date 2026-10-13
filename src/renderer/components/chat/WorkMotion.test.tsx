import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { type SubagentNode, useSubagentsStore } from "../../stores/subagents";
import { type ToolEntry, toolEntriesState, useToolsStore } from "../../stores/tools";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
let sequence = 0;
const frames = new Map<number, FrameRequestCallback>();
const motionQuery = { reduced: false };
Object.assign(window, {
	requestAnimationFrame: (callback: FrameRequestCallback) => {
		const id = ++sequence;
		frames.set(id, callback);
		return id;
	},
	cancelAnimationFrame: (id: number) => frames.delete(id),
	omp: { rpc: { command: async () => ({ success: true, data: { messages: [] } }) } },
	matchMedia: () => ({ matches: motionQuery.reduced, addEventListener() {}, removeEventListener() {} }),
});
Object.assign(HTMLElement.prototype, { focus() {} });
// React DOM must initialize only after the linkedom browser globals exist.
const { createRoot } = await import("react-dom/client");
const { LiveStepPeek, WorkCardPending } = await import("./LiveStepPeek");
const stylesheet = readFileSync(new URL("../../styles/components.css", import.meta.url), "utf8");
const rule = (selector: string) =>
	stylesheet.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]+)\\}`))?.[1] ?? "";
let root: Root;
let container: HTMLElement;
const bash = (command: string, patch: Partial<ToolEntry> = {}): ToolEntry => ({
	toolName: "bash",
	args: { command },
	streamingArgs: "",
	result: undefined,
	isError: false,
	status: "running",
	startTime: 1,
	endTime: null,
	...patch,
});
const agent = (id: string, index: number, lastUpdate: number, patch: Partial<SubagentNode> = {}): SubagentNode => ({
	id,
	index,
	lastUpdate,
	status: "running",
	agent: "scout",
	parentToolCallId: "task",
	...patch,
});
async function flush() {
	const pending = [...frames.values()];
	frames.clear();
	await act(async () => {
		for (const callback of pending) callback(0);
		vi.advanceTimersToNextFrame();
	});
}
async function show(node: ReactNode) {
	await act(async () => root.render(<I18nProvider>{node}</I18nProvider>));
	await flush();
}
async function tools(entries: Array<readonly [string, ToolEntry]>, partial?: Map<string, unknown>) {
	await act(async () =>
		useToolsStore.setState({ ...toolEntriesState(entries), ...(partial ? { partialResults: partial } : {}) }),
	);
	await flush();
}
const narrative = () => container.querySelector(".omp-work-head [data-incoming] .omp-work-narrative")?.textContent;
const headFades = () => container.querySelectorAll(".omp-work-head [data-outgoing]").length;
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(10_000);
	motionQuery.reduced = false;
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	useToolsStore.getState().reset();
	useSubagentsStore.getState().reset();
	frames.clear();
	vi.useRealTimers();
});

it("#1 holds the previous step until the next call has real content, then fades once", async () => {
	const first = bash("ls", { intent: "Listing files", status: "done", endTime: 2 });
	await tools([["first", first]]);
	await show(<LiveStepPeek thinkingLive={false} toolCallIds={["first", "second"]} />);
	expect(narrative()).toBe("Listing files");
	// The second call's intent is still being typed: nothing about it is shown yet.
	const streaming: ToolEntry = {
		...bash(""),
		toolName: "read",
		args: { i: "Readi" },
		streamingArgs: '{"i":"Readi',
		status: "pending",
		startTime: 3,
	};
	await tools([
		["first", first],
		["second", streaming],
	]);
	expect(narrative()).toBe("Listing files");
	expect(headFades()).toBe(0);
	expect(container.textContent).not.toContain("Read");
	expect(container.querySelector(".omp-work-stage [data-incoming] .omp-work-surface")?.getAttribute("data-tool")).toBe(
		"bash",
	);
	// Its intent is complete once the next argument starts: the step arrives with one fade.
	await tools([
		["first", first],
		[
			"second",
			{ ...streaming, args: { i: "Reading b.txt", path: "b" }, streamingArgs: '{"i":"Reading b.txt","path":"b' },
		],
	]);
	expect(narrative()).toBe("Reading b.txt");
	expect(headFades()).toBe(1);
	await act(async () => vi.advanceTimersByTime(220));
	// Execution start, its intent and output stream in place: no further fade for the same step.
	await tools(
		[
			["first", first],
			[
				"second",
				{ ...streaming, args: { path: "b.txt" }, intent: "Reading b.txt", streamingArgs: "", status: "running" },
			],
		],
		new Map([["second", { content: [{ type: "text", text: "one" }] }]]),
	);
	await tools(
		[
			["first", first],
			[
				"second",
				{ ...streaming, args: { path: "b.txt" }, intent: "Reading b.txt", streamingArgs: "", status: "done" },
			],
		],
		new Map([["second", { content: [{ type: "text", text: "one two" }] }]]),
	);
	expect(narrative()).toBe("Reading b.txt");
	expect(headFades()).toBe(0);
	expect(container.querySelectorAll(".omp-work-stage [data-outgoing]")).toHaveLength(0);
});

it("#37 swaps instantly under reduced motion without an empty interim frame", async () => {
	motionQuery.reduced = true;
	const first = bash("ls", { status: "done", endTime: 2, result: { content: [{ type: "text", text: "a.txt" }] } });
	await tools([["first", first]]);
	await show(<LiveStepPeek thinkingLive={false} toolCallIds={["first", "second"]} />);
	await tools([
		["first", first],
		["second", { ...bash(""), args: {}, streamingArgs: '{"comm', status: "pending", startTime: 3 }],
	]);
	// The pending call has no content: the finished output stays, not a blank terminal.
	expect(container.querySelector(".omp-work-stage")?.textContent).toContain("a.txt");
	expect(container.querySelector("[data-outgoing]")).toBeNull();
	await tools([
		["first", first],
		["second", bash("cat b.txt", { startTime: 3 })],
	]);
	expect(container.querySelector(".omp-work-stage")?.textContent).toContain("cat b.txt");
	expect(container.querySelector("[data-outgoing]")).toBeNull();
});

it("#20 names the command instead of a generic intent", async () => {
	await tools([["run", bash("cat missing.txt", { intent: "Running requested command" })]]);
	await show(<LiveStepPeek thinkingLive={false} toolCallIds={["run"]} />);
	expect(narrative()).toContain("cat missing.txt");
	expect(narrative()).not.toContain("requested");
});

it("#4 reserves the head's sub line for the whole run and folds it with the stage", async () => {
	await tools([["one", bash("sleep 1")]]);
	await show(<LiveStepPeek thinkingLive={false} toolCallIds={["one", "two"]} />);
	const shell = container.querySelector(".omp-work-sub-shell");
	expect(shell?.getAttribute("data-open")).toBe("true");
	expect(container.querySelector(".omp-work-sub")?.getAttribute("aria-hidden")).toBe("true");
	await tools([
		["one", bash("sleep 1")],
		["two", bash("sleep 2", { startTime: 2 })],
	]);
	expect(container.querySelector(".omp-work-sub-shell")).toBe(shell);
	await show(<LiveStepPeek thinkingLive={false} toolCallIds={["one", "two"]} state="complete" />);
	expect(container.querySelector(".omp-work-sub-shell")).toBe(shell);
	expect(shell?.getAttribute("data-open")).toBe("false");
	expect(rule(".omp-work-sub")).toContain("white-space: nowrap");
	expect(rule(".omp-work-sub")).not.toContain("margin-block");
	expect(rule('.omp-work-sub-shell[data-open="false"]')).toContain("grid-template-rows: 0fr");
	// A short pane keeps the head one constant line: the sub text shares the narrative's line.
	expect(stylesheet).toMatch(
		/@container omp-workspace \(max-height: 480px\) \{[^@]*\.omp-work-head-text \{\s*display: flex;[^@]*\.omp-work-sub-shell \{\s*display: block;/,
	);
});

it("#16 counts the whole run in the head and the step on its heading", async () => {
	await tools([
		["one", bash("echo one", { startTime: 1_000, status: "done", endTime: 7_000 })],
		["two", bash("echo two", { startTime: 8_000 })],
	]);
	await show(<LiveStepPeek thinkingLive={false} toolCallIds={["one", "two"]} summaryRow={<span>2 steps</span>} />);
	expect(container.querySelector(".omp-work-head-clock")?.textContent).toBe("9s");
	expect(container.querySelector(".omp-work-head .omp-work-clock")).toBeNull();
	expect(container.querySelector(".omp-live-work-heading .omp-work-clock")?.textContent).toBe("2s");
	await show(
		<LiveStepPeek
			thinkingLive={false}
			toolCallIds={["one", "two"]}
			runStartedAt={0}
			summaryRow={<span>2 steps</span>}
		/>,
	);
	expect(container.querySelector(".omp-work-head-clock")?.textContent).toBe("10s");
	expect(rule(".omp-work-head-clock")).toContain("font-size: var(--sc-font-xs)");
	expect(rule(".omp-execution-group-header--embedded")).toContain("font-size: var(--sc-font-xs)");
});

it("#29 never warns about silence once the terminal reported its exit", async () => {
	await tools([["run", bash("bun run check:types", { startTime: 10_000 })]]);
	await show(<LiveStepPeek thinkingLive={false} toolCallIds={["run"]} />);
	await act(async () => vi.advanceTimersByTime(12_000));
	expect(container.querySelector(".omp-live-work-heading .omp-work-clock")?.textContent).toBe(
		"Running for 12s without output",
	);
	expect(container.querySelector(".omp-work-head")?.textContent).not.toContain("without output");
	await tools(
		[["run", bash("bun run check:types", { startTime: 10_000 })]],
		new Map([["run", { content: [{ type: "text", text: "done" }], details: { exitCode: 0 } }]]),
	);
	await act(async () => vi.advanceTimersByTime(12_000));
	expect(container.textContent).not.toContain("without output");
});

it("#2 #3 opens the stage through a clip that can animate and closes it in the same move as the outcome", async () => {
	await tools([["run", bash("echo hi")]]);
	await show(<LiveStepPeek thinkingLive={false} toolCallIds={["run"]} />);
	const shell = container.querySelector(".omp-work-stage-shell");
	expect(shell?.firstElementChild?.className).toBe("omp-work-stage-clip");
	expect(shell?.firstElementChild?.firstElementChild?.className).toBe("omp-work-stage");
	expect(rule(".omp-work-stage-clip")).toContain("min-height: 0");
	expect(rule(".omp-work-stage-clip")).toContain("overflow: hidden");
	expect(rule(".omp-work-stage-shell")).toContain("transition: grid-template-rows");
	expect(stylesheet).toMatch(
		/@starting-style \{\s*\.omp-work-stage-shell\[data-open="true"\] \{ grid-template-rows: 0fr; \}/,
	);
	await tools([["run", bash("echo hi", { status: "done", endTime: 2 })]]);
	await show(<LiveStepPeek thinkingLive={false} toolCallIds={["run"]} state="complete" />);
	// One move: the stage folds while the outcome unfolds, then the folded stage leaves.
	expect(container.querySelector(".omp-work-stage-shell")?.getAttribute("data-open")).toBe("false");
	expect(container.querySelector(".omp-work-outcome-shell")).not.toBeNull();
	await act(async () => vi.advanceTimersByTime(220));
	expect(container.querySelector(".omp-work-stage-shell")).toBeNull();
});

it("#36 fades the between-steps dim instead of snapping, and not under reduced motion", () => {
	expect(rule(".omp-work-stage > .omp-work-crossfade")).toContain("transition: opacity");
	expect(rule(".omp-live-step-scroll")).toContain("transition: opacity");
	const reduced = stylesheet.match(
		/@media \(prefers-reduced-motion: reduce\) \{\n\t\.omp-work-stage-shell,([^}]+)\}/,
	)?.[1];
	expect(reduced).toContain(".omp-work-stage > .omp-work-crossfade");
	expect(reduced).toContain(".omp-live-step-scroll { transition: none;");
});

it("#5 auto-follows only lanes with output and lets an agent dwell before a quick main step", async () => {
	await tools([["task", bash("", { toolName: "task", args: {} })]]);
	useSubagentsStore.getState().setSnapshots([agent("Empty", 0, 5), agent("Busy", 1, 1)]);
	useSubagentsStore
		.getState()
		.surface("Busy")
		.setState(toolEntriesState([["child", bash("echo busy")]]));
	await show(<LiveStepPeek thinkingLive={false} toolCallIds={["task", "glob"]} />);
	const lanes = () => [...container.querySelectorAll<HTMLButtonElement>(".omp-work-card-button")];
	expect(lanes()[0]?.getAttribute("aria-current")).toBeNull();
	expect(lanes()[1]?.getAttribute("aria-current")).toBe("true");
	expect(container.textContent).not.toContain("No transcript entries yet");
	// The main agent runs a quick search while its agents work: the agent keeps the stage.
	await tools([
		["task", bash("", { toolName: "task", args: {}, status: "done", endTime: 2 })],
		["glob", bash("", { toolName: "glob", args: { pattern: "*.ts" }, startTime: 3 })],
	]);
	await act(async () => vi.advanceTimersByTime(1_000));
	expect(lanes()[1]?.getAttribute("aria-current")).toBe("true");
	await act(async () => vi.advanceTimersByTime(1_000));
	expect(lanes()[1]?.getAttribute("aria-current")).toBeNull();
	expect(container.querySelector(".omp-work-stage [data-incoming] .omp-work-surface")?.getAttribute("data-tool")).toBe(
		"glob",
	);
});

it("#5 never takes a lane the reader opened", async () => {
	await tools([["task", bash("", { toolName: "task", args: {} })]]);
	useSubagentsStore.getState().setSnapshots([agent("Mine", 0, 1)]);
	await show(<LiveStepPeek thinkingLive={false} toolCallIds={["task", "glob"]} />);
	await act(async () => container.querySelector<HTMLButtonElement>(".omp-work-card-button")?.click());
	await tools([
		["task", bash("", { toolName: "task", args: {}, status: "done", endTime: 2 })],
		["glob", bash("", { toolName: "glob", args: { pattern: "*.ts" }, startTime: 3 })],
	]);
	await act(async () => vi.advanceTimersByTime(10_000));
	expect(container.querySelector(".omp-work-card-button")?.getAttribute("aria-current")).toBe("true");
});

it("#6 keeps one parallel row for the whole overlap, without blinking between calls", async () => {
	const picks = () => container.querySelectorAll(".omp-work-stage .omp-work-parallel-row").length;
	await tools([["a", bash("sleep 3")]]);
	await show(<LiveStepPeek thinkingLive={false} toolCallIds={["a", "b", "c"]} />);
	await tools([
		["a", bash("sleep 3")],
		["b", bash("sleep 1", { startTime: 2 })],
	]);
	// A momentary overlap draws nothing.
	expect(picks()).toBe(0);
	await act(async () => vi.advanceTimersByTime(150));
	expect(picks()).toBe(2);
	// b ends and c starts a moment later: the row stays put the whole time.
	await tools([
		["a", bash("sleep 3")],
		["b", bash("sleep 1", { startTime: 2, status: "done", endTime: 3 })],
	]);
	await act(async () => vi.advanceTimersByTime(300));
	expect(picks()).toBe(2);
	await tools([
		["a", bash("sleep 3")],
		["b", bash("sleep 1", { startTime: 2, status: "done", endTime: 3 })],
		["c", bash("sleep 2", { startTime: 4 })],
	]);
	expect(picks()).toBe(2);
	await tools([
		["a", bash("sleep 3", { status: "done", endTime: 5 })],
		["b", bash("sleep 1", { startTime: 2, status: "done", endTime: 3 })],
		["c", bash("sleep 2", { startTime: 4, status: "done", endTime: 5 })],
	]);
	expect(picks()).toBe(2);
	await act(async () => vi.advanceTimersByTime(600));
	expect(picks()).toBe(0);
	expect(rule(".omp-work-parallel > li")).toContain("flex: 0 1 auto");
	expect(rule(".omp-work-parallel-label")).toContain("text-overflow: ellipsis");
});

it("#8 #9 a lane shows its newest call with its own picks, steady while its store reorders", async () => {
	const lane = useSubagentsStore.getState().surface("Lane");
	const entries: Array<readonly [string, ToolEntry]> = [
		["ls", bash("ls -la", { startTime: 5 })],
		["cat", bash("cat missing.txt", { startTime: 6 })],
	];
	lane.setState(toolEntriesState(entries));
	await show(<LiveStepPeek nested thinkingLive={false} toolsOverride={lane} toolCallIds={["ls", "cat"]} />);
	await act(async () => vi.advanceTimersByTime(220));
	const surface = () => container.querySelector(":scope > .omp-live-step > .omp-work-crossfade > [data-incoming]");
	expect(surface()?.textContent).toContain("cat missing.txt");
	expect(container.querySelectorAll(".omp-work-parallel-row")).toHaveLength(2);
	// The lane's store lists finished calls first, so its order flips as calls end.
	for (const order of [
		["cat", "ls"],
		["ls", "cat"],
		["cat", "ls"],
	]) {
		await show(<LiveStepPeek nested thinkingLive={false} toolsOverride={lane} toolCallIds={order} />);
		expect(container.querySelector("[data-outgoing]")).toBeNull();
		expect(surface()?.textContent).toContain("cat missing.txt");
	}
	// Both done, finished in the other order: still the call that started last.
	lane.setState(
		toolEntriesState([
			["cat", bash("cat missing.txt", { startTime: 6, status: "error", isError: true, endTime: 7 })],
			["ls", bash("ls -la", { startTime: 5, status: "done", endTime: 8 })],
		]),
	);
	await show(<LiveStepPeek nested thinkingLive={false} toolsOverride={lane} toolCallIds={["cat", "ls"]} />);
	expect(surface()?.textContent).toContain("cat missing.txt");
});

it("#25 #35 an open lane's steps replace the card's strip, named for the agent; one region per card", async () => {
	await tools([
		["read", bash("", { toolName: "read", args: { path: "a.ts" }, status: "done", endTime: 1 })],
		["task", bash("", { toolName: "task", args: {}, startTime: 2 })],
	]);
	useSubagentsStore.getState().setSnapshots([agent("Reader", 0, 1)]);
	useSubagentsStore
		.getState()
		.surface("Reader")
		.setState(
			toolEntriesState([
				// Both live: the lane's empty transcript hydration keeps only live calls.
				["c1", bash("echo one")],
				["c2", bash("echo two", { startTime: 3 })],
			]),
		);
	await show(<LiveStepPeek thinkingLive={false} toolCallIds={["read", "task"]} />);
	await act(async () => container.querySelector<HTMLButtonElement>(".omp-work-card-button")?.click());
	await flush();
	const strips = container.querySelectorAll(".omp-live-work-strip");
	expect(strips).toHaveLength(1);
	expect(strips[0]?.getAttribute("aria-label")).toBe("Reader · Work steps");
	expect(strips[0]?.querySelector(".omp-live-work-strip-label")?.textContent).toBe("Reader");
	expect(
		[...(strips[0]?.querySelectorAll("[data-step-id]") ?? [])].map(chip => chip.getAttribute("data-step-id")),
	).toEqual(["c1", "c2"]);
	expect(container.querySelectorAll("[role=region]")).toHaveLength(1);
});

it("#35 the strip is one tab stop and arrow keys move along it", async () => {
	await tools([
		["a", bash("echo a", { status: "done", endTime: 1 })],
		["b", bash("echo b", { startTime: 2, status: "done", endTime: 3 })],
		["c", bash("echo c", { startTime: 4 })],
	]);
	await show(<LiveStepPeek thinkingLive={false} toolCallIds={["a", "b", "c"]} />);
	const chips = () => [...container.querySelectorAll<HTMLButtonElement>("[data-step-id]")];
	const stops = () => chips().map(chip => chip.getAttribute("tabindex"));
	expect(stops()).toEqual(["-1", "-1", "0"]);
	const press = async (target: HTMLElement | undefined, key: string) => {
		const event = new Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(event, { key });
		await act(async () => target?.dispatchEvent(event));
	};
	await press(chips()[2], "ArrowLeft");
	expect(stops()).toEqual(["-1", "0", "-1"]);
	await press(chips()[1], "Home");
	expect(stops()).toEqual(["0", "-1", "-1"]);
	await press(chips()[0], "End");
	expect(stops()).toEqual(["-1", "-1", "0"]);
});

it("#28 the catch-up chip rides in the strip, colorless", async () => {
	// Seen-step counts persist per store and group: ids unique to this test.
	await tools([["away-a", bash("echo a", { status: "done", endTime: 1 })]]);
	await show(<LiveStepPeek thinkingLive={false} toolCallIds={["away-a", "away-b"]} />);
	Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
	await act(async () => document.dispatchEvent(new Event("visibilitychange")));
	await tools([
		["away-a", bash("echo a", { status: "done", endTime: 1 })],
		["away-b", bash("echo b", { startTime: 2 })],
	]);
	Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
	await act(async () => document.dispatchEvent(new Event("visibilitychange")));
	const chip = container.querySelector(".omp-work-catch-up");
	expect(chip?.textContent).toBe("1 step advanced while you were away");
	expect(chip?.parentElement?.className).toBe("omp-live-work-strip");
	expect(chip?.className).toContain("omp-live-work-chip");
	expect(rule(".omp-work-catch-up")).not.toMatch(/accent|background/);
});

it("#7 a note arriving mid-step does not re-run the narrative's fade", async () => {
	await tools([["run", bash("sleep 5", { intent: "Sleeping" })]]);
	await show(<LiveStepPeek thinkingLive={false} toolCallIds={["run"]} notes={[]} />);
	const note: AgentMessage = { role: "custom", customType: "irc", content: "Done", display: true, timestamp: 2 };
	await show(<LiveStepPeek thinkingLive={false} toolCallIds={["run"]} notes={[note]} />);
	expect(headFades()).toBe(0);
	await show(<LiveStepPeek thinkingLive={false} toolCallIds={["run"]} state="complete" notes={[note]} />);
	expect(headFades()).toBe(1);
});

it("#22 #24 insets the lane placeholder and aligns the card with the reply text", () => {
	expect(rule(".omp-work-stage .omp-work-frame > .omp-live-work-calm")).toContain(
		"padding: var(--sc-space-2) var(--sc-space-3)",
	);
	expect(rule(".omp-live-step")).toContain("margin: var(--sc-space-1) 0 var(--sc-space-2);");
	expect(stylesheet).not.toMatch(/\.omp-live-step \{\s*margin-inline-start/);
});

it("#38 the pending frame is the card's own head, not a bare spinner", async () => {
	await show(<WorkCardPending />);
	const card = container.querySelector(".omp-live-step[data-pending]");
	expect(card?.getAttribute("data-state")).toBe("running");
	expect(card?.querySelector(".omp-work-head .omp-work-narrative")?.textContent).toBe("Thinking…");
	expect(card?.querySelector(".omp-work-sub-shell")).not.toBeNull();
	expect(container.querySelector(".animate-spin")).toBeNull();
});
