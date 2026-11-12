/**
 * Test-only: fake main's timers and the core's together. What moved into the core (R5: computer sharing's reconnect
 * backoff, tailnet poll and scan, the host's slow-rebind line, keep-awake's quiet period) waits on the core's clock
 * (`crates/core/src/clock.rs`), which `vi.useFakeTimers` cannot reach: these turn it manual at main's fake time and
 * move both by the same step, the core first, so a test reads as it did when the code ran in main.
 */
import { vi } from "vitest";
import { core } from "./process";

type Faked = NonNullable<Parameters<typeof vi.useFakeTimers>[0]>["toFake"];

/** `vi.useFakeTimers(toFake)` with the core's clock turned manual at the same instant. */
export async function fakeCoreTimers(toFake?: Faked): Promise<void> {
	vi.useFakeTimers(toFake ? { toFake } : undefined);
	await core().call("clock.manual", { nowMs: Date.now() });
}

/** `vi.advanceTimersByTimeAsync(ms)` for main and the core. */
export async function advanceCoreTimers(ms: number): Promise<void> {
	await core().call("clock.advance", { ms });
	await vi.advanceTimersByTimeAsync(ms);
}

/** `vi.advanceTimersByTime(ms)` with the core's clock moved first. */
export async function advanceCoreTimersSync(ms: number): Promise<void> {
	await core().call("clock.advance", { ms });
	vi.advanceTimersByTime(ms);
}

/** Real timers on both sides again; every manual sleep in the core ends. */
export async function realCoreTimers(): Promise<void> {
	vi.useRealTimers();
	await core().call("clock.real", {});
}
