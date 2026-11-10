/**
 * A steer delivered mid-run is the person's message in the chat, where the model took it: the card above ends there,
 * the run's next calls start a card under it, and the turn stays one. Only the newest card may run; the strip is one
 * row; crossfade layers never outlive their fade; the edit DSL never reaches the surface.
 */
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { type SubagentNode, useSubagentsStore } from "../../stores/subagents";
import { type ToolEntry, toolEntriesState, useToolsStore } from "../../stores/tools";
import { buildHistoryRows, type HistoryRow, liveWorkTail, workTurns } from "./chat-stream-utils";
import { resolveWorkGroup } from "./work/WorkStatus";
import { workTurnStartedAt } from "./work/work-turn";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
Object.assign(window, {
	requestAnimationFrame: () => 0,
	cancelAnimationFrame: () => {},
	matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	omp: { rpc: { command: async () => ({ success: true, data: { messages: [] } }) } },
});
// React DOM must initialize only after the linkedom browser globals exist.
const { createRoot } = await import("react-dom/client");
const { ExecutionGroup } = await import("./ExecutionGroup");
const { LiveStepPeek } = await import("./LiveStepPeek");
const { WorkCrossfade } = await import("./work/WorkCrossfade");
const { EditRenderer } = await import("../tools/renderers/EditRenderer");

const stylesheet = readFileSync(new URL("../../styles/components.css", import.meta.url), "utf8");
const rule = (selector: string) =>
	stylesheet.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]+)\\}`))?.[1] ?? "";

const prompt: AgentMessage = { role: "user", content: [{ type: "text", text: "Fix the lane race" }], timestamp: 100 };
const call = (id: string, name: string, timestamp: number): AgentMessage => ({
	role: "assistant",
	content: [{ type: "toolCall", id, name, arguments: name === "task" ? { agent: "debugger" } : { command: "ls" } }],
	timestamp,
});
const result = (id: string, name: string, timestamp: number): AgentMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName: name,
	content: [{ type: "text", text: "ok" }],
	isError: false,
	timestamp,
});
const steer: AgentMessage = {
	role: "user",
	content: [{ type: "text", text: "Also check CI speed" }],
	steering: true,
	timestamp: 300,
};
const answer: AgentMessage = { role: "assistant", content: [{ type: "text", text: "Done." }], timestamp: 600 };
const processes = (rows: HistoryRow[]) =>
	rows.filter((row): row is Extract<HistoryRow, { kind: "process" }> => row.kind === "process");

describe("steer inside a running turn", () => {
	it("is a chat row where the model took it: the card ends there and the run's next calls start one under it", () => {
		const delivered = [prompt, call("bash", "bash", 200), result("bash", "bash", 250), steer];
		const live = buildHistoryRows(delivered, "compact");
		expect(live.map(row => row.kind)).toEqual(["message", "process", "message"]);
		expect(live[2]).toEqual({ kind: "message", message: steer, inRun: true });
		// Until the next reply streams, the card above the steer is the live one; that reply's work is born under it.
		expect(liveWorkTail(live, true, false)).toEqual({ liveTail: true, lastWorkRow: 1 });
		expect(liveWorkTail(live, true, true).liveTail).toBe(false);

		const finished = buildHistoryRows(
			[...delivered, call("task", "task", 400), result("task", "task", 500), answer],
			"compact",
		);
		expect(finished.map(row => row.kind)).toEqual(["message", "process", "message", "process", "message"]);
		// Nothing above the steer moves when the turn ends.
		expect(finished.slice(0, 3)).toEqual(live);
		const [before, after] = processes(finished);
		expect(before?.toolCallIds).toEqual(["bash"]);
		expect(after?.toolCallIds).toEqual(["task"]);
		expect(before?.notes).toBeUndefined();
	});

	it("keeps the turn one: both cards share its start, its calls and its verdict scope", () => {
		const rows = buildHistoryRows(
			[prompt, call("bash", "bash", 200), result("bash", "bash", 250), steer, call("task", "task", 400)],
			"compact",
		);
		const [before, after] = processes(rows);
		if (!before || !after) throw new Error("cards missing");
		expect([before.turnStartedAt, after.turnStartedAt]).toEqual([100, 100]);
		const turns = workTurns(rows, true);
		expect(turns.get(before)?.turn).toBe(turns.get(after)?.turn);
		expect(turns.get(after)?.turn).toMatchObject({ ids: ["bash", "task"], running: true });
		expect([turns.get(before)?.last, turns.get(after)?.last]).toEqual([false, true]);
	});

	it("shows several steers in a row as consecutive bubbles, and an agent's note still joins the card above", () => {
		const second: AgentMessage = { ...steer, content: [{ type: "text", text: "And the cache" }], timestamp: 320 };
		const note: AgentMessage = {
			role: "custom",
			customType: "advisor",
			content: "Advisor",
			details: { notes: [{ note: "Check access", severity: "concern" }] },
			timestamp: 260,
		};
		const rows = buildHistoryRows(
			[
				prompt,
				call("bash", "bash", 200),
				result("bash", "bash", 250),
				note,
				steer,
				second,
				call("task", "task", 400),
			],
			"compact",
		);
		expect(rows.map(row => row.kind)).toEqual(["message", "process", "message", "message", "process"]);
		expect(rows.slice(2, 4)).toEqual([
			{ kind: "message", message: steer, inRun: true },
			{ kind: "message", message: second, inRun: true },
		]);
		expect(processes(rows)[0]?.notes).toEqual([note]);
	});

	it("still starts a new card for a message after the run ended, steered or not", () => {
		for (const next of [
			{ ...steer, timestamp: 700 },
			{ ...prompt, timestamp: 700 },
		]) {
			const rows = buildHistoryRows(
				[prompt, call("bash", "bash", 200), result("bash", "bash", 250), answer, next, call("task", "task", 800)],
				"compact",
			);
			expect(rows.map(row => row.kind)).toEqual(["message", "process", "message", "message", "process"]);
		}
		// A plain prompt after an unfinished (interrupted) run is a new turn, not a steer.
		const resumed = buildHistoryRows(
			[prompt, call("bash", "bash", 200), { ...prompt, timestamp: 700 }, call("task", "task", 800)],
			"compact",
		);
		expect(processes(resumed)).toHaveLength(2);
	});

	it("keeps the run's start across a delivered steer", () => {
		expect(workTurnStartedAt([prompt, call("bash", "bash", 200), result("bash", "bash", 250), steer])).toBe(200);
		expect(
			workTurnStartedAt([
				prompt,
				call("bash", "bash", 200),
				result("bash", "bash", 250),
				steer,
				call("t", "task", 400),
			]),
		).toBe(200);
	});
});

let root: Root;
let container: HTMLElement;
const running: ToolEntry = {
	toolName: "bash",
	args: { command: "ls" },
	streamingArgs: "",
	result: undefined,
	isError: false,
	status: "running",
	startTime: 1,
	endTime: null,
};
async function render(node: ReactNode) {
	await act(async () => root.render(<I18nProvider>{node}</I18nProvider>));
}
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(10_000);
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	useToolsStore.getState().reset();
	useSubagentsStore.getState().reset();
	vi.useRealTimers();
});

describe("one live card per session", () => {
	it("resolves a superseded card: cut-off calls are interrupted, running agents never run its head", () => {
		const agents = [{ status: "running", parent: "done" as const }];
		const tally = { live: false, runningTools: 1, failedTools: 0, reportedFailures: 0, interruptedTools: 0, agents };
		expect(resolveWorkGroup(tally).state).toBe("running");
		expect(resolveWorkGroup({ ...tally, superseded: true })).toMatchObject({
			state: "interrupted",
			runningAgents: 0,
		});
		expect(resolveWorkGroup({ ...tally, runningTools: 0, superseded: true }).state).toBe("complete");
	});

	it("renders no running head for a non-tail card whose agent still runs", async () => {
		useToolsStore.setState(
			toolEntriesState([["task", { ...running, toolName: "task", status: "done", endTime: 2 }]]),
		);
		const node: SubagentNode = {
			id: "LaneRace",
			index: 0,
			lastUpdate: 1,
			status: "running",
			agent: "debugger",
			parentToolCallId: "task",
		};
		useSubagentsStore.getState().setSnapshots([node]);
		const group = (superseded: boolean) => (
			<ExecutionGroup
				expanded={false}
				onExpandedChange={() => {}}
				stepCount={1}
				superseded={superseded}
				toolCallIds={["task"]}
			>
				{null}
			</ExecutionGroup>
		);
		await render(group(false));
		expect(container.querySelector(".omp-execution-group")?.getAttribute("data-state")).toBe("running");
		await render(group(true));
		expect(container.querySelector(".omp-execution-group")?.getAttribute("data-state")).toBe("complete");
		expect(container.querySelector('.omp-live-step[data-state="running"]')).toBeNull();
	});
});

describe("step strip", () => {
	it("keeps every step of an agent lane in one non-wrapping scroll row", async () => {
		const ids = Array.from({ length: 24 }, (_, index) => `step-${index}`);
		useToolsStore.setState(
			toolEntriesState(
				ids.map((id, index) => [
					id,
					{ ...running, status: index === 23 ? "running" : "done", startTime: index + 1 },
				]),
			),
		);
		await render(<LiveStepPeek nested thinkingLive={false} toolCallIds={ids} />);
		const strip = container.querySelector(".omp-live-work-strip");
		const rows = strip?.querySelectorAll(".omp-live-work-chips");
		expect(rows).toHaveLength(1);
		expect(rows?.[0]?.querySelectorAll(".omp-live-work-chip")).toHaveLength(24);
		for (const selector of [".omp-live-work-strip", ".omp-live-work-chips"]) {
			expect(rule(selector)).toContain("flex-wrap: nowrap");
		}
		expect(rule(".omp-live-work-chips")).toContain("overflow-x: auto");
	});
});

describe("crossfade layers", () => {
	const frame = (identity: string) => (
		<WorkCrossfade identity={identity} motion>
			<div>{identity}</div>
		</WorkCrossfade>
	);

	it("paints the incoming frame opaque above the outgoing one and unmounts it after the fade", async () => {
		await render(frame("a"));
		await render(frame("b"));
		const fade = container.querySelector(".omp-work-crossfade");
		const layers = [...(fade?.children ?? [])];
		expect(layers.map(layer => layer.hasAttribute("data-incoming"))).toEqual([true, false]);
		expect(fade?.querySelector("[data-outgoing]")?.textContent).toBe("a");
		const incoming = rule(".omp-work-frame[data-incoming]");
		expect(incoming).toContain("z-index: 1");
		expect(incoming).toContain("background:");
		await act(async () => vi.advanceTimersByTime(220));
		expect(fade?.querySelector("[data-outgoing]")).toBeNull();
		expect(fade?.children).toHaveLength(1);
	});

	it("drops the older frame when a third step arrives mid-fade and still ends with one layer", async () => {
		await render(frame("a"));
		await render(frame("b"));
		await act(async () => vi.advanceTimersByTime(100));
		await render(frame("c"));
		const fade = container.querySelector(".omp-work-crossfade");
		expect([...(fade?.querySelectorAll("[data-outgoing]") ?? [])].map(layer => layer.textContent)).toEqual(["b"]);
		await act(async () => vi.advanceTimersByTime(220));
		expect(fade?.querySelector("[data-outgoing]")).toBeNull();
		expect(fade?.textContent).toBe("c");
	});

	it("unmounts the outgoing frame as soon as its own fade ends", async () => {
		await render(frame("a"));
		await render(frame("b"));
		const outgoing = container.querySelector("[data-outgoing]");
		await act(async () => {
			outgoing?.dispatchEvent(new Event("animationend", { bubbles: true }));
		});
		expect(container.querySelector("[data-outgoing]")).toBeNull();
	});
});

describe("edit live preview", () => {
	it("never renders hashline input raw and adds no second heading", async () => {
		const args = { input: "[e2e/work-replay.test.ts#F879]\nP|" };
		await render(
			<EditRenderer args={args} result={undefined} isPartial isError={false} livePreview toolCallId="edit" />,
		);
		expect(container.textContent).not.toContain("P|");
		expect(container.textContent).not.toContain("#F879");
		expect(container.querySelector(".omp-tool-edit-heading")).toBeNull();
		await render(<EditRenderer args={args} result={undefined} isPartial isError={false} toolCallId="edit" />);
		expect(container.textContent).not.toContain("P|");
		expect(container.querySelectorAll(".omp-tool-edit-heading")).toHaveLength(1);
		expect(container.textContent).toContain("work-replay.test.ts");
	});
});
