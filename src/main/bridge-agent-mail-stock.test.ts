import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import {
	atEnd,
	HOLD,
	journaledMail,
	mail,
	omp,
	runCleanups,
	shown,
	startOmp,
	startProvider,
} from "./bridge-agent-mail-stock-harness";

afterAll(runCleanups);

/**
 * A report another session sends while this session runs a turn (`ompdesk_report` progress or note, and the "Closed …"
 * line of a close) shows in its transcript once that turn ends, with no prompt of the person's: main's delivery
 * (`deliveryFor`) through the bridge's `agent_control.mail` on the installed omp, with a scripted OpenAI-compatible
 * provider on loopback (no model spend).
 *
 * Reported on 19 Oct 2026: a parent's progress and close notes stayed out of its transcript for half an hour and then
 * all appeared at once when the person sent a message. Main handed a busy receiver's no-turn report to stock as
 * `deliverAs: "nextTurn"`, which stock keeps hidden (no `message_start`/`message_end`, not journaled) until the next
 * explicit prompt; a turn a done report wakes does not take it either.
 */
describe.skipIf(!existsSync(omp))("a no-turn report on stock omp", () => {
	it("shows a progress and a note sent during a turn once the turn ends, without a prompt or a model turn", async () => {
		const provider = await startProvider();
		atEnd(() => provider.close());
		const session = await startOmp(provider);
		await session.send({ type: "prompt", message: HOLD });
		await provider.held;
		await session.bridge.request("agent_control.mail", mail("progress", "busy-progress"));
		await session.bridge.request("agent_control.mail", mail("note", "busy-note"));
		// Held while the turn runs: neither is in the transcript or the model's context yet; the bridge lists both.
		expect(shown(session.frames, "busy-progress")).toBe(false);
		expect(await session.bridge.request("agent_control.mail_pending", {})).toEqual({
			items: [
				{ id: "busy-progress", from: "Child", kind: "progress" },
				{ id: "busy-note", from: "Child", kind: "note" },
			],
		});
		const turns = provider.turns;
		provider.release();
		await expect.poll(() => session.frames.some(frame => frame.type === "agent_end"), { timeout: 30_000 }).toBe(true);
		await expect.poll(() => shown(session.frames, "busy-progress"), { timeout: 3_000 }).toBe(true);
		await expect.poll(() => shown(session.frames, "busy-note"), { timeout: 3_000 }).toBe(true);
		await expect
			.poll(() => journaledMail(session.isolated), { timeout: 3_000 })
			.toEqual(["busy-progress", "busy-note"]);
		expect(await session.bridge.request("agent_control.mail_pending", {})).toEqual({ items: [] });
		// No turn was started for them.
		expect(provider.turns).toBe(turns);
	}, 180_000);

	it("shows a progress sent to an idle session at once", async () => {
		const provider = await startProvider();
		provider.release();
		atEnd(() => provider.close());
		const session = await startOmp(provider);
		// Stock writes the session file with its first reply.
		await session.send({ type: "prompt", message: "first" });
		await expect.poll(() => session.frames.some(frame => frame.type === "agent_end"), { timeout: 30_000 }).toBe(true);
		const turns = provider.turns;
		await session.bridge.request("agent_control.mail", mail("progress", "idle-progress"));
		await expect.poll(() => shown(session.frames, "idle-progress"), { timeout: 3_000 }).toBe(true);
		expect(journaledMail(session.isolated)).toEqual(["idle-progress"]);
		expect(provider.turns).toBe(turns);
	}, 180_000);
});
