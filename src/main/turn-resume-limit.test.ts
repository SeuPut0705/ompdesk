/**
 * A turn stock gave up on at a provider's limit is taken up again by main (the owner's report, 12 Nov 2026): on his
 * MacBook a session it hosted for the paired desktop ended three turns with the 429 below (the model's weekly limit,
 * 88.9 hours away, past stock's `retry.maxDelayMs`, so stock ended each turn at once) and sat for 37 minutes until
 * another session wrote to it. A real `TurnResume` over one tab, on vitest's clock.
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcScheduledRetry } from "../shared/ipc-types";
import { LIMIT_LOOK_MS, QUOTA_FALLBACK_MS } from "../shared/quota-reset";
import type { RpcCommand, RpcResponse, UsageReport } from "../shared/rpc-types";
import type { SidecarLike } from "./sidecar-types";
import {
	type ResumeFact,
	type ResumeLogDetails,
	type ResumeMarker,
	SCHEDULED_RETRY_DELAYS_MS,
	TurnResume,
} from "./turn-resume";

/** The failed reply's `errorMessage` in the session's record, word for word but for the request id. */
const WEEKLY_LIMIT =
	'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."},"request_id":"req_011CZ"} retry-after-ms=319918000';
const WEEKLY_LIMIT_MS = 319_918_000;
/** A limit whose error names no wait: the provider's usage report, else the fallback, says when. */
const NO_HINT = "429 usage limit reached for this account";
const HOUR = 3_600_000;

const TAB = "t1";

function ok(command: string, data: unknown): RpcResponse {
	return { type: "response", command, success: true, data };
}

function report(resetAt?: number): UsageReport {
	return { provider: "anthropic", fetchedAt: 0, limits: [], ...(resetAt === undefined ? {} : { resetAt }) };
}

interface WorldOptions {
	/** The reports the tab's omp answers `get_usage` with (stock's cached ones); default the one account, limited for a week. */
	usage?: () => UsageReport[];
	/** Stock's `retry.enabled`. */
	retryOn?: boolean;
	/** The tab is a live Autopilot run's: its own quota wait holds the limit. */
	autopilot?: boolean;
	/** What the last process left in the marker file. */
	marker?: ResumeMarker;
}

type World = ReturnType<typeof world>;

/** One tab around a launched `TurnResume`, with the tab's omp as stock answers it. */
function world(patch: Partial<ResumeFact> = {}, options: WorldOptions = {}) {
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
		gone: false,
		frozen: false,
		markers: options.marker ? [options.marker] : ([] as ResumeMarker[]),
		model: { provider: "anthropic", id: "claude-fable-5" },
		chains: { "anthropic/*": ["openai-codex/gpt-6.1-sol"] } as Record<string, string[]>,
		usage: options.usage ?? (() => [report(Date.now() + 7 * 24 * HOUR)]),
		/** Whether stock's `retry` finds a turn that then runs. */
		retryTakes: true,
	};
	const commands: RpcCommand[] = [];
	/** Every `setScheduledRetry` the resume made, in order (`undefined`: cleared). */
	const shown: Array<IpcScheduledRetry | undefined> = [];
	const logs: Array<[string, ResumeLogDetails]> = [];
	const sidecar = Object.assign(new EventEmitter(), {
		status: "ready",
		statusPayload: { status: "ready" },
		rpcClient: {
			command: async (command: RpcCommand): Promise<RpcResponse> => {
				commands.push(command);
				switch (command.type) {
					case "get_settings":
						return ok("get_settings", {
							values: { "retry.enabled": options.retryOn ?? true, "retry.fallbackChains": state.chains },
						});
					case "get_state":
						return ok("get_state", { model: state.model });
					case "get_usage":
						return ok("get_usage", { reports: state.usage() });
					case "retry":
						return ok("retry", { retried: state.retryTakes });
					default:
						return ok(command.type, {});
				}
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
			resumeFacts: () => (state.gone ? [] : [{ ...state.fact }]),
			setAwaitingConnection: (_tab, awaiting) => {
				state.fact.awaitingConnection = awaiting;
			},
			setResuming: () => undefined,
			setScheduledRetry: (_tab, retry) => {
				shown.push(retry);
			},
			startTab: () => (state.gone ? null : sidecar),
			tabForSession: path => (path === state.fact.sessionFile ? TAB : null),
			movesSettled: async () => undefined,
			noteStopped: () => {
				state.fact.stopped = true;
			},
		},
		network: { online: true, shouldWait: () => false, verify: async () => true },
		enabled: () => true,
		frozen: () => state.frozen,
		scheduledRetry: {
			delays: SCHEDULED_RETRY_DELAYS_MS,
			schedule: (run, ms) => {
				const timer = setTimeout(run, ms);
				return () => clearTimeout(timer);
			},
		},
		limitHeldElsewhere: () => options.autopilot === true,
		now: Date.now,
		openTab: () => null,
		log: (message, details) => {
			logs.push([message, details]);
		},
	});
	resume.launch();
	const set = (next: Partial<ResumeFact>) => {
		state.fact = { ...state.fact, ...next };
		resume.sync();
	};
	/** A run of the tab starts: the person's prompt, or the retry stock took. */
	const start = (next: Partial<ResumeFact> = {}) => {
		const { lastRun: _ended, ...rest } = state.fact;
		state.fact = { ...rest, running: true, ...next };
		resume.sync();
	};
	/** The run ends in `errorMessage`, stock's own retries spent. */
	const end = async (errorMessage: string) => {
		set({ running: false, lastRun: { stopReason: "error", errorMessage } });
		await vi.advanceTimersByTimeAsync(0);
	};
	return {
		resume,
		state,
		commands,
		shown,
		logs,
		set,
		start,
		end,
		sent: (type: string) => commands.filter(command => command.type === type).length,
		/** A turn of the tab runs and ends in `errorMessage`. */
		fail: async (errorMessage: string) => {
			start();
			await end(errorMessage);
		},
		markers: () => state.markers.map(marker => marker.reason),
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

	it("shows it as a limit wait, not as a backoff attempt", async () => {
		const w = world();
		await w.fail(WEEKLY_LIMIT);
		expect(w.shown).toEqual([{ at: Date.now() + WEEKLY_LIMIT_MS, attempt: 1, limit: true }]);
	});

	it("waits for the provider's first reset when the error names no wait, and 15 minutes when no report names one", async () => {
		const reset = Date.now() + 5 * HOUR;
		const reported = world({}, { usage: () => [report(reset + HOUR), report(reset)] });
		await reported.fail(NO_HINT);
		expect(reported.shown.at(-1)).toMatchObject({ at: reset, limit: true });

		const unknown = world({}, { usage: () => [] });
		const failedAt = Date.now();
		await unknown.fail(NO_HINT);
		expect(unknown.shown.at(-1)).toMatchObject({ at: failedAt + QUOTA_FALLBACK_MS, limit: true });
	});

	it("writes one runtime-log line for the wait and one for the try, so a turn that sat can be explained afterwards", async () => {
		const w = world({ peer: "desktop" });
		await w.fail(WEEKLY_LIMIT);
		await vi.advanceTimersByTimeAsync(WEEKLY_LIMIT_MS);
		expect(w.logs.filter(([message]) => message === "limit")).toEqual([
			[
				"limit",
				{ tab: TAB, session: "/s/a.jsonl", wait: "armed", by: "retry-after", ms: WEEKLY_LIMIT_MS, peer: "desktop" },
			],
			["limit", { tab: TAB, session: "/s/a.jsonl", wait: "due" }],
		]);
	});
});

describe("a limit that lifts before its time", () => {
	it("looks every ten minutes with reads of the tab's own omp only, and sends no request while the limit holds", async () => {
		const w = world();
		await w.fail(WEEKLY_LIMIT);
		w.commands.length = 0;
		await vi.advanceTimersByTimeAsync(HOUR);
		// Six looks in the hour: stock's settings, the session's model, stock's cached usage reports. Never a turn.
		expect(w.sent("get_usage")).toBe(6);
		expect(new Set(w.commands.map(command => command.type))).toEqual(
			new Set(["get_settings", "get_state", "get_usage"]),
		);
		expect(w.commands.find(command => command.type === "get_usage")).not.toHaveProperty("refresh", true);
		expect(w.shown).toHaveLength(1);
	});

	it("goes on at the next look once a reset pass or a freed account lets the provider run again", async () => {
		const w = world();
		await w.fail(WEEKLY_LIMIT);
		await vi.advanceTimersByTimeAsync(25 * 60_000);
		expect(w.sent("retry")).toBe(0);
		// 11:33: a reset pass refills the account. The 11:38 look reads it.
		w.state.usage = () => [report()];
		await vi.advanceTimersByTimeAsync(LIMIT_LOOK_MS);
		expect(w.sent("retry")).toBe(1);
		expect(w.shown.at(-1)).toBeUndefined();
		expect(w.logs.at(-2)).toEqual(["limit", { tab: TAB, session: "/s/a.jsonl", wait: "lifted", by: "usage" }]);

		// A second account that is not limited does the same.
		const two = world({}, { usage: () => [report(Date.now() + 7 * 24 * HOUR), report(Date.now() + 2 * HOUR)] });
		await two.fail(WEEKLY_LIMIT);
		two.state.usage = () => [report(Date.now() + 7 * 24 * HOUR), report()];
		await vi.advanceTimersByTimeAsync(LIMIT_LOOK_MS);
		expect(two.sent("retry")).toBe(1);
	});

	it.each<[string, (w: World) => void]>([
		[
			"a fallback chain that now holds a model the conversation fits",
			w => {
				w.state.chains = { "anthropic/*": ["anthropic/claude-opus-5-5", "openai-codex/gpt-6.1-sol"] };
			},
		],
		[
			"another model on the session",
			w => {
				w.state.model = { provider: "anthropic", id: "claude-opus-5-5" };
			},
		],
	])("goes on at the next look after %s", async (_name, change) => {
		const w = world();
		await w.fail(WEEKLY_LIMIT);
		await vi.advanceTimersByTimeAsync(LIMIT_LOOK_MS);
		expect(w.sent("retry")).toBe(0);
		change(w);
		await vi.advanceTimersByTimeAsync(LIMIT_LOOK_MS);
		expect(w.sent("retry")).toBe(1);
		expect(w.logs.at(-2)).toEqual(["limit", { tab: TAB, session: "/s/a.jsonl", wait: "lifted", by: "setup" }]);
	});

	it("keeps waiting when a look cannot read the tab's omp", async () => {
		const w = world();
		await w.fail(WEEKLY_LIMIT);
		w.state.usage = () => {
			throw new Error("GUI bridge closed");
		};
		await vi.advanceTimersByTimeAsync(3 * LIMIT_LOOK_MS);
		expect(w.sent("retry")).toBe(0);
		expect(w.shown).toHaveLength(1);
	});

	it("waits again when the try is refused again, never more often than every ten minutes", async () => {
		// No usage report for the provider: nothing says the limit holds, so each look is a try.
		const w = world({}, { usage: () => [] });
		await w.fail(WEEKLY_LIMIT);
		for (const attempt of [1, 2, 3]) {
			await vi.advanceTimersByTimeAsync(LIMIT_LOOK_MS - 1);
			expect(w.sent("retry")).toBe(attempt - 1);
			await vi.advanceTimersByTimeAsync(1);
			expect(w.sent("retry")).toBe(attempt);
			// Stock took the retry and the provider refused it again.
			w.start();
			await w.end(WEEKLY_LIMIT);
			expect(w.shown.at(-1)).toEqual({ at: Date.now() + WEEKLY_LIMIT_MS, attempt: attempt + 1, limit: true });
		}
	});
});

describe("what waiting cannot fix is never waited for", () => {
	it.each([
		// An account out of money: stock's billing cap wordings (pi-ai `isBillingCapUsageLimit`).
		"402 the organization is out of credit, add more to continue (type=insufficient_quota)",
		"429 You exceeded your current quota, please check your plan and billing details",
		"429 insufficient_quota",
		"429 This request would exceed your available credits given your current in-flight requests",
		"429 Your prepaid balance is used up: Add funds or enable auto top-up (usage_pricing_required)",
		"429 You have reached your monthly spend limit",
		"429 Usage credits are required for this model (credits_required)",
		"429 rate limit: Insufficient Balance",
		// Sign-in, a rejected request, a context that does not fit.
		"401 invalid x-api-key",
		"403 Forbidden: rate limit policy",
		"400 invalid_request_error: rate_limit tier unknown",
		"429 prompt is too long: 215000 tokens > 200000 maximum",
		"Something odd happened",
	])("%s", async message => {
		const w = world();
		await w.fail(message);
		await vi.advanceTimersByTimeAsync(24 * HOUR);
		expect(w.shown).toEqual([]);
		expect(w.commands).toEqual([]);
		expect(w.markers()).toEqual([]);
	});

	it("leaves a live Autopilot run's limit to the run's own quota wait", async () => {
		const w = world({}, { autopilot: true });
		await w.fail(WEEKLY_LIMIT);
		await vi.advanceTimersByTimeAsync(24 * HOUR);
		expect(w.shown).toEqual([]);
		expect(w.commands).toEqual([]);
	});

	it("does not wait while stock's own retry saga still has the turn", async () => {
		const w = world();
		// The failed attempt is live and stock waits for its next one: the run has not ended.
		w.start({ retry: { errorMessage: WEEKLY_LIMIT } });
		await vi.advanceTimersByTimeAsync(24 * HOUR);
		expect(w.shown).toEqual([]);
		expect(w.sent("retry")).toBe(0);
	});

	it("follows stock's own retry switch", async () => {
		const w = world({}, { retryOn: false });
		await w.fail(WEEKLY_LIMIT);
		await vi.advanceTimersByTimeAsync(24 * HOUR);
		expect(w.shown).toEqual([]);
		expect(w.sent("retry")).toBe(0);
	});
});

describe("a limit wait is called off as a scheduled retry is", () => {
	it.each<[string, (w: World) => void | Promise<void>]>([
		["Cancel on the card", w => w.resume.cancelWait(TAB)],
		["Stop", w => w.set({ stopped: true })],
		["the person's own prompt or run", w => w.start({ prompted: 1 })],
		["a move to another session or branch", w => w.set({ touched: 1 })],
		["another session file on the tab", w => w.set({ sessionFile: "/s/b.jsonl" })],
		[
			"the tab closing",
			w => {
				w.state.gone = true;
				w.resume.sync();
			},
		],
	])("%s", async (_name, act) => {
		const w = world();
		await w.fail(WEEKLY_LIMIT);
		expect(w.markers()).toEqual(["limit"]);
		await act(w);
		await vi.advanceTimersByTimeAsync(0);
		expect(w.shown.at(-1)).toBeUndefined();
		// The limit lifts and its time comes: nothing is sent for the turn that was let go.
		w.state.usage = () => [report()];
		await vi.advanceTimersByTimeAsync(WEEKLY_LIMIT_MS);
		expect(w.sent("retry")).toBe(0);
		expect(w.markers().filter(reason => reason === "limit")).toEqual([]);
	});

	it("sends nothing once a quit is underway, and leaves the marker for the relaunch", async () => {
		const w = world();
		await w.fail(WEEKLY_LIMIT);
		w.state.frozen = true;
		w.state.usage = () => [report()];
		await vi.advanceTimersByTimeAsync(WEEKLY_LIMIT_MS);
		expect(w.sent("retry")).toBe(0);
		expect(w.markers()).toEqual(["limit"]);
	});
});

describe("a limit wait across a relaunch", () => {
	it("is in the marker file while it holds, for a hosted tab with its device, and leaves it once the turn runs again", async () => {
		const w = world({ peer: "desktop" });
		await w.fail(WEEKLY_LIMIT);
		expect(w.state.markers).toEqual([
			expect.objectContaining({ tab: TAB, sessionPath: "/s/a.jsonl", reason: "limit", peer: "desktop" }),
		]);
		await vi.advanceTimersByTimeAsync(WEEKLY_LIMIT_MS);
		w.start();
		expect(w.markers()).toEqual(["running"]);
	});

	it("is taken up by the relaunch with stock retry, and waits again when the provider still refuses", async () => {
		const w = world(
			{},
			{
				marker: {
					window: 1,
					tab: "old",
					sessionPath: "/s/a.jsonl",
					cwd: "/work",
					kind: "agent",
					startedAt: 1,
					reason: "limit",
				},
			},
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(w.commands.map(command => command.type)).toEqual(["retry"]);
		w.start();
		await w.end(WEEKLY_LIMIT);
		expect(w.shown.at(-1)).toMatchObject({ at: Date.now() + WEEKLY_LIMIT_MS, limit: true });
		expect(w.markers()).toEqual(["limit"]);
	});
});
