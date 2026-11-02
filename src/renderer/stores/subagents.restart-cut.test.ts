/**
 * A subagent a restart ended (2 Nov 2026, the 0.94.0 → 0.94.1 update restart): stock reports `failed` with its
 * empty-message warning; every surface reading the tab's subagents store sees `restart-cut` instead, whichever of
 * the frame and the transcript's delivery arrives first.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentMessage, SubagentFrame } from "../../shared/rpc-types";
import { RESTART_CUT_STATUS } from "../lib/restart-cuts";
import { routeCommands } from "../test-support/route-commands";
import type { MessagesStore } from "./messages";
import { createMessagesStore } from "./messages";
import { deleteSessionRuntime, sessionRuntimeStore } from "./session-runtime-context";
import type { SubagentsStore } from "./subagents";
import { createSubagentsStore } from "./subagents";
import { bindRestartCuts, createTabRuntime } from "./tab-runtime";

const getSubagents = vi.fn();
beforeAll(() => {
	(globalThis as Record<string, unknown>).window = {
		omp: {
			rpc: {
				...routeCommands({ getSubagents }),
				commandForTab: vi.fn(async () => ({ type: "response", command: "x", success: true, data: {} })),
			},
		},
	};
});
afterEach(() => {
	getSubagents.mockReset();
	deleteSessionRuntime("tab-cut");
});

const WARNING = "SYSTEM WARNING: Subagent ended without a final message.";
const note = (subagents: Array<Record<string, unknown>>): AgentMessage => ({
	role: "custom",
	customType: "ompdesk-restart-subagents",
	timestamp: 1,
	display: true,
	content: "These background agents you started are working again",
	details: { jobs: [], subagents },
});
const delivery = (id = "LayoutSplit", inner = `<output>\n${WARNING}\n</output>`): AgentMessage => ({
	role: "custom",
	customType: "async-result",
	timestamp: 2,
	display: true,
	content: `<system-notice>\nBackground job ${id} has failed.\n<task-result id="${id}" agent="task" status="failed (exit 1)" duration="353ms">\n${inner}\n</task-result>\n</system-notice>`,
	details: { jobs: [{ jobId: id, agentId: id, type: "task", status: "failed", durationMs: 353 }] },
});
const lifecycle = (id: string, status: string): SubagentFrame => ({
	type: "subagent_lifecycle",
	payload: { id, index: 0, agent: "task", agentSource: "bundled", status } as never,
});

function bound() {
	const messages = createMessagesStore();
	const subagents = createSubagentsStore();
	bindRestartCuts(messages, subagents);
	return { messages, subagents };
}
const statusOf = (store: { getState: () => SubagentsStore }, id = "LayoutSplit") =>
	store.getState().subagents.get(id)?.status;

describe("restart-cut status in the subagents store", () => {
	it("turns a failed frame into restart-cut when an earlier restart note names it and its delivery says so", () => {
		const { messages, subagents } = bound();
		messages.setState({
			messages: [note([{ id: "LayoutSplit", intent: "Split the layout", doing: "bash: probing" }]), delivery()],
		});
		subagents.getState().applyFrame(lifecycle("LayoutSplit", "failed"));
		const node = subagents.getState().subagents.get("LayoutSplit");
		expect(node).toMatchObject({
			status: RESTART_CUT_STATUS,
			stockStatus: "failed",
			restartCut: { intent: "Split the layout", doing: "bash: probing" },
		});
	});

	it("marks a row already in the store when the transcript's delivery arrives after the frame", () => {
		const { messages, subagents } = bound();
		subagents.getState().applyFrame(lifecycle("LayoutSplit", "failed"));
		expect(statusOf(subagents)).toBe("failed");
		messages.setState({ messages: [note([{ id: "LayoutSplit" }]), delivery()] });
		expect(statusOf(subagents)).toBe(RESTART_CUT_STATUS);
	});

	it("reads a delivery that is still a live message", () => {
		const { messages, subagents } = bound();
		messages.setState({ messages: [note([{ id: "LayoutSplit" }])], liveMessages: [delivery()] });
		subagents.getState().applyFrame(lifecycle("LayoutSplit", "failed"));
		expect(statusOf(subagents)).toBe(RESTART_CUT_STATUS);
	});

	it("stays failed when no note names it or it died of a real error", () => {
		const { messages, subagents } = bound();
		messages.setState({
			messages: [
				note([{ id: "Other" }]),
				delivery("Other", "<error>Provider stream error</error>\n<output>\nhalf</output>"),
				delivery("LayoutSplit"),
			],
		});
		subagents.getState().applyFrame(lifecycle("LayoutSplit", "failed"));
		subagents.getState().applyFrame(lifecycle("Other", "failed"));
		expect(statusOf(subagents)).toBe("failed");
		expect(statusOf(subagents, "Other")).toBe("failed");
	});

	it("leaves an agent that runs again running, and shows the cut again if it fails again", () => {
		const { messages, subagents } = bound();
		messages.setState({ messages: [note([{ id: "LayoutSplit" }]), delivery()] });
		subagents.getState().applyFrame(lifecycle("LayoutSplit", "failed"));
		subagents.getState().applyFrame(lifecycle("LayoutSplit", "started"));
		expect(statusOf(subagents)).toBe("running");
		expect(subagents.getState().subagents.get("LayoutSplit")?.restartCut).toBeUndefined();
	});

	// The cut belongs to the run the restart ended, not to the agent: a later run of the same agent reads its own status.
	it("reads failed for a later run that fails for real, whether its delivery has landed or not", () => {
		const { messages, subagents } = bound();
		messages.setState({ messages: [note([{ id: "LayoutSplit" }]), delivery()] });
		subagents.getState().applyFrame(lifecycle("LayoutSplit", "failed"));
		expect(statusOf(subagents)).toBe(RESTART_CUT_STATUS);
		subagents.getState().applyFrame(lifecycle("LayoutSplit", "started"));
		subagents.getState().applyFrame(lifecycle("LayoutSplit", "failed"));
		// Its own delivery has not landed yet.
		expect(statusOf(subagents)).toBe("failed");
		expect(subagents.getState().subagents.get("LayoutSplit")?.restartCut).toBeUndefined();
		messages.setState({
			messages: [
				note([{ id: "LayoutSplit" }]),
				delivery(),
				delivery("LayoutSplit", "<error>Provider stream error</error>\n<output>\nhalf</output>"),
			],
		});
		expect(statusOf(subagents)).toBe("failed");
	});

	it("keeps a run the restart cut cut while it is the run shown, and cuts a later run a second restart ends", () => {
		const { messages, subagents } = bound();
		const first = delivery();
		messages.setState({ messages: [note([{ id: "LayoutSplit" }]), first] });
		subagents.getState().applyFrame(lifecycle("LayoutSplit", "failed"));
		subagents.getState().applyFrame(lifecycle("LayoutSplit", "failed"));
		expect(statusOf(subagents)).toBe(RESTART_CUT_STATUS);
		subagents.getState().applyFrame(lifecycle("LayoutSplit", "started"));
		const second = delivery();
		messages.setState({ messages: [note([{ id: "LayoutSplit" }]), first, note([{ id: "LayoutSplit" }]), second] });
		subagents.getState().applyFrame(lifecycle("LayoutSplit", "failed"));
		expect(statusOf(subagents)).toBe(RESTART_CUT_STATUS);
	});

	it("marks a fetched roster row and keeps the row's identity across idle polls", async () => {
		const { messages, subagents } = bound();
		messages.setState({ messages: [note([{ id: "LayoutSplit" }]), delivery()] });
		const row = { id: "LayoutSplit", index: 0, agent: "task", status: "failed", lastUpdate: 1 };
		getSubagents.mockResolvedValue({
			type: "response",
			command: "get_subagents",
			success: true,
			data: { subagents: [row] },
		});
		await subagents.getState().refresh();
		expect(statusOf(subagents)).toBe(RESTART_CUT_STATUS);
		const first = subagents.getState().subagents.get("LayoutSplit");
		await subagents.getState().refresh();
		expect(subagents.getState().subagents.get("LayoutSplit")).toBe(first);
	});

	it("unmarks when the transcript is replaced by one that does not say it", () => {
		const { messages, subagents } = bound();
		messages.setState({ messages: [note([{ id: "LayoutSplit" }]), delivery()] });
		subagents.getState().applyFrame(lifecycle("LayoutSplit", "failed"));
		messages.setState({ messages: [] });
		expect(statusOf(subagents)).toBe("failed");
	});

	it("is bound in every tab runtime", () => {
		createTabRuntime("tab-cut");
		const messages = sessionRuntimeStore<MessagesStore>("tab-cut", "messages")!;
		const subagents = sessionRuntimeStore<SubagentsStore>("tab-cut", "subagents")!;
		subagents.getState().applyFrame(lifecycle("LayoutSplit", "failed"));
		messages.setState({ messages: [note([{ id: "LayoutSplit" }]), delivery()] });
		expect(statusOf(subagents)).toBe(RESTART_CUT_STATUS);
	});
});
