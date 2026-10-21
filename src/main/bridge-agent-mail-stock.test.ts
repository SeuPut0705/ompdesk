import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import {
	atEnd,
	type Frame,
	HOLD,
	journaledMail,
	mail,
	type Omp,
	omp,
	PARALLEL,
	type Provider,
	runCleanups,
	shown,
	startOmp,
	startProvider,
	WAIT,
} from "./bridge-agent-mail-stock-harness";

afterAll(runCleanups);

/**
 * A report another session sends (`ompdesk_report`) reaches a busy receiver between its steps, not after its turn:
 * main's delivery (`deliveryFor`) through the bridge's `agent_control.mail` on the installed omp, with a scripted
 * OpenAI-compatible provider on loopback (no model spend).
 *
 * Reported on 21 Oct 2026: an orchestrating session sat in a long `wait` on a background job while four child reports
 * waited for its turn to end ("이 턴이 끝나면 보여요"). `done`/`review` went as stock `followUp` (read only after the
 * turn) and progress/note were held by the bridge until it ended. Every kind now goes as stock's `aside`: injected at
 * the next step boundary without cutting the tool batch (a `steer` would skip the batch's remaining calls), and an
 * interruptible `wait` returns on it.
 */
async function idleOmp(provider: Provider): Promise<Omp> {
	const session = await startOmp(provider);
	// Stock writes the session file with its first reply.
	await session.send({ type: "prompt", message: "first" });
	await expect.poll(() => ended(session.frames), { timeout: 30_000 }).toBe(1);
	return session;
}

const ended = (frames: readonly Frame[]) => frames.filter(frame => frame.type === "agent_end").length;
const toolEnds = (frames: readonly Frame[]) => frames.filter(frame => frame.type === "tool_execution_end");

/** The first main-agent request that carries the report (its id is the report's text). */
const firstWith = (provider: Provider, id: string) => provider.bodies.findIndex(body => body.includes(id));

describe.skipIf(!existsSync(omp))("a report to a busy receiver on stock omp", () => {
	it("reaches the model at the next step boundary of the same turn, and every call of the batch runs", async () => {
		const provider = await startProvider();
		provider.release();
		atEnd(() => provider.close());
		const session = await idleOmp(provider);
		await session.send({ type: "prompt", message: PARALLEL });
		await expect
			.poll(() => session.frames.filter(frame => frame.type === "tool_execution_start").length, { timeout: 30_000 })
			.toBe(2);
		expect(await session.bridge.request("agent_control.mail", mail("done", "batch-done"))).toEqual({});
		expect(await session.bridge.request("agent_control.mail", mail("note", "batch-note"))).toEqual({});
		await expect.poll(() => ended(session.frames), { timeout: 30_000 }).toBe(2);

		// Both calls ran to the end: none skipped for a queued message.
		const ends = toolEnds(session.frames);
		expect(ends.map(frame => frame.toolCallId).sort()).toEqual(["call_a", "call_b"]);
		expect(ends.map(frame => frame.isError)).toEqual([false, false]);
		expect(JSON.stringify(ends.map(frame => frame.result))).not.toMatch(/Skipped/);
		// The request that carries the batch's results carries both reports: read within the turn, no extra request.
		const afterBatch = provider.bodies.findIndex(body => body.includes('"role":"tool"'));
		expect(afterBatch).toBe(2);
		expect(firstWith(provider, "batch-done")).toBe(afterBatch);
		expect(firstWith(provider, "batch-note")).toBe(afterBatch);
		expect(provider.turns).toBe(3);
		expect(journaledMail(session.isolated)).toEqual(["batch-done", "batch-note"]);
	}, 180_000);

	it("ends a wait on a background job: the wait returns on the report and the model reads it", async () => {
		const provider = await startProvider();
		provider.release();
		atEnd(() => provider.close());
		const session = await idleOmp(provider);
		await session.send({ type: "prompt", message: WAIT });
		await expect
			.poll(
				() =>
					session.frames.some(frame => frame.type === "tool_execution_start" && frame.toolCallId === "call_wait"),
				{ timeout: 30_000 },
			)
			.toBe(true);
		const sent = Date.now();
		expect(await session.bridge.request("agent_control.mail", mail("done", "wait-done"))).toEqual({});
		await expect
			.poll(() => toolEnds(session.frames).some(frame => frame.toolCallId === "call_wait"), { timeout: 15_000 })
			.toBe(true);
		// The job sleeps 300 s; the wait returned on the report.
		expect(Date.now() - sent).toBeLessThan(15_000);
		await expect.poll(() => ended(session.frames), { timeout: 30_000 }).toBe(2);
		const afterWait = provider.bodies.findIndex(body => body.split('"role":"tool"').length - 1 === 2);
		expect(afterWait).toBeGreaterThan(0);
		expect(firstWith(provider, "wait-done")).toBe(afterWait);
		expect(journaledMail(session.isolated)).toEqual(["wait-done"]);
	}, 180_000);

	it("costs one more model request for a note that lands while the turn's last reply streams", async () => {
		const provider = await startProvider();
		atEnd(() => provider.close());
		const session = await startOmp(provider);
		await session.send({ type: "prompt", message: HOLD });
		await provider.held;
		const turns = provider.turns;
		expect(await session.bridge.request("agent_control.mail", mail("note", "tail-note"))).toEqual({});
		provider.release();
		await expect.poll(() => ended(session.frames), { timeout: 30_000 }).toBe(1);
		// Stock's stop boundary drains the aside into one more request of the same run, then the turn ends.
		expect(provider.turns).toBe(turns + 1);
		expect(firstWith(provider, "tail-note")).toBe(provider.bodies.length - 1);
		expect(shown(session.frames, "tail-note")).toBe(true);
		expect(journaledMail(session.isolated)).toEqual(["tail-note"]);
	}, 180_000);
});

describe.skipIf(!existsSync(omp))("a report to an idle receiver on stock omp", () => {
	it("starts a turn on a done report", async () => {
		const provider = await startProvider();
		provider.release();
		atEnd(() => provider.close());
		const session = await idleOmp(provider);
		const turns = provider.turns;
		await session.bridge.request("agent_control.mail", mail("done", "idle-done"));
		await expect.poll(() => ended(session.frames), { timeout: 30_000 }).toBe(2);
		expect(provider.turns).toBe(turns + 1);
		expect(firstWith(provider, "idle-done")).toBe(provider.bodies.length - 1);
		expect(journaledMail(session.isolated)).toEqual(["idle-done"]);
	}, 180_000);

	it("shows a progress at once, without a turn", async () => {
		const provider = await startProvider();
		provider.release();
		atEnd(() => provider.close());
		const session = await idleOmp(provider);
		const turns = provider.turns;
		await session.bridge.request("agent_control.mail", mail("progress", "idle-progress"));
		await expect.poll(() => shown(session.frames, "idle-progress"), { timeout: 3_000 }).toBe(true);
		expect(journaledMail(session.isolated)).toEqual(["idle-progress"]);
		expect(provider.turns).toBe(turns);
	}, 180_000);
});
