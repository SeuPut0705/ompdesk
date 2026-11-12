/**
 * A turn stock gave up on at a provider's limit is taken up again by main (the owner's report, 12 Nov 2026): on his
 * MacBook a session it hosted for the paired desktop ended three turns with the 429 below (the model's weekly limit,
 * 88.9 hours away, past stock's `retry.maxDelayMs`, so stock ended each turn at once) and sat for 37 minutes until
 * another session wrote to it. A real `TurnResume` over one tab, on vitest's clock.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcScheduledRetry } from "../shared/ipc-types";
import type { RpcCommand, RpcResponse } from "../shared/rpc-types";
import type { SidecarLike } from "./sidecar-types";
import { type ResumeFact, type ResumeMarker, SCHEDULED_RETRY_DELAYS_MS, TurnResume } from "./turn-resume";

/** The failed reply's `errorMessage` in the session's record, word for word but for the request id. */
const WEEKLY_LIMIT =
	'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."},"request_id":"req_011CZ"} retry-after-ms=319918000';
const WEEKLY_LIMIT_MS = 319_918_000;

const TAB = "t1";

type Answers = Partial<Record<string, (command: RpcCommand) => RpcResponse>>;

function ok(command: string, data: unknown): RpcResponse {
	return { type: "response", command, success: true, data };
}

/** One tab around a launched `TurnResume`; the tab's omp answers `answers`, else stock's retry setting on and a retry that takes. */
function world(patch: Partial<ResumeFact> = {}, answers: Answers = {}) {
	const state = {
		fact: {
			tabId: TAB,
			winId: 1,
			cwd: "/work",
			kind: "agent",
			sessionFile: "/s/a.jsonl",
			running: false,
			stopped: false,
			awaitingUi: false,
			awaitingConnection: false,
			...patch,
		} as ResumeFact,
		markers: [] as ResumeMarker[],
	};
	const commands: RpcCommand[] = [];
	/** Every `setScheduledRetry` the resume made, in order (`undefined`: cleared). */
	const shown: Array<IpcScheduledRetry | undefined> = [];
	const sidecar = Object.assign(new EventEmitter(), {
		status: "ready",
		statusPayload: { status: "ready" },
		rpcClient: {
			command: async (command: RpcCommand): Promise<RpcResponse> => {
				commands.push(command);
				const scripted = answers[command.type];
				if (scripted) return scripted(command);
				if (command.type === "get_settings") return ok("get_settings", { values: { "retry.enabled": true } });
				if (command.type === "retry") return ok("retry", { retried: true });
				return ok(command.type, {});
			},
		},
	}) as unknown as SidecarLike;
	const resume = new TurnResume({
		store: {
			read: () => state.markers,
			write: markers => {
				state.markers = [...markers];
			},
		},
		pool: {
			resumeFacts: () => [{ ...state.fact }],
			setAwaitingConnection: (_tab, awaiting) => {
				state.fact.awaitingConnection = awaiting;
			},
			setResuming: () => undefined,
			setScheduledRetry: (_tab, retry) => {
				shown.push(retry);
			},
			startTab: () => sidecar,
			tabForSession: path => (path === state.fact.sessionFile ? TAB : null),
			movesSettled: async () => undefined,
			noteStopped: () => {
				state.fact.stopped = true;
			},
		},
		network: { online: true, shouldWait: () => false, verify: async () => true },
		enabled: () => true,
		frozen: () => false,
		scheduledRetry: {
			delays: SCHEDULED_RETRY_DELAYS_MS,
			schedule: (run, ms) => {
				const timer = setTimeout(run, ms);
				return () => clearTimeout(timer);
			},
		},
		now: Date.now,
		openTab: () => null,
	});
	resume.launch();
	const set = (next: Partial<ResumeFact>) => {
		state.fact = { ...state.fact, ...next };
		resume.sync();
	};
	return {
		resume,
		state,
		commands,
		shown,
		set,
		sent: (type: string) => commands.filter(command => command.type === type).length,
		/** A turn of the tab runs and ends in `errorMessage`, stock's own retries spent. */
		fail: async (errorMessage: string) => {
			const { lastRun: _ended, ...rest } = state.fact;
			state.fact = { ...rest, running: true };
			resume.sync();
			set({ running: false, lastRun: { stopReason: "error", errorMessage } });
			await vi.advanceTimersByTimeAsync(0);
		},
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	// 11:08:02 KST, the first of the three failed turns.
	vi.setSystemTime(new Date("2026-11-12T02:08:02Z"));
});

afterEach(() => {
	vi.useRealTimers();
});

describe("a turn stock gave up on at a provider limit", () => {
	it.each<[string, Partial<ResumeFact>]>([
		["this computer's own tab", {}],
		["a tab this computer hosts for a paired device", { peer: "desktop" }],
	])("is tried again by itself when the limit is expected gone, on %s", async (_name, patch) => {
		const w = world(patch);
		const failedAt = Date.now();
		await w.fail(WEEKLY_LIMIT);
		// Shown as a wait with its time, the moment the turn ended: no click booked it.
		expect(w.shown.at(-1)).toMatchObject({ at: failedAt + WEEKLY_LIMIT_MS });
		expect(w.sent("retry")).toBe(0);

		await vi.advanceTimersByTimeAsync(WEEKLY_LIMIT_MS);
		expect(w.sent("retry")).toBe(1);
		expect(w.shown.at(-1)).toBeUndefined();
	});
});
