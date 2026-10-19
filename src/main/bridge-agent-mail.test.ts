/**
 * gui-bridge agent-control.ts `agent_control.mail`: a report from another session becomes one stock custom message
 * (`pi.sendMessage`, customType `ompdesk.mail`) with the delivery main chose, a no-turn report that finds a turn running
 * waits for its end (listed by the `mail_pending` frame meanwhile), and a report whose id the session's journal (or
 * this process) already holds is never sent twice: a relaunch of either side does not repeat it. The installed omp's
 * side of it: bridge-agent-mail-stock.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { install, methods } from "../../resources/gui-bridge/agent-control";
import { MAIL_CUSTOM_TYPE, MAIL_PENDING_EVENT } from "../../resources/gui-bridge/agent-control-contracts";

type BridgeEnv = Parameters<NonNullable<(typeof methods)[string]>>[1];

const sendMessage = vi.fn();
install({ on: () => undefined, sendMessage });

interface FakeSession {
	isStreaming: boolean;
	sessionId: string;
	branch: unknown[];
}

function env(session: Partial<FakeSession> = {}, events: unknown[] = []): BridgeEnv & { live: FakeSession } {
	const live: FakeSession = { isStreaming: false, sessionId: "s1", branch: [], ...session };
	return {
		live,
		session: () => ({ ...live, sessionManager: { getBranch: () => live.branch } }),
		emit: (event: unknown) => events.push(event),
	} as unknown as BridgeEnv & { live: FakeSession };
}

const mail = methods["agent_control.mail"];
const pending = methods["agent_control.mail_pending"];

afterEach(() => {
	vi.useRealTimers();
	sendMessage.mockClear();
});

describe("agent_control.mail", () => {
	it("hands the report to stock sendMessage with main's delivery", async () => {
		await mail?.(
			{ content: "<ompdesk-mail …>", details: { id: "m1", kind: "done" }, triggerTurn: true, deliverAs: "followUp" },
			env(),
		);
		expect(sendMessage).toHaveBeenLastCalledWith(
			{
				customType: MAIL_CUSTOM_TYPE,
				content: "<ompdesk-mail …>",
				display: true,
				details: { id: "m1", kind: "done" },
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	});

	it("drops a report the journal already holds, and one this process already queued", async () => {
		const journaled = env({
			branch: [{ type: "custom_message", customType: MAIL_CUSTOM_TYPE, details: { id: "m2" } }],
		});
		expect(await mail?.({ content: "x", details: { id: "m2" }, triggerTurn: true }, journaled)).toEqual({
			duplicate: true,
		});
		await mail?.({ content: "x", details: { id: "m3" }, triggerTurn: false }, env());
		expect(await mail?.({ content: "x", details: { id: "m3" }, triggerTurn: false }, env())).toEqual({
			duplicate: true,
		});
		expect(sendMessage).toHaveBeenCalledTimes(1);
	});

	it("holds a no-turn report while a turn runs and hands it to stock's idle delivery once the turn ends", async () => {
		vi.useFakeTimers();
		const events: unknown[] = [];
		const busy = env({ isStreaming: true }, events);
		const progress = { id: "p1", kind: "progress", from: "c1", fromTitle: "Child", text: "half way" };
		expect(await mail?.({ content: "p", details: progress, triggerTurn: false }, busy)).toEqual({ held: true });
		await mail?.({ content: "n", details: { id: "n1", kind: "note", from: "c2" }, triggerTurn: false }, busy);
		const items = [
			{ id: "p1", from: "Child", kind: "progress" },
			{ id: "n1", from: "c2", kind: "note" },
		];
		expect(events.at(-1)).toEqual({ type: MAIL_PENDING_EVENT, items });
		expect(await pending?.({}, busy)).toEqual({ items });
		// A report that wakes the session is stock's to queue: never held.
		await mail?.(
			{ content: "q", details: { id: "q1", kind: "question" }, triggerTurn: true, deliverAs: "aside" },
			busy,
		);
		expect(sendMessage.mock.calls.map(call => call[0].details.id)).toEqual(["q1"]);

		vi.advanceTimersByTime(1_000);
		expect(sendMessage).toHaveBeenCalledTimes(1);
		busy.live.isStreaming = false;
		vi.advanceTimersByTime(250);
		expect(sendMessage.mock.calls.slice(1)).toEqual([
			[expect.objectContaining({ content: "p", details: progress }), { triggerTurn: false }],
			[expect.objectContaining({ content: "n" }), { triggerTurn: false }],
		]);
		expect(events.at(-1)).toEqual({ type: MAIL_PENDING_EVENT, items: [] });
		expect(await pending?.({}, busy)).toEqual({ items: [] });
		vi.advanceTimersByTime(1_000);
		expect(sendMessage).toHaveBeenCalledTimes(3);
	});

	it("drops a held report when the tab moved to another session before the turn ended", async () => {
		vi.useFakeTimers();
		const busy = env({ isStreaming: true });
		await mail?.({ content: "p", details: { id: "p2", kind: "progress" }, triggerTurn: false }, busy);
		busy.live.sessionId = "s2";
		busy.live.isStreaming = false;
		vi.advanceTimersByTime(250);
		expect(sendMessage).not.toHaveBeenCalled();
		expect(await pending?.({}, busy)).toEqual({ items: [] });
	});
});
