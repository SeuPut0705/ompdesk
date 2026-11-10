import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { atEnd, type Frame, HOLD, mail, runCleanups, startOmp, startProvider } from "./bridge-agent-mail-stock-harness";
import { INSTALLED_OMP as omp } from "./test-bridge-probe";

afterAll(runCleanups);

/**
 * Who started the main agent's current run (resources/gui-bridge/turn-origin.ts, `agent_control.turn`), on the
 * installed omp with a scripted provider on loopback (no model spend). Main's guard reads it before an agent stops,
 * closes or deletes a session the person typed into, or one it did not open that the person looks at (the owner's
 * report, 8 Nov 2026: "PDF target smoke test 닫아" typed to the agent was refused). Main's `typed_prompt` word, sent
 * just before the message as ipc.ts does, makes the run the person's; a report mail that wakes the session, or a
 * prompt main never noted as typed (Autopilot's nudge, a relaunch's continuation), does not.
 */
const ended = (frames: readonly Frame[]) => frames.filter(frame => frame.type === "agent_end").length;

describe.skipIf(!existsSync(omp))("who started the run, on stock omp", () => {
	it("is the person only for a run their typed message started, while it runs and after", async () => {
		const provider = await startProvider();
		atEnd(() => provider.close());
		const session = await startOmp(provider);
		const person = async () =>
			((await session.bridge.request("agent_control.turn", {})) as { person: boolean }).person;
		expect(await person()).toBe(false);

		// The person's prompt: asked mid-run, as a control tool call is.
		await session.bridge.request("typed_prompt", { text: HOLD, steer: false });
		await session.send({ type: "prompt", message: HOLD });
		await provider.held;
		expect(await person()).toBe(true);
		provider.release();
		await expect.poll(() => ended(session.frames), { timeout: 30_000 }).toBe(1);
		expect(await person()).toBe(true);

		// A child's report that wakes the session starts a run nobody typed.
		await session.bridge.request("agent_control.mail", { ...mail("done", "report-1"), triggerTurn: true });
		await expect.poll(() => ended(session.frames), { timeout: 30_000 }).toBe(2);
		expect(await person()).toBe(false);

		// A prompt main did not note as typed (an Autopilot nudge, a continuation) is not the person's either.
		await session.send({ type: "prompt", message: "close that tab" });
		await expect.poll(() => ended(session.frames), { timeout: 30_000 }).toBe(3);
		expect(await person()).toBe(false);

		// The same words typed by the person are.
		await session.bridge.request("typed_prompt", { text: "close that tab", steer: false });
		await session.send({ type: "prompt", message: "close that tab" });
		await expect.poll(() => ended(session.frames), { timeout: 30_000 }).toBe(4);
		expect(await person()).toBe(true);
	}, 180_000);
});
