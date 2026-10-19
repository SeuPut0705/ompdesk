/**
 * gui-bridge agent-control.ts `agent_control.mail`: a report from another session becomes one stock custom message
 * (`pi.sendMessage`, customType `ompdesk.mail`) with the delivery main chose, and a report whose id the session's
 * journal (or this process) already holds is never sent twice: a relaunch of either side does not repeat it.
 */
import { describe, expect, it, vi } from "vitest";
import { install, methods } from "../../resources/gui-bridge/agent-control";
import { MAIL_CUSTOM_TYPE } from "../../resources/gui-bridge/agent-control-contracts";

type BridgeEnv = Parameters<NonNullable<(typeof methods)[string]>>[1];

const sendMessage = vi.fn();
install({ on: () => undefined, sendMessage });

function env(branch: unknown[] = []): BridgeEnv {
	return { session: () => ({ sessionManager: { getBranch: () => branch } }) } as unknown as BridgeEnv;
}

const mail = methods["agent_control.mail"];

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
		sendMessage.mockClear();
		const journaled = env([{ type: "custom_message", customType: MAIL_CUSTOM_TYPE, details: { id: "m2" } }]);
		expect(await mail?.({ content: "x", details: { id: "m2" }, triggerTurn: true }, journaled)).toEqual({
			duplicate: true,
		});
		await mail?.({ content: "x", details: { id: "m3" }, triggerTurn: false }, env());
		expect(await mail?.({ content: "x", details: { id: "m3" }, triggerTurn: false }, env())).toEqual({
			duplicate: true,
		});
		expect(sendMessage).toHaveBeenCalledTimes(1);
	});
});
