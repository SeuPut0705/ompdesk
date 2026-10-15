/**
 * gui-bridge idle compaction (resources/gui-bridge/idle-compaction-core.ts):
 * the TUI's idle timer rules (stock `modes/controllers/event-controller.ts`
 * `#scheduleIdleCompaction`) on a fake session with fake timers. Stock ships
 * no tests for that timer, so the cases follow its code branch by branch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	IdleCompactionTimer,
	type IdleSession,
	type IdleSettings,
} from "../../resources/gui-bridge/idle-compaction-core";

interface FakeSession extends IdleSession {
	isStreaming: boolean;
	isCompacting: boolean;
	tokens: number;
	runs: number;
}

function fakeSession(tokens = 250_000): FakeSession {
	const session: FakeSession = {
		isStreaming: false,
		isCompacting: false,
		tokens,
		runs: 0,
		getContextUsage: () => ({ tokens: session.tokens }),
		runIdleCompaction: async () => {
			session.runs += 1;
		},
	};
	return session;
}

let settings: IdleSettings;
const read = () => settings;

beforeEach(() => {
	vi.useFakeTimers();
	settings = { idleEnabled: true, idleThresholdTokens: 200_000, idleTimeoutSeconds: 300 };
});

afterEach(() => {
	vi.useRealTimers();
});

describe("idle compaction timer", () => {
	it("compacts once the delay passes after a terminal agent_end", async () => {
		const session = fakeSession();
		const timer = new IdleCompactionTimer(read);
		await timer.onEvent({ type: "agent_end" }, session);
		expect(timer.armed).toBe(true);
		vi.advanceTimersByTime(299_000);
		expect(session.runs).toBe(0);
		vi.advanceTimersByTime(1_000);
		expect(session.runs).toBe(1);
		expect(timer.armed).toBe(false);
	});

	it("stays unarmed when off, under the threshold, at a threshold ≤ 0, compacting, or after an async pause", async () => {
		const timer = new IdleCompactionTimer(read);
		await timer.onEvent({ type: "agent_end", isTerminal: false }, fakeSession());
		expect(timer.armed).toBe(false);
		await timer.onEvent({ type: "agent_end" }, fakeSession(199_999));
		expect(timer.armed).toBe(false);
		const compacting = fakeSession();
		compacting.isCompacting = true;
		await timer.onEvent({ type: "agent_end" }, compacting);
		expect(timer.armed).toBe(false);
		settings = { ...settings, idleThresholdTokens: 0 };
		await timer.onEvent({ type: "agent_end" }, fakeSession());
		expect(timer.armed).toBe(false);
		settings = { ...settings, idleThresholdTokens: 200_000, idleEnabled: false };
		await timer.onEvent({ type: "agent_end" }, fakeSession());
		expect(timer.armed).toBe(false);
	});

	it("clamps the delay to 60–3600 seconds", async () => {
		const session = fakeSession();
		const timer = new IdleCompactionTimer(read);
		settings = { ...settings, idleTimeoutSeconds: 5 };
		await timer.onEvent({ type: "agent_end" }, session);
		vi.advanceTimersByTime(59_000);
		expect(session.runs).toBe(0);
		vi.advanceTimersByTime(1_000);
		expect(session.runs).toBe(1);
		settings = { ...settings, idleTimeoutSeconds: 99_999 };
		await timer.onEvent({ type: "agent_end" }, session);
		vi.advanceTimersByTime(3_599_000);
		expect(session.runs).toBe(1);
		vi.advanceTimersByTime(1_000);
		expect(session.runs).toBe(2);
	});

	it("cancels on agent_start and auto-compaction, and re-checks state when it fires", async () => {
		const session = fakeSession();
		const timer = new IdleCompactionTimer(read);
		for (const type of ["agent_start", "auto_compaction_start", "auto_compaction_end"]) {
			await timer.onEvent({ type: "agent_end" }, session);
			await timer.onEvent({ type }, session);
			expect(timer.armed).toBe(false);
		}
		await timer.onEvent({ type: "agent_end" }, session);
		session.tokens = 10_000;
		vi.advanceTimersByTime(300_000);
		expect(session.runs).toBe(0);
		session.tokens = 250_000;
		await timer.onEvent({ type: "agent_end" }, session);
		session.isStreaming = true;
		vi.advanceTimersByTime(300_000);
		expect(session.runs).toBe(0);
	});

	it("skips a non-empty draft, and a draft cleared after a turn arms it again", async () => {
		const session = fakeSession();
		const timer = new IdleCompactionTimer(read);
		await timer.setDraftEmpty(false, session);
		await timer.onEvent({ type: "agent_end" }, session);
		expect(timer.armed).toBe(false);
		await timer.setDraftEmpty(true, session);
		expect(timer.armed).toBe(true);
		// Typing while armed: nothing fires.
		await timer.setDraftEmpty(false, session);
		vi.advanceTimersByTime(300_000);
		expect(session.runs).toBe(0);
		// A turn started since: clearing the draft no longer arms (the TUI waits for agent_end).
		await timer.onEvent({ type: "agent_start" }, session);
		await timer.setDraftEmpty(true, session);
		expect(timer.armed).toBe(false);
	});

	it("re-arms on a live write of an idle setting while idle and cancels while streaming", async () => {
		const session = fakeSession();
		const timer = new IdleCompactionTimer(read);
		settings = { ...settings, idleEnabled: false };
		await timer.onEvent({ type: "agent_end" }, session);
		expect(timer.armed).toBe(false);
		settings = { ...settings, idleEnabled: true };
		expect(timer.settingChanged("compaction.enabled", session)).toBeUndefined();
		await timer.settingChanged("compaction.idleEnabled", session);
		expect(timer.armed).toBe(true);
		session.isStreaming = true;
		await timer.settingChanged("compaction.idleTimeoutSeconds", session);
		expect(timer.armed).toBe(false);
	});

	it("keeps one timer when two arms overlap the settings read, so a cancel leaves nothing to fire", async () => {
		const session = fakeSession();
		const reads: Array<() => void> = [];
		const timer = new IdleCompactionTimer(
			() =>
				new Promise<IdleSettings>(resolve => {
					reads.push(() => resolve(settings));
				}),
		);
		// agent_end arms, and a live write of an idle setting re-arms while that read is pending.
		const first = timer.onEvent({ type: "agent_end" }, session);
		const second = timer.settingChanged("compaction.idleTimeoutSeconds", session);
		for (const resolve of reads) resolve();
		await Promise.all([first, second]);
		expect(timer.armed).toBe(true);
		// A cancel (here: an auto-compaction) must leave no earlier timer running.
		await timer.onEvent({ type: "auto_compaction_end" }, session);
		expect(timer.armed).toBe(false);
		vi.advanceTimersByTime(300_000);
		expect(session.runs).toBe(0);
	});
});
