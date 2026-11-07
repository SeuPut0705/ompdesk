import { describe, expect, it } from "vitest";
import {
	endedWithoutMessage,
	markCut,
	RESTART_CUT_STATUS,
	restartCutNote,
	restartCuts,
	transcriptOf,
	unmarkCut,
} from "./restart-cuts";
import type { AgentMessage } from "./rpc-types";

// 2 Nov 2026, the 0.94.0 → 0.94.1 update restart: each revived subagent ended at once, stock delivered
// "failed in 353ms" with its empty-message warning, and the transcript showed a failure.
describe("a subagent a restart cut", () => {
	const WARNING = "SYSTEM WARNING: Subagent ended without a final message.";
	const note = (
		subagents: Array<Record<string, unknown>>,
		timestamp = 2_000,
		customType = "ompdesk-restart-subagents",
	) =>
		({
			role: "custom",
			customType,
			timestamp,
			display: true,
			content: "These background agents you started are working again",
			details: { jobs: [], subagents },
		}) as AgentMessage;
	const failedDelivery = (body: string, jobId = "Reader", type = "task", timestamp = 9_000): AgentMessage => ({
		role: "custom",
		customType: "async-result",
		timestamp,
		content: `<system-notice>\nBackground job ${jobId} has failed.\n${body}\n</system-notice>`,
		details: { jobs: [{ jobId, agentId: jobId, type, status: "failed", label: jobId, durationMs: 353 }] },
	});
	const envelope = (inner: string) =>
		`<task-result id="Reader" agent="task" status="failed (exit 1)" duration="353ms">\n${inner}\n</task-result>`;
	const cutsOf = (messages: AgentMessage[], delivery: AgentMessage) =>
		restartCuts(messages).deliveries.get(delivery)?.get("Reader");

	it("reads stock's empty-message warning, an empty output and nothing at all as an end without a message", () => {
		expect(endedWithoutMessage(envelope(`<error>${WARNING}</error>\n<output>\n${WARNING}\n</output>`))).toBe(true);
		expect(endedWithoutMessage(envelope(`<output>\n${WARNING}\n</output>`))).toBe(true);
		expect(endedWithoutMessage(WARNING)).toBe(true);
		expect(endedWithoutMessage(envelope("<output>\n(no output) after 2 req\n</output>"))).toBe(true);
		expect(endedWithoutMessage(undefined)).toBe(true);
		expect(
			endedWithoutMessage(envelope("<error>Provider stream error</error>\n<output>\nhalf a sentence\n</output>")),
		).toBe(false);
		expect(endedWithoutMessage(envelope(`<error>boom</error>\n<output>\n${WARNING}\n</output>`))).toBe(false);
		expect(
			endedWithoutMessage(envelope(`<abort-reason>stopped</abort-reason>\n<output>\n${WARNING}\n</output>`)),
		).toBe(false);
	});

	it("is interrupted by the restart when an earlier note names it and stock's warning is all it ended with", () => {
		const delivery = failedDelivery(envelope(`<output>\n${WARNING}\n</output>`));
		const messages = [
			note([{ id: "Reader", intent: "Count alpha lines", doing: "bash: probing the stream" }]),
			delivery,
		];
		expect(cutsOf(messages, delivery)).toEqual({ intent: "Count alpha lines", doing: "bash: probing the stream" });
		expect(restartCuts(messages).agents.get("Reader")).toEqual({
			intent: "Count alpha lines",
			doing: "bash: probing the stream",
		});
		// The bridge's other restart notes name subagents the same way.
		expect(cutsOf([note([{ id: "Reader" }], 2_000, "ompdesk-restart-jobs"), delivery], delivery)).toEqual({});
	});

	it("stays a failure when no earlier note names the job, the note comes after, or the job is not a task", () => {
		const delivery = failedDelivery(envelope(`<output>\n${WARNING}\n</output>`));
		expect(cutsOf([delivery], delivery)).toBeUndefined();
		expect(cutsOf([note([{ id: "Scout" }]), delivery], delivery)).toBeUndefined();
		expect(cutsOf([delivery, note([{ id: "Reader" }])], delivery)).toBeUndefined();
		const bash = failedDelivery(envelope(`<output>\n${WARNING}\n</output>`), "Reader", "bash");
		expect(cutsOf([note([{ id: "Reader" }]), bash], bash)).toBeUndefined();
	});

	it("stays a failure when the agent died with a real error", () => {
		const delivery = failedDelivery(
			envelope("<error>Provider stream error</error>\n<output>\nhalf a sentence\n</output>"),
		);
		expect(cutsOf([note([{ id: "Reader" }]), delivery], delivery)).toBeUndefined();
		const completed: AgentMessage = {
			...failedDelivery(envelope("<output>\nall done\n</output>")),
			details: { jobs: [{ jobId: "Reader", type: "task", status: "completed" }] },
		};
		expect(cutsOf([note([{ id: "Reader" }]), completed], completed)).toBeUndefined();
	});

	it("takes the newest note naming the job, and a delivery settles the name for a later one", () => {
		const first = failedDelivery(envelope(`<output>\n${WARNING}\n</output>`), "Reader", "task", 5_000);
		const second = failedDelivery(envelope(`<output>\n${WARNING}\n</output>`), "Reader", "task", 9_000);
		const cuts = restartCuts([
			note([{ id: "Reader", doing: "old" }], 1_000),
			note([{ id: "Reader", doing: "new" }], 2_000),
			first,
			second,
		]);
		expect(cuts.deliveries.get(first)?.get("Reader")?.doing).toBe("new");
		expect(cuts.deliveries.get(second)).toBeUndefined();
	});

	it("names an agent as cut only while the delivery that ended its newest run was the restart's", () => {
		const cut = failedDelivery(envelope(`<output>\n${WARNING}\n</output>`), "Reader", "task", 5_000);
		const real = failedDelivery(envelope("<error>Provider stream error</error>"), "Reader", "task", 9_000);
		const cuts = restartCuts([note([{ id: "Reader", doing: "old" }]), cut, real]);
		// The cut run's own delivery still reads cut; the agent's newest run (a real failure) does not.
		expect(cuts.deliveries.get(cut)?.get("Reader")?.doing).toBe("old");
		expect(cuts.deliveries.get(real)).toBeUndefined();
		expect(cuts.agents.has("Reader")).toBe(false);
		const only = restartCuts([note([{ id: "Reader" }]), cut]);
		expect(only.deliveredBy.get("Reader")).toBe(cut);
	});

	it("marks a node only when it shows the run the cut ended", () => {
		const cuts = new Map([["Reader", { doing: "bash", run: 1 }]]);
		const node = (run: number | undefined, status = "failed") => ({ id: "Reader", status, run });
		expect(markCut(node(1), cuts).status).toBe(RESTART_CUT_STATUS);
		expect(markCut(node(2), cuts).status).toBe("failed");
		expect(markCut(node(undefined), cuts).status).toBe("failed");
		expect(markCut(node(1), cuts).restartCut).toEqual({ doing: "bash" });
	});

	it("indexes each transcript once, live messages joined behind the committed ones", () => {
		const delivery = failedDelivery(envelope(`<output>\n${WARNING}\n</output>`));
		const committed = [note([{ id: "Reader" }])];
		const live = [delivery];
		expect(restartCuts(committed)).toBe(restartCuts(committed));
		expect(transcriptOf(committed, [])).toBe(committed);
		expect(transcriptOf(committed, live)).toBe(transcriptOf(committed, live));
		expect(restartCuts(transcriptOf(committed, live)).deliveries.get(delivery)?.has("Reader")).toBe(true);
	});

	it("marks a failed agent the cuts name as restart-cut, keeping stock's status and what it was doing", () => {
		const cuts = new Map([["Reader", { doing: "bash: probing the stream" }]]);
		const node = (id: string, status: string) => ({ id, status });
		expect(markCut(node("Reader", "failed"), cuts)).toEqual({
			id: "Reader",
			status: RESTART_CUT_STATUS,
			stockStatus: "failed",
			restartCut: { doing: "bash: probing the stream" },
		});
		expect(markCut(node("Other", "failed"), cuts).status).toBe("failed");
		// An agent that runs again keeps running; marking is idempotent and undone by unmarkCut.
		expect(markCut(node("Reader", "running"), cuts).status).toBe("running");
		const marked = markCut(node("Reader", "failed"), cuts);
		expect(markCut(marked, cuts)).toBe(marked);
		expect(unmarkCut(marked)).toEqual(node("Reader", "failed"));
		expect(restartCutNote(marked)).toBe("bash: probing the stream");
		expect(restartCutNote({ restartCut: { intent: "Count" } })).toBe("Count");
	});
});
