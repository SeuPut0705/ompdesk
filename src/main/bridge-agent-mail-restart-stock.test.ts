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
 * What stock omp does with a report its bridge accepted while a turn runs, when the omp then ends, measured on the
 * installed omp with a scripted provider on loopback.
 *
 * Reported on 21 Oct 2026: a child's `done` to its parent, inside a long tool call, was never journaled after an update
 * restart (it went as a `followUp`, which stock keeps in memory until the turn that answers it). Every report a busy
 * receiver gets is now an `aside`. A quit (stdin ends, stock disposes the session) journals a queued aside; a SIGKILL
 * (a crash, a force-quit of OMPdesk) before the next step boundary loses it. So main keeps every accepted report
 * (`agent-control/mail-outbox.ts`) until the receiver's journal holds its id and sends it again, with the same id, to
 * the omp that replaces the killed one; the bridge answers whether an id is journaled or only queued.
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
	const cases: Array<[MailKind, string, string]> = [
		["done", "a model request", HOLD],
		["done", "a tool call", TOOL],
		["review", "a model request", HOLD],
		["review", "a tool call", TOOL],
		["question", "a model request", HOLD],
		["question", "a tool call", TOOL],
		["blocked", "a tool call", TOOL],
		["progress", "a tool call", TOOL],
		["note", "a model request", HOLD],
	];
	for (const [kind, where, prompt] of cases) {
		it(`is journaled: ${kind} during ${where}`, async () => {
			const { session } = await busyOmp(prompt);
			expect(await session.bridge.request("agent_control.mail", mail(kind, `m-${kind}`))).toEqual({});
			await session.stop();
			expect(journaledMail(session.isolated)).toEqual([`m-${kind}`]);
		}, 120_000);
	}

	it("a done SIGKILL cut before the step boundary reaches the replacing omp's journal once, through the outbox", async () => {
		const { provider, session } = await busyOmp(TOOL);
		const outbox = new MailOutbox(null);
		const report = mail("done", "killed-done");
		// What main does when the receiver accepts a report: keep it until the journal holds it.
		expect(await session.bridge.request("agent_control.mail", report)).toEqual({});
		outbox.keep({
			id: "killed-done",
			sessionPath: "/s/receiver.jsonl",
			content: report.content,
			details: report.details,
			delivery: deliveryFor("done"),
			at: Date.now(),
		});
		await session.kill();
		expect(journaledMail(session.isolated)).toEqual([]);

		// The relaunch: the same session file in a new omp.
		const [file] = sessionFiles(session.isolated);
		const again = await startOmp(provider, {
			isolated: session.isolated,
			root: session.root,
			session: file as string,
		});
		const asked: unknown[] = [];
		const pass = () =>
			redeliverMail(outbox, {
				tabOf: () => "tab",
				send: async (_tab, entry) => {
					const answer = await again.bridge.request<{ duplicate?: boolean; journaled?: boolean }>(
						"agent_control.mail",
						{ content: entry.content, details: entry.details, ...entry.delivery },
					);
					asked.push(answer);
					return answer;
				},
			});
		await pass();
		await expect.poll(() => journaledMail(session.isolated), { timeout: 30_000 }).toEqual(["killed-done"]);
		await pass();
		await pass();
		expect(asked).toEqual([{}, { duplicate: true, journaled: true }]);
		expect(outbox.pending()).toEqual([]);
		expect(journaledMail(session.isolated)).toEqual(["killed-done"]);
	}, 180_000);
});
