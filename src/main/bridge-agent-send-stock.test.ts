import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { wrapAgentMessage } from "../shared/agent-control";
import {
	atEnd,
	CARD,
	type Frame,
	type Omp,
	type Provider,
	runCleanups,
	STEPS,
	startOmp,
	startProvider,
} from "./bridge-agent-mail-stock-harness";
import { INSTALLED_OMP as omp } from "./test-bridge-probe";

afterAll(runCleanups);

/**
 * What a message another session's agent sends (`ompdesk_session_send`: stock `prompt` with the `streamingBehavior`
 * main chose) does to a receiver in the middle of a turn, on the installed omp with a scripted provider on loopback (no
 * model spend). The turn takes three steps, one shell call each, then replies.
 *
 * Reported on 12 Nov 2026: what agents sent each other was not delivered right away, and the person pressed 지금 추가
 * 지시 on it. The sender had asked for `follow_up`, which stock holds in the receiver's queue, where the person sees it,
 * until the turn's last reply; a steer is read at the next step. So main steers whatever reaches a running session the
 * sender did not open (`AgentControl.#handSend`), except while that session shows the person a card: stock reads a
 * message main sends as the person's, and closes the card for it.
 */
async function busyOmp(): Promise<{ provider: Provider; session: Omp }> {
	const provider = await startProvider();
	provider.release();
	atEnd(() => provider.close());
	const session = await startOmp(provider);
	// Stock writes the session file with its first reply; the turn under test comes after it.
	await session.send({ type: "prompt", message: "first" });
	await expect.poll(() => ended(session.frames), { timeout: 30_000 }).toBe(1);
	await session.send({ type: "prompt", message: STEPS });
	await expect
		.poll(
			() => session.frames.some(frame => frame.type === "tool_execution_start" && frame.toolCallId === "call_s1"),
			{
				timeout: 30_000,
			},
		)
		.toBe(true);
	return { provider, session };
}

const ended = (frames: readonly Frame[]) => frames.filter(frame => frame.type === "agent_end").length;

/** The first main-agent request that carries the message. */
const firstWith = (provider: Provider, text: string) => provider.bodies.findIndex(body => body.includes(text));

describe.skipIf(!existsSync(omp))("a message another session sends to a busy receiver on stock omp", () => {
	it("as a steer, is read at the next step of the same turn, and no call of the turn is skipped", async () => {
		const { provider, session } = await busyOmp();
		const answer = await session.send({
			type: "prompt",
			message: wrapAgentMessage("steer-now", "Other"),
			streamingBehavior: "steer",
		});
		expect(answer.success).toBe(true);
		await expect.poll(() => ended(session.frames), { timeout: 30_000 }).toBe(2);

		// Requests: the first prompt's reply, then the turn's first step, then the one that carries the message.
		expect(firstWith(provider, "steer-now")).toBe(2);
		// It rode a step the turn made anyway: three steps and the reply, no extra request.
		expect(provider.turns).toBe(5);
		const ends = session.frames.filter(frame => frame.type === "tool_execution_end");
		expect(ends.map(frame => frame.toolCallId)).toEqual(["call_s1", "call_s2", "call_s3"]);
		expect(ends.map(frame => frame.isError)).toEqual([false, false, false]);
		expect(session.frames.some(frame => frame.type === "queue_update" && frame.followUp?.length)).toBe(false);
	}, 180_000);

	it("as a follow-up, waits in the receiver's queue until the turn's last reply", async () => {
		const { provider, session } = await busyOmp();
		await session.send({
			type: "prompt",
			message: wrapAgentMessage("follow-later", "Other"),
			streamingBehavior: "followUp",
		});
		// What the person sees meanwhile: one message waiting in that session's queue.
		expect((await session.send({ type: "get_state" })).data).toMatchObject({ queuedMessageCount: 1 });
		await expect.poll(() => ended(session.frames), { timeout: 30_000 }).toBe(2);

		// Read only after the turn's three steps and its reply.
		expect(firstWith(provider, "follow-later")).toBe(5);
		expect(provider.turns).toBe(6);
	}, 180_000);
});

describe.skipIf(!existsSync(omp))("a message another session sends while the receiver shows the person a card", () => {
	const isCard = (frame: Frame) => frame.type === "extension_ui_request" && frame.method === "select";
	const askResult = (frames: readonly Frame[]) =>
		JSON.stringify(
			frames.find(frame => frame.type === "tool_execution_end" && frame.toolCallId === "call_ask")?.result,
		);

	async function cardOpen(): Promise<{ provider: Provider; session: Omp; card: Frame }> {
		const provider = await startProvider();
		provider.release();
		atEnd(() => provider.close());
		const session = await startOmp(provider);
		await session.send({ type: "prompt", message: CARD });
		await expect.poll(() => session.frames.some(isCard), { timeout: 30_000 }).toBe(true);
		return { provider, session, card: session.frames.find(isCard) as Frame };
	}

	it("as a steer, closes the card, and the model reads the message instead of the person's answer", async () => {
		const { provider, session, card } = await cardOpen();
		await session.send({
			type: "prompt",
			message: wrapAgentMessage("steer-card", "Other"),
			streamingBehavior: "steer",
		});
		await expect.poll(() => ended(session.frames), { timeout: 30_000 }).toBe(1);
		expect(
			session.frames.some(
				frame => frame.type === "extension_ui_request" && frame.method === "cancel" && frame.targetId === card.id,
			),
		).toBe(true);
		expect(askResult(session.frames)).toContain("Ask interrupted by message");
		expect(firstWith(provider, "steer-card")).toBe(1);
	}, 180_000);

	it("as a follow-up, leaves the card to the person and is read after the turn their answer goes on with", async () => {
		const { provider, session, card } = await cardOpen();
		await session.send({
			type: "prompt",
			message: wrapAgentMessage("follow-card", "Other"),
			streamingBehavior: "followUp",
		});
		session.write({ type: "extension_ui_response", id: card.id, value: card.options?.[0] });
		await expect.poll(() => ended(session.frames), { timeout: 30_000 }).toBe(1);
		expect(session.frames.some(frame => frame.type === "extension_ui_request" && frame.method === "cancel")).toBe(
			false,
		);
		expect(askResult(session.frames)).not.toContain("interrupted");
		// Requests: the card, the answer, then the message.
		expect(firstWith(provider, "follow-card")).toBe(2);
	}, 180_000);
});
