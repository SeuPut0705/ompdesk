import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import type { MailKind } from "./agent-control/mail";
import {
	atEnd,
	HOLD,
	journaledMail,
	mail,
	type Omp,
	omp,
	type Provider,
	runCleanups,
	startOmp,
	startProvider,
	TOOL,
} from "./bridge-agent-mail-stock-harness";

/**
 * What stock omp does with a report its bridge accepted while a turn runs, when the omp is closed the way a quit closes
 * it (stdin ends and stock disposes the session), measured on the installed omp with a scripted provider on loopback.
 *
 * Reported on 21 Oct 2026: a child's `done` to its parent, inside a long tool call, was never journaled after an update
 * restart. It went as a `followUp`, which stock keeps in an in-memory queue until it starts the turn that answers it,
 * so closing the omp dropped it. Every report a busy receiver gets is now an `aside` (`deliveryFor`, and the bridge for
 * a no-turn one), and stock journals a queued aside when the session is disposed: no report main accepted is lost to a
 * quit, so main keeps no copy of its own.
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
});
