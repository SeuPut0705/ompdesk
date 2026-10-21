/**
 * gui-bridge agent-control.ts `agent_control.mail`: a report from another session becomes one stock custom message
 * (`pi.sendMessage`, customType `ompdesk.mail`) with the delivery main chose; a no-turn report that finds a turn running
 * goes as an `aside` (read at the next step boundary), one to an idle session keeps stock's plain delivery (an aside
 * would start a turn); a report whose id the session's journal (or this process) already holds is never sent twice.
 * The installed omp's side of it: bridge-agent-mail-stock.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { install, methods } from "../../resources/gui-bridge/agent-control";
import { MAIL_CUSTOM_TYPE } from "../../resources/gui-bridge/agent-control-contracts";

type BridgeEnv = Parameters<NonNullable<(typeof methods)[string]>>[1];

const sendMessage = vi.fn();
install({ on: () => undefined, sendMessage });

function env(session: { isStreaming?: boolean; branch?: unknown[] } = {}): BridgeEnv {
	const branch = session.branch ?? [];
	return {
		session: () => ({
			isStreaming: session.isStreaming ?? false,
			sessionId: "s1",
			sessionManager: { getBranch: () => branch },
		}),
		emit: () => undefined,
	} as unknown as BridgeEnv;
}

const mail = methods["agent_control.mail"];

afterEach(() => {
	sendMessage.mockClear();
});

describe("agent_control.mail", () => {
	it("hands the report to stock sendMessage with main's delivery", async () => {
		await mail?.(
			{ content: "<ompdesk-mail …>", details: { id: "m1", kind: "done" }, triggerTurn: true, deliverAs: "aside" },
			env(),
		);
		expect(sendMessage).toHaveBeenLastCalledWith(
			{
				customType: MAIL_CUSTOM_TYPE,
				content: "<ompdesk-mail …>",
				display: true,
				details: { id: "m1", kind: "done" },
			},
			{ triggerTurn: true, deliverAs: "aside" },
		);
	});

	it("drops a report the journal already holds, and one this process already handed to stock", async () => {
		const journaled = env({
			branch: [{ type: "custom_message", customType: MAIL_CUSTOM_TYPE, details: { id: "m2" } }],
		});
		expect(await mail?.({ content: "x", details: { id: "m2" }, triggerTurn: true }, journaled)).toEqual({
			duplicate: true,
			journaled: true,
		});
		await mail?.({ content: "x", details: { id: "m3" }, triggerTurn: false }, env());
		expect(await mail?.({ content: "x", details: { id: "m3" }, triggerTurn: false }, env())).toEqual({
			duplicate: true,
			journaled: false,
		});
		expect(sendMessage).toHaveBeenCalledTimes(1);
	});

	it("sends a no-turn report as an aside while a turn runs, and plainly to an idle session", async () => {
		const busy = env({ isStreaming: true });
		await mail?.({ content: "busy", details: { id: "m4", kind: "progress" }, triggerTurn: false }, busy);
		expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ content: "busy" }), {
			triggerTurn: false,
			deliverAs: "aside",
		});
		await mail?.({ content: "idle", details: { id: "m5", kind: "note" }, triggerTurn: false }, env());
		expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ content: "idle" }), {
			triggerTurn: false,
		});
	});

	it("never passes on a delivery that would cut a running tool batch (an older main's followUp)", async () => {
		await mail?.(
			{ content: "old", details: { id: "m6", kind: "done" }, triggerTurn: true, deliverAs: "followUp" },
			env({ isStreaming: true }),
		);
		expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ content: "old" }), {
			triggerTurn: true,
			deliverAs: "aside",
		});
	});
});
