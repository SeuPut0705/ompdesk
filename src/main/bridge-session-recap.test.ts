/**
 * gui-bridge idle recap (resources/gui-bridge/session-recap-core.ts): the TUI's recap timer rules (stock
 * `modes/controllers/event-controller.ts` `#scheduleIdleRecap` / `#runIdleRecap` / `#idleConditionsHold`)
 * on a fake session with fake timers. Stock ships no tests for that timer, so the cases follow its code
 * branch by branch. The recap's own prompt and delivery are pinned against stock in
 * bridge-session-recap-stock.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type Recap,
	type RecapHooks,
	type RecapSession,
	type RecapSettings,
	RecapTimer,
} from "../../resources/gui-bridge/session-recap-core";

interface FakeSession extends RecapSession {
	isStreaming: boolean;
	isCompacting: boolean;
}

const fakeSession = (): FakeSession => ({ isStreaming: false, isCompacting: false });

let settings: RecapSettings;
let delivered: Recap[];
let generated: number;
let signals: AbortSignal[];
/** Resolves the reply of the generate call in flight; unset: replies at once. */
let hold: ((recap: Recap | undefined) => void) | undefined;
let holdNext = false;

const hooks: RecapHooks<FakeSession> = {
	read: () => settings,
	generate: (_session, signal) => {
		generated += 1;
		signals.push(signal);
		if (!holdNext) return Promise.resolve({ reply: "Reply text", preview: "Reply text" });
		return new Promise<Recap | undefined>(resolve => {
			hold = resolve;
		});
	},
	deliver: async (_session, recap) => {
		delivered.push(recap);
	},
};

beforeEach(() => {
	vi.useFakeTimers();
	settings = { enabled: true, idleSeconds: 240 };
	delivered = [];
	generated = 0;
	signals = [];
	hold = undefined;
	holdNext = false;
});

afterEach(() => {
	vi.useRealTimers();
});

/** Let the recap turn's promise chain settle (fake timers do not advance microtasks). */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe("idle recap timer", () => {
	it("recaps once the delay passes after a terminal agent_end, one recap per idle window", async () => {
		const session = fakeSession();
		const timer = new RecapTimer(hooks);
		await timer.onEvent({ type: "agent_end" }, session);
		expect(timer.armed).toBe(true);
		await vi.advanceTimersByTimeAsync(239_000);
		expect(generated).toBe(0);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(generated).toBe(1);
		expect(delivered).toEqual([{ reply: "Reply text", preview: "Reply text" }]);
		expect(timer.armed).toBe(false);
		// No second recap without another turn.
		await vi.advanceTimersByTimeAsync(3_600_000);
		expect(generated).toBe(1);
	});

	it("stays unarmed when off, compacting, or after an async pause", async () => {
		const timer = new RecapTimer(hooks);
		await timer.onEvent({ type: "agent_end", isTerminal: false }, fakeSession());
		expect(timer.armed).toBe(false);
		const compacting = fakeSession();
		compacting.isCompacting = true;
		await timer.onEvent({ type: "agent_end" }, compacting);
		expect(timer.armed).toBe(false);
		settings = { enabled: false, idleSeconds: 240 };
		await timer.onEvent({ type: "agent_end" }, fakeSession());
		expect(timer.armed).toBe(false);
	});

	it("clamps the delay to 1–3600 seconds", async () => {
		const session = fakeSession();
		const timer = new RecapTimer(hooks);
		settings = { enabled: true, idleSeconds: 0 };
		await timer.onEvent({ type: "agent_end" }, session);
		await vi.advanceTimersByTimeAsync(999);
		expect(generated).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(generated).toBe(1);
		settings = { enabled: true, idleSeconds: 99_999 };
		await timer.onEvent({ type: "agent_end" }, session);
		await vi.advanceTimersByTimeAsync(3_599_000);
		expect(generated).toBe(1);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(generated).toBe(2);
	});

	it("cancels on agent_start and auto-compaction, and re-checks state when it fires", async () => {
		const session = fakeSession();
		const timer = new RecapTimer(hooks);
		for (const type of ["agent_start", "auto_compaction_start", "auto_compaction_end"]) {
			await timer.onEvent({ type: "agent_end" }, session);
			await timer.onEvent({ type }, session);
			expect(timer.armed).toBe(false);
		}
		await timer.onEvent({ type: "agent_end" }, session);
		session.isStreaming = true;
		await vi.advanceTimersByTimeAsync(240_000);
		expect(generated).toBe(0);
	});

	it("skips a draft, and a draft cleared inside the idle window arms it again", async () => {
		const session = fakeSession();
		const timer = new RecapTimer(hooks);
		await timer.setDraftEmpty(false, session);
		await timer.onEvent({ type: "agent_end" }, session);
		expect(timer.armed).toBe(false);
		await timer.setDraftEmpty(true, session);
		expect(timer.armed).toBe(true);
		// Typing while armed: nothing fires.
		await timer.setDraftEmpty(false, session);
		await vi.advanceTimersByTimeAsync(240_000);
		expect(generated).toBe(0);
		// A turn started since: clearing the draft no longer arms (the next agent_end opens a window).
		await timer.onEvent({ type: "agent_start" }, session);
		await timer.setDraftEmpty(true, session);
		expect(timer.armed).toBe(false);
	});

	it("does not arm a draft cleared after the window already produced its recap", async () => {
		const session = fakeSession();
		const timer = new RecapTimer(hooks);
		await timer.onEvent({ type: "agent_end" }, session);
		await vi.advanceTimersByTimeAsync(240_000);
		expect(delivered).toHaveLength(1);
		await timer.setDraftEmpty(false, session);
		await timer.setDraftEmpty(true, session);
		expect(timer.armed).toBe(false);
	});

	it("aborts a recap in flight and drops its reply when work or a draft supersedes it", async () => {
		const session = fakeSession();
		const timer = new RecapTimer(hooks);
		holdNext = true;
		await timer.onEvent({ type: "agent_end" }, session);
		await vi.advanceTimersByTimeAsync(240_000);
		expect(timer.running).toBe(true);
		await timer.setDraftEmpty(false, session);
		expect(signals[0].aborted).toBe(true);
		hold?.({ reply: "late", preview: "late" });
		await settle();
		expect(delivered).toEqual([]);
		expect(timer.running).toBe(false);
	});

	it("re-checks idleness after the reply lands, so a stale recap is never delivered", async () => {
		const session = fakeSession();
		const timer = new RecapTimer(hooks);
		holdNext = true;
		await timer.onEvent({ type: "agent_end" }, session);
		await vi.advanceTimersByTimeAsync(240_000);
		session.isStreaming = true;
		hold?.({ reply: "late", preview: "late" });
		await settle();
		expect(delivered).toEqual([]);
	});

	it("delivers nothing when there is nothing to recap, and survives a failing turn", async () => {
		const session = fakeSession();
		const timer = new RecapTimer(hooks);
		holdNext = true;
		await timer.onEvent({ type: "agent_end" }, session);
		await vi.advanceTimersByTimeAsync(240_000);
		hold?.(undefined);
		await settle();
		expect(delivered).toEqual([]);

		const failing = new RecapTimer<FakeSession>({
			...hooks,
			generate: () => Promise.reject(new Error("model unavailable")),
		});
		await failing.onEvent({ type: "agent_end" }, session);
		await vi.advanceTimersByTimeAsync(240_000);
		expect(failing.running).toBe(false);
	});

	it("rearms inside a pending window when recap.* changes, and ignores other settings", async () => {
		const session = fakeSession();
		const timer = new RecapTimer(hooks);
		settings = { enabled: false, idleSeconds: 240 };
		await timer.onEvent({ type: "agent_end" }, session);
		expect(timer.armed).toBe(false);
		settings = { enabled: true, idleSeconds: 60 };
		expect(timer.settingChanged("compaction.enabled", session)).toBeUndefined();
		await timer.settingChanged("recap.enabled", session);
		expect(timer.armed).toBe(true);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(generated).toBe(1);
		// Window used up: a later change has nothing to rearm; neither does one while streaming.
		expect(timer.settingChanged("recap.idleSeconds", session)).toBeUndefined();
		await timer.onEvent({ type: "agent_end" }, session);
		session.isStreaming = true;
		expect(timer.settingChanged("recap.idleSeconds", session)).toBeUndefined();
	});

	it("switching sessions forgets the old idle window", async () => {
		const session = fakeSession();
		const timer = new RecapTimer(hooks);
		await timer.onEvent({ type: "agent_end" }, session);
		timer.reset();
		expect(timer.armed).toBe(false);
		await timer.setDraftEmpty(false, session);
		await timer.setDraftEmpty(true, session);
		expect(timer.armed).toBe(false);
	});

	it("keeps one timer when two arms overlap the settings read", async () => {
		const session = fakeSession();
		const reads: Array<() => void> = [];
		const timer = new RecapTimer<FakeSession>({
			...hooks,
			read: () =>
				new Promise<RecapSettings>(resolve => {
					reads.push(() => resolve(settings));
				}),
		});
		const first = timer.onEvent({ type: "agent_end" }, session);
		const second = timer.settingChanged("recap.idleSeconds", session);
		for (const resolve of reads) resolve();
		await Promise.all([first, second]);
		expect(timer.armed).toBe(true);
		await timer.onEvent({ type: "auto_compaction_end" }, session);
		expect(timer.armed).toBe(false);
		await vi.advanceTimersByTimeAsync(240_000);
		expect(generated).toBe(0);
	});
});
