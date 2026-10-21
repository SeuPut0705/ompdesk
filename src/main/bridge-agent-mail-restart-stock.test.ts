import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { deliveryFor, type MailKind } from "./agent-control/mail";
import { MailOutbox, redeliverMail } from "./agent-control/mail-outbox";
import {
	atEnd,
	HOLD,
	journaledMail,
	mail,
	type Omp,
	omp,
	type Provider,
	runCleanups,
	sessionFiles,
	startOmp,
	startProvider,
	TOOL,
} from "./bridge-agent-mail-stock-harness";

/**
 * What stock omp does with a report its bridge accepted while a turn runs, when the omp is closed the way a quit closes
 * it (stdin ends and stock disposes the session), measured on the installed omp with a scripted provider on loopback.
 *
 * Reported on 21 Oct 2026: a child's `done` to its parent, inside a long tool call, was never journaled after an update
 * restart. A `done`/`review` report is a `followUp`: stock keeps it in an in-memory queue and journals it only when it
 * starts the turn that answers it, so closing the omp drops it. A `question`/`blocked` report is an `aside`: stock
 * journals it at once. Main therefore keeps each accepted `followUp` report until the receiver's journal holds it
 * (`agent-control/mail-outbox.ts`) and sends it again, with its id, to the omp that replaces the closed one; the bridge
 * answers whether an id is journaled or only queued so main knows when it is done.
 */
afterAll(runCleanups);

async function busyOmp(prompt: string): Promise<{ provider: Provider; session: Omp }> {
	const provider = await startProvider();
	atEnd(() => provider.close());
	const session = await startOmp(provider);
	// Stock writes the session file with its first reply; the turn under test comes after it.
	await session.send({ type: "prompt", message: "first" });
	await expect.poll(() => session.frames.some(frame => frame.type === "agent_end"), { timeout: 30_000 }).toBe(true);
	await session.send({ type: "prompt", message: prompt });
	if (prompt === TOOL)
		await expect
			.poll(() => session.frames.some(frame => frame.type === "tool_execution_start"), { timeout: 30_000 })
			.toBe(true);
	else await expect.poll(() => provider.turns, { timeout: 30_000 }).toBeGreaterThan(1);
	return { provider, session };
}

describe.skipIf(!existsSync(omp))("a report accepted by a busy receiver whose omp is then closed", () => {
	const cases: Array<[MailKind, string, string, boolean]> = [
		["done", "a model request", HOLD, false],
		["done", "a tool call", TOOL, false],
		["review", "a model request", HOLD, false],
		["question", "a model request", HOLD, true],
		["question", "a tool call", TOOL, true],
		["blocked", "a tool call", TOOL, true],
	];
	for (const [kind, where, prompt, journaled] of cases) {
		it(`${journaled ? "is journaled" : "is lost"}: ${kind} during ${where}`, async () => {
			const { session } = await busyOmp(prompt);
			expect(await session.bridge.request("agent_control.mail", mail(kind, `m-${kind}`))).toEqual({});
			await session.stop();
			expect(journaledMail(session.isolated)).toEqual(journaled ? [`m-${kind}`] : []);
		}, 120_000);
	}

	it("reaches the journal once, from the omp that replaces the closed one, through the outbox", async () => {
		const { provider, session } = await busyOmp(HOLD);
		const outbox = new MailOutbox(null);
		const report = mail("done", "report-1");
		// What main does when the receiver accepts a report: keep it until the journal holds it.
		expect(await session.bridge.request("agent_control.mail", report)).toEqual({});
		outbox.keep({
			id: "report-1",
			sessionPath: "/s/receiver.jsonl",
			content: report.content,
			details: report.details,
			delivery: deliveryFor("done"),
			at: Date.now(),
		});
		await session.stop();
		expect(journaledMail(session.isolated)).toEqual([]);

		// The relaunch: the same session file in a new omp, busy again (its history holds the held prompt).
		const [file] = sessionFiles(session.isolated);
		const again = await startOmp(provider, {
			isolated: session.isolated,
			root: session.root,
			session: file as string,
		});
		await again.send({ type: "prompt", message: "continue" });
		await expect.poll(() => provider.turns, { timeout: 30_000 }).toBeGreaterThan(2);
		const asked: unknown[] = [];
		const pass = () =>
			redeliverMail(outbox, {
				tabOf: () => "tab",
				send: async (_tab, entry) => {
					const answer = await again.bridge.request<{ duplicate?: boolean; journaled?: boolean }>(
						"agent_control.mail",
						{
							content: entry.content,
							details: entry.details,
							...entry.delivery,
						},
					);
					asked.push(answer);
					return answer;
				},
			});

		// First pass delivers it to the new omp; the second finds it queued there, not journaled, and sends nothing.
		await pass();
		await pass();
		expect(asked).toEqual([{}, { duplicate: true, journaled: false }]);
		expect(outbox.pending()).toHaveLength(1);
		expect(journaledMail(session.isolated)).toEqual([]);

		provider.release();
		await expect.poll(() => journaledMail(session.isolated), { timeout: 30_000 }).toEqual(["report-1"]);
		await pass();
		expect(asked.at(-1)).toEqual({ duplicate: true, journaled: true });
		expect(outbox.pending()).toEqual([]);
		expect(journaledMail(session.isolated)).toEqual(["report-1"]);
	}, 180_000);
});
