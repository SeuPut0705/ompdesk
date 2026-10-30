import { EventEmitter } from "node:events";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wrapAgentMessage } from "../shared/agent-control";
import type { IpcScheduledRetry, IpcTabRunOutcome } from "../shared/ipc-types";
import type { RpcCommand, RpcResponse } from "../shared/rpc-types";
import { ConnectivityMonitor } from "./connectivity";
import { deletedSessions, initDeletedSessions } from "./deleted-sessions";
import { RpcTimeoutError } from "./rpc-client";
import type { SidecarLike } from "./sidecar-types";
import {
	deriveMarkers,
	dnsFailureHost,
	type GoalSettlement,
	InterruptedTurnStore,
	isNetworkError,
	isTransientError,
	launchAction,
	MovesInFlight,
	movesTab,
	movesTabUnknown,
	personsPrompt,
	RESUME_COMMAND_TIMEOUT_MS,
	RESUME_READY_TIMEOUT_MS,
	type ResumeFact,
	type ResumeLogDetails,
	type ResumeMarker,
	type ResumePool,
	retryDelays,
	SCHEDULED_RETRY_DELAYS_MS,
	TOUCH_COMMANDS,
	TurnResume,
	trackMove,
} from "./turn-resume";

function fact(patch: Partial<ResumeFact> = {}): ResumeFact {
	return {
		tabId: "t1",
		winId: 1,
		cwd: "/work",
		kind: "agent",
		sessionFile: "/s/a.jsonl",
		running: false,
		stopped: false,
		awaitingUi: false,
		awaitingConnection: false,
		...patch,
	};
}

function marker(patch: Partial<ResumeMarker> = {}): ResumeMarker {
	return {
		window: 1,
		tab: "old-tab",
		sessionPath: "/s/a.jsonl",
		cwd: "/work",
		kind: "agent",
		startedAt: 100,
		reason: "running",
		...patch,
	};
}

describe("deriveMarkers", () => {
	it("marks a running turn with its window, tab, session and start time", () => {
		expect(deriveMarkers([fact({ running: true })], [], 500)).toEqual([
			{
				window: 1,
				tab: "t1",
				sessionPath: "/s/a.jsonl",
				cwd: "/work",
				kind: "agent",
				startedAt: 500,
				reason: "running",
			},
		]);
	});

	it("keeps the original start time while the same run continues", () => {
		const first = deriveMarkers([fact({ running: true })], [], 500);
		expect(deriveMarkers([fact({ running: true })], first, 900)[0]?.startedAt).toBe(500);
	});

	it("clears the marker when the turn completes normally", () => {
		expect(deriveMarkers([fact({ running: false })], [marker({ tab: "t1" })], 900)).toEqual([]);
	});

	it("clears the marker on Stop, even while the run is still winding down", () => {
		expect(deriveMarkers([fact({ running: true, stopped: true })], [marker({ tab: "t1" })], 900)).toEqual([]);
	});

	it("keeps a turn blocked on an ask or approval as 'asking' so a relaunch reopens the card", () => {
		const [asking] = deriveMarkers([fact({ running: true, awaitingUi: true })], [], 500);
		expect(asking?.reason).toBe("asking");
	});

	it("keeps a turn waiting for the connection, so a crash during the wait still resumes it", () => {
		const [waiting] = deriveMarkers([fact({ awaitingConnection: true })], [], 500);
		expect(waiting?.reason).toBe("network");
	});

	it("ignores a tab without a session file", () => {
		expect(deriveMarkers([fact({ running: true, sessionFile: undefined })], [], 500)).toEqual([]);
	});

	it("records the paired device a hosted tab runs for", () => {
		expect(deriveMarkers([fact({ running: true, peer: "device-a" })], [], 500)[0]?.peer).toBe("device-a");
	});
});

describe("launch rules", () => {
	it("restores a cut-off turn, retries one that waited for the network, reopens an ask through stock restore", () => {
		expect(launchAction(marker({ reason: "running" }))).toBe("restore");
		expect(launchAction(marker({ reason: "network" }))).toBe("retry");
		expect(launchAction(marker({ reason: "asking" }))).toBe("restore");
	});
});

describe("isNetworkError", () => {
	it.each([
		"fetch failed: getaddrinfo ENOTFOUND api.anthropic.com",
		"Connection error.",
		"read ECONNRESET",
		"The network connection was lost (network error)",
		"stream ended before message_stop",
	])("%s is a network failure", message => {
		expect(isNetworkError(message)).toBe(true);
	});

	it.each([
		"429 usage limit reached for this account",
		"401 invalid x-api-key",
		"529 overloaded_error",
		"context length exceeded",
		undefined,
	])("%s is not", message => {
		expect(isNetworkError(message)).toBe(false);
	});
});

describe("InterruptedTurnStore", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ompdesk-resume-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("round-trips markers and replaces the file atomically (no temp file left)", () => {
		const file = join(dir, "interrupted-turns.json");
		const store = new InterruptedTurnStore(file);
		store.write([marker()]);
		expect(new InterruptedTurnStore(file).read()).toEqual([marker()]);
		expect(() => readFileSync(`${file}.tmp`)).toThrow();
	});

	it("drops malformed entries and a corrupt file instead of failing the launch", () => {
		const file = join(dir, "interrupted-turns.json");
		writeFileSync(file, JSON.stringify([marker(), { tab: 1 }, "x", null, marker({ sessionPath: "/s/b.jsonl" })]));
		expect(new InterruptedTurnStore(file).read().map(entry => entry.sessionPath)).toEqual([
			"/s/a.jsonl",
			"/s/b.jsonl",
		]);
		writeFileSync(file, "{not json");
		expect(new InterruptedTurnStore(file).read()).toEqual([]);
		expect(new InterruptedTurnStore(join(dir, "missing.json")).read()).toEqual([]);
	});

	it("does not rewrite an unchanged marker set", () => {
		const file = join(dir, "interrupted-turns.json");
		const store = new InterruptedTurnStore(file);
		store.write([marker()]);
		writeFileSync(file, "tampered");
		store.write([marker()]);
		expect(readFileSync(file, "utf8")).toBe("tampered");
	});

	// Windows refuses to rename over a file another handle has open: an e2e poll, a virus scan or a backup reading the
	// marker file at that instant made the write fail, and a running turn has no later transition to write it again.
	it("writes the markers once a reader that held the file open lets go", async () => {
		vi.useFakeTimers();
		try {
			const file = join(dir, "interrupted-turns.json");
			writeFileSync(file, "[]");
			const store = new InterruptedTurnStore(file);
			const reader = openSync(file, "r");
			store.write([marker()]);
			closeSync(reader);
			await vi.advanceTimersByTimeAsync(5_000);
			expect(store.read()).toEqual([marker()]);
			expect(readFileSync(file, "utf8")).toBe(JSON.stringify([marker()]));
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps trying while the reader holds on, reports the failure once it gives up, and writes again on the next change", async () => {
		vi.useFakeTimers();
		try {
			const file = join(dir, "interrupted-turns.json");
			writeFileSync(file, "[]");
			const failures: unknown[] = [];
			const store = new InterruptedTurnStore(file, error => failures.push(error));
			const reader = openSync(file, "r");
			try {
				store.write([marker()]);
				await vi.advanceTimersByTimeAsync(60_000);
				// A platform that lets the rename through has nothing to retry.
				if (readFileSync(file, "utf8") === "[]") expect(failures).toHaveLength(1);
			} finally {
				closeSync(reader);
			}
			store.write([marker({ sessionPath: "/s/b.jsonl" })]);
			await vi.advanceTimersByTimeAsync(5_000);
			expect(store.read().map(entry => entry.sessionPath)).toEqual(["/s/b.jsonl"]);
		} finally {
			vi.useRealTimers();
		}
	});
});

type Answer = RpcResponse | Error | (() => Promise<RpcResponse>);

/**
 * A tab's sidecar: records the commands main sends (and the timeout each was given) and answers them as scripted;
 * an `Error` answer rejects like the RPC client's timeout; `setStatus` moves it like a spawn.
 */
function fakeSidecar(answers: Partial<Record<string, Answer>> = {}, status = "ready") {
	const commands: RpcCommand[] = [];
	const timeouts: Array<[string, number | undefined]> = [];
	const events = new EventEmitter();
	const sidecar = Object.assign(events, {
		status,
		statusPayload: { status } as { status: string; sessionHeld?: true },
		rpcClient: {
			command: async (cmd: RpcCommand, timeoutMs?: number): Promise<RpcResponse> => {
				commands.push(cmd);
				timeouts.push([cmd.type, timeoutMs]);
				const answer = answers[cmd.type];
				if (answer instanceof Error) throw answer;
				if (typeof answer === "function") return answer();
				return answer ?? { type: "response", command: cmd.type, success: true, data: {} };
			},
		},
	});
	const setStatus = (next: string, detail: { sessionHeld?: true } = {}) => {
		sidecar.status = next;
		sidecar.statusPayload = { status: next, ...detail };
		sidecar.emit("status", sidecar.statusPayload);
	};
	return {
		sidecar: sidecar as unknown as SidecarLike,
		commands,
		timeouts,
		setStatus,
		listeners: () => events.listenerCount("status"),
	};
}

const RESTORED: RpcResponse = {
	type: "response",
	command: "restore_interrupted",
	success: true,
	data: { turn: true, subagents: [] },
};
const RETRIED: RpcResponse = { type: "response", command: "retry", success: true, data: { retried: true } };

interface Harness {
	dir: string;
	file: string;
	store: InterruptedTurnStore;
	facts: ResumeFact[];
	awaiting: Array<[string, boolean]>;
	commands: RpcCommand[];
	/** The timeout each command was sent with (`undefined` = the RPC client's 8 s default). */
	timeouts: Array<[string, number | undefined]>;
	/** `reachable`: what a probe of the way out answers while the link says it is up; `verified`: each host probed. */
	net: { online: boolean; wake: boolean; reachable: boolean; verified: Array<string | undefined> };
	state: { enabled: boolean; frozen: boolean; opened: ResumeMarker[] };
	resume: TurnResume;
	pool: ResumePool;
	/** Moves the tab's sidecar to another status (a spawn becoming ready, a crash). */
	setStatus: (status: string, detail?: { sessionHeld?: true }) => void;
	/** How many `status` listeners the resume left on the sidecar. */
	statusListeners: () => number;
	/** Every `setScheduledRetry` call the resume made, in order (`undefined` = cleared). */
	retries: Array<IpcScheduledRetry | undefined>;
	/** The retry timers it armed; a test fires one the way a clock would. */
	timers: Array<{ run: () => void; ms: number; cancelled: boolean }>;
	/** Every `setResuming` call (the calm "continuing" row), in order. */
	resuming: Array<[string, boolean]>;
	/** The tabs whose process the resume started, in order. */
	started: string[];
	/** What the coordinator wrote to the runtime log (gui-runtime.jsonl), in order. */
	logs: Array<[string, ResumeLogDetails]>;
	/** Moves whose command is on its way (`h.moves.begin(tab)` stands for one). */
	moves: MovesInFlight;
	/** How each launch continuation ended for its goal (`goalSettled`), in order. */
	goals: Array<[string, GoalSettlement]>;
}

function setup(
	options: {
		enabled?: boolean;
		/** Pool resume rank per tab (lower first); the pool offers none when absent. */
		rank?: Record<string, number>;
		online?: boolean;
		waitAfterWake?: boolean;
		/** The link is up but nothing answers (DNS down): a probe after a network failure takes the network offline. */
		unreachable?: boolean;
		answers?: Partial<Record<string, Answer>>;
		/** The tab's sidecar status when the resume first looks (default ready). */
		status?: string;
		/** An injected goal resume (autopilot's); default: the tab's `set_goal` resume. */
		resumeGoal?: (tabId: string) => Promise<void>;
		/** Told how a tab's launch continuation ended for its goal. */
		goalSettled?: (tabId: string, outcome: GoalSettlement) => void;
	} = {},
): Harness {
	const dir = mkdtempSync(join(tmpdir(), "ompdesk-resume-"));
	const file = join(dir, "interrupted-turns.json");
	const store = new InterruptedTurnStore(file);
	const facts: ResumeFact[] = [];
	const awaiting: Array<[string, boolean]> = [];
	const retries: Array<IpcScheduledRetry | undefined> = [];
	const timers: Array<{ run: () => void; ms: number; cancelled: boolean }> = [];
	const resuming: Array<[string, boolean]> = [];
	const started: string[] = [];
	const logs: Array<[string, ResumeLogDetails]> = [];
	const moves = new MovesInFlight();
	const goals: Array<[string, GoalSettlement]> = [];
	const { sidecar, commands, timeouts, setStatus, listeners } = fakeSidecar(options.answers, options.status);
	const net = {
		online: options.online ?? true,
		wake: options.waitAfterWake ?? false,
		reachable: !(options.unreachable ?? false),
		verified: [] as Array<string | undefined>,
	};
	const state = {
		enabled: options.enabled ?? true,
		frozen: false,
		opened: [] as ResumeMarker[],
	};
	const pool: ResumePool = {
		resumeFacts: () => facts.map(entry => ({ ...entry })),
		setAwaitingConnection: (tabId, value) => {
			awaiting.push([tabId, value]);
			const entry = facts.find(candidate => candidate.tabId === tabId);
			if (entry) entry.awaitingConnection = value;
		},
		startTab: tabId => {
			started.push(tabId);
			return sidecar;
		},
		...(options.rank ? { resumeRank: (tabId: string) => options.rank?.[tabId] ?? 2 } : {}),
		tabForSession: (sessionPath, peer) =>
			facts.find(entry => entry.sessionFile === sessionPath && entry.peer === peer)?.tabId ?? null,
		movesSettled: tabId => moves.settled(tabId),
		noteStopped: tabId => {
			const entry = facts.find(candidate => candidate.tabId === tabId);
			if (entry) entry.stopped = true;
		},
		setScheduledRetry: (_tabId, retry) => {
			retries.push(retry);
		},
		setResuming: (tabId, value) => {
			resuming.push([tabId, value]);
		},
	};
	const resume = new TurnResume({
		store,
		pool,
		network: {
			get online() {
				return net.online;
			},
			shouldWait: () => !net.online || net.wake,
			verify: async host => {
				net.verified.push(host);
				if (!net.online) return false;
				if (!net.reachable) net.online = false;
				return net.reachable;
			},
		},
		enabled: () => state.enabled,
		scheduledRetry: {
			delays: SCHEDULED_RETRY_DELAYS_MS,
			schedule: (run, ms) => {
				const timer = { run, ms, cancelled: false };
				timers.push(timer);
				return () => {
					timer.cancelled = true;
				};
			},
		},
		frozen: () => state.frozen,
		now: () => 1_000,
		openTab: markerToOpen => {
			state.opened.push(markerToOpen);
			facts.push(fact({ tabId: "opened", sessionFile: markerToOpen.sessionPath }));
			return "opened";
		},
		...(options.resumeGoal ? { resumeGoal: options.resumeGoal } : {}),
		goalSettled: (tabId, outcome) => {
			goals.push([tabId, outcome]);
			options.goalSettled?.(tabId, outcome);
		},
		log: (message, details) => {
			logs.push([message, details]);
		},
	});
	return {
		dir,
		file,
		store,
		facts,
		awaiting,
		commands,
		timeouts,
		net,
		state,
		resume,
		pool,
		setStatus,
		statusListeners: listeners,
		retries,
		timers,
		resuming,
		started,
		logs,
		moves,
		goals,
	};
}

/** Let the resume's async chain (ready → command → sync) finish. */
const settle = async () => {
	for (let i = 0; i < 40; i++) await Promise.resolve();
};

describe("TurnResume markers", () => {
	let h: Harness;
	afterEach(() => rmSync(h.dir, { recursive: true, force: true }));

	it("writes the marker when a turn starts and clears it when the turn completes", () => {
		h = setup();
		h.resume.launch();
		h.facts.push(fact({ running: true }));
		h.resume.sync();
		expect(h.store.read().map(entry => entry.reason)).toEqual(["running"]);

		h.facts[0] = fact({ running: false });
		h.resume.sync();
		expect(h.store.read()).toEqual([]);
	});

	it("clears the marker on Stop, before the run's end event arrives", () => {
		h = setup();
		h.resume.launch();
		h.facts.push(fact({ running: true }));
		h.resume.sync();
		expect(h.store.read()).toHaveLength(1);

		h.pool.noteStopped("t1");
		h.resume.sync();
		expect(h.store.read()).toEqual([]);
	});

	it("keeps an ask as 'asking' and goes back to 'running' when it is answered", () => {
		h = setup();
		h.resume.launch();
		h.facts.push(fact({ running: true, awaitingUi: true }));
		h.resume.sync();
		expect(h.store.read()[0]?.reason).toBe("asking");
		h.facts[0] = fact({ running: true, awaitingUi: false });
		h.resume.sync();
		expect(h.store.read()[0]?.reason).toBe("running");
	});

	it("writes nothing before the launch has read what the last process left", () => {
		h = setup();
		writeFileSync(h.file, JSON.stringify([marker()]));
		h.facts.push(fact({ running: false }));
		h.resume.sync();
		expect(h.store.read()).toEqual([marker()]);
	});

	it("leaves the markers alone while a quit tears the tabs down", () => {
		h = setup();
		h.resume.launch();
		h.facts.push(fact({ running: true }));
		h.resume.sync();
		h.state.frozen = true;
		h.facts.length = 0;
		h.resume.sync();
		expect(h.store.read()).toHaveLength(1);
	});

	it("writes no markers, clears old ones and restores nothing, when the setting is off", async () => {
		h = setup({ enabled: false, answers: { restore_interrupted: RESTORED } });
		writeFileSync(h.file, JSON.stringify([marker()]));
		h.resume.launch();
		await settle();
		expect(h.commands).toEqual([]);
		expect(h.store.read()).toEqual([]);
		h.facts.push(fact({ running: true }));
		h.resume.sync();
		expect(h.store.read()).toEqual([]);
	});
});

describe("TurnResume launch", () => {
	let h: Harness;
	afterEach(() => rmSync(h.dir, { recursive: true, force: true }));

	it("crash case: a marker left with no graceful quit continues the turn through stock restore and says so", async () => {
		h = setup({ answers: { restore_interrupted: RESTORED } });
		// The previous process was killed mid-run: only its marker survived on disk.
		new InterruptedTurnStore(h.file).write([marker()]);
		h.facts.push(fact({ tabId: "restored", running: false }));

		h.resume.launch();
		await settle();

		expect(h.commands.map(cmd => cmd.type)).toEqual(["restore_interrupted"]);
		expect(h.resuming).toEqual([["restored", true]]);
		// The marker stays until the resumed turn is seen running: a second crash resumes it again.
		expect(h.store.read().map(entry => entry.tab)).toEqual(["restored"]);

		h.facts[0] = fact({ tabId: "restored", running: true });
		h.resume.sync();
		expect(h.store.read()[0]).toMatchObject({ tab: "restored", reason: "running" });
	});

	it("logs each launch decision: the markers read, where each found its tab and what its continuation did", async () => {
		h = setup({ answers: { restore_interrupted: RESTORED } });
		new InterruptedTurnStore(h.file).write([marker(), marker({ tab: "m2", sessionPath: "/s/lost.jsonl" })]);
		h.facts.push(fact({ tabId: "restored" }));

		h.resume.launch();
		await settle();

		const continued = {
			action: "restore",
			restored: "turn",
			retried: false,
			prompt: false,
			goal: false,
			started: true,
		};
		expect(h.logs).toEqual([
			["launch", { markers: 2, enabled: true }],
			["marker", { session: "/s/a.jsonl", reason: "running", tab: "restored", via: "layout" }],
			["marker", { session: "/s/lost.jsonl", reason: "running", tab: "opened", via: "opened" }],
			["continue", { tab: "restored", ...continued }],
			["continue", { tab: "opened", ...continued }],
		]);
	});

	it("logs a launch with the setting off, and a continuation whose omp never came up", async () => {
		h = setup({ enabled: false });
		new InterruptedTurnStore(h.file).write([marker()]);
		h.resume.launch();
		expect(h.logs).toEqual([["launch", { markers: 1, enabled: false }]]);
		rmSync(h.dir, { recursive: true, force: true });

		h = setup({ status: "error" });
		new InterruptedTurnStore(h.file).write([marker()]);
		h.facts.push(fact({ tabId: "restored" }));
		h.resume.launch();
		await settle();
		const notReady = { tab: "restored", action: "restore", ready: false, cancelled: false };
		expect(h.logs.at(-1)).toEqual(["continue", notReady]);
	});

	it("keeps a continuation waiting while another omp holds its session, and restores it once the tab opens", async () => {
		h = setup({ answers: { restore_interrupted: RESTORED }, status: "starting" });
		new InterruptedTurnStore(h.file).write([marker()]);
		h.facts.push(fact({ tabId: "restored" }));
		h.resume.launch();
		await settle();
		// The owner wait ran out: the tab is error but opens the session by itself once the other omp lets go.
		h.setStatus("error", { sessionHeld: true });
		await settle();
		expect(h.commands.filter(command => command.type === "restore_interrupted")).toEqual([]);
		expect(h.store.read().map(entry => entry.sessionPath)).toEqual(["/s/a.jsonl"]);
		h.setStatus("ready");
		await settle();
		expect(h.commands.filter(command => command.type === "restore_interrupted")).toHaveLength(1);
		expect(h.logs.at(-1)).toMatchObject(["continue", { tab: "restored", restored: "turn", started: true }]);
	});

	it("continues the focused tab before its split's panes and the background tabs, not in marker order", async () => {
		h = setup({ answers: { restore_interrupted: RESTORED }, rank: { focus: 0, pane: 1 } });
		new InterruptedTurnStore(h.file).write([
			marker({ tab: "m1", sessionPath: "/s/back.jsonl" }),
			marker({ tab: "m2", sessionPath: "/s/pane.jsonl" }),
			marker({ tab: "m3", sessionPath: "/s/focus.jsonl" }),
		]);
		h.facts.push(
			fact({ tabId: "back", sessionFile: "/s/back.jsonl" }),
			fact({ tabId: "pane", sessionFile: "/s/pane.jsonl" }),
			fact({ tabId: "focus", sessionFile: "/s/focus.jsonl" }),
		);

		h.resume.launch();
		await settle();

		expect(h.started.slice(0, 3)).toEqual(["focus", "pane", "back"]);
		expect(h.resuming.filter(([, shown]) => shown).map(([tab]) => tab)).toEqual(["back", "pane", "focus"]);
	});

	it("opens a tab for a marked session the saved layout no longer has, background tab or not", async () => {
		h = setup({ answers: { restore_interrupted: RESTORED } });
		new InterruptedTurnStore(h.file).write([marker({ sessionPath: "/s/lost.jsonl" })]);
		h.resume.launch();
		await settle();
		expect(h.state.opened.map(entry => entry.sessionPath)).toEqual(["/s/lost.jsonl"]);
		expect(h.commands.map(cmd => cmd.type)).toEqual(["restore_interrupted"]);
	});

	it("drops a paired host's turn a client marked before hosts owned their resume", async () => {
		h = setup();
		writeFileSync(h.file, JSON.stringify([{ ...marker(), device: "host-1" }]));
		h.resume.launch();
		await settle();
		expect(h.commands).toEqual([]);
		expect(h.resuming).toEqual([]);
		expect(h.store.read()).toEqual([]);
	});

	it("continues a turn this computer ran for a paired device in that device's tab, not a local one", async () => {
		h = setup({ answers: { restore_interrupted: RESTORED } });
		// This computer's own tab on the same session path is not the device's.
		h.facts.push(fact({ tabId: "local" }));
		new InterruptedTurnStore(h.file).write([marker({ tab: "peer:device-a:r1", peer: "device-a" })]);
		h.resume.launch();
		await settle();
		expect(h.state.opened).toEqual([marker({ tab: "peer:device-a:r1", peer: "device-a" })]);
		expect(h.commands.map(cmd => cmd.type)).toEqual(["restore_interrupted"]);
	});

	it("does not resume a turn the user stopped: Stop cleared its marker before the kill", async () => {
		h = setup();
		h.resume.launch();
		h.facts.push(fact({ running: true }));
		h.resume.sync();
		h.pool.noteStopped("t1");
		h.resume.sync();
		// Relaunch after the kill.
		const second = setup();
		second.facts.push(fact({ running: false }));
		new InterruptedTurnStore(second.file).write(h.store.read());
		second.resume.launch();
		await settle();
		expect(second.commands).toEqual([]);
		rmSync(second.dir, { recursive: true, force: true });
	});

	it("reopens an ask's card through the same restore, without counting it as continuing work", async () => {
		h = setup({ answers: { restore_interrupted: RESTORED } });
		new InterruptedTurnStore(h.file).write([marker({ reason: "asking" })]);
		h.facts.push(fact({ tabId: "restored", running: false }));
		h.resume.launch();
		await settle();
		expect(h.commands.map(cmd => cmd.type)).toEqual(["restore_interrupted"]);
		expect(h.resuming).toEqual([]);
	});

	it("replays an ask omp closed itself when OMPdesk died: restore finds nothing, stock retry reopens it", async () => {
		// A killed OMPdesk's omp sees stdin close, fails the pending ask ("RPC client disconnected…") and
		// journals the run as aborted before it exits: nothing is unfinished for restoreSession.
		h = setup({
			answers: {
				restore_interrupted: {
					type: "response",
					command: "restore_interrupted",
					success: true,
					data: { turn: false, subagents: [] },
				},
				retry: RETRIED,
			},
		});
		new InterruptedTurnStore(h.file).write([marker({ reason: "asking" })]);
		h.facts.push(fact({ tabId: "restored", running: false }));
		h.resume.launch();
		await settle();
		expect(h.commands.map(cmd => cmd.type)).toEqual(["restore_interrupted", "retry"]);
		expect(h.store.read().map(entry => entry.reason)).toEqual(["asking"]);
		expect(h.resuming).toEqual([]);
	});

	it("drops a marker whose turn had nothing left to continue", async () => {
		h = setup({
			answers: {
				restore_interrupted: {
					type: "response",
					command: "restore_interrupted",
					success: true,
					data: { turn: false, subagents: [] },
				},
			},
		});
		new InterruptedTurnStore(h.file).write([marker()]);
		h.facts.push(fact({ tabId: "restored", running: false }));
		h.resume.launch();
		await settle();
		expect(h.store.read()).toEqual([]);
	});

	const restoreAnswer = (data: Record<string, unknown>): RpcResponse => ({
		type: "response",
		command: "restore_interrupted",
		success: true,
		data: { turn: false, subagents: [], ...data },
	});

	it("counts background jobs the restart stopped as continuing: the bridge told the agent, nothing is retried", async () => {
		h = setup({ answers: { restore_interrupted: restoreAnswer({ jobs: ["bg_1"] }) } });
		new InterruptedTurnStore(h.file).write([marker()]);
		h.facts.push(fact({ tabId: "restored", running: false }));
		h.resume.launch();
		await settle();
		expect(h.commands.map(cmd => cmd.type)).toEqual(["restore_interrupted"]);
		expect(h.store.read().map(entry => entry.tab)).toEqual(["restored"]);
		expect(h.resuming[0]).toEqual(["restored", true]);
	});

	it("gives the restore room: stock reads every subagent transcript first, past the RPC client's 8 s default", async () => {
		// 18 Oct 2026, v0.37.0: a session with 577 subagent transcripts (1.1 GB) answered after the 8 s default, so the
		// reply was cut and logged `failed` while stock went on reviving the subagent.
		h = setup({ answers: { restore_interrupted: restoreAnswer({ turn: false }) } });
		new InterruptedTurnStore(h.file).write([marker()]);
		h.facts.push(fact({ tabId: "restored", running: false }));
		h.resume.launch();
		await settle();
		expect(h.timeouts).toEqual([
			["restore_interrupted", RESUME_COMMAND_TIMEOUT_MS],
			["retry", RESUME_COMMAND_TIMEOUT_MS],
		]);
		expect(RESUME_COMMAND_TIMEOUT_MS).toBeGreaterThan(8_000);
	});

	it("falls back to stock retry when the restore fails, and logs why each did not continue", async () => {
		h = setup({
			answers: {
				restore_interrupted: new Error("RPC timeout (120000ms): restore_interrupted"),
				retry: { type: "response", command: "retry", success: false, error: "Agent is busy", code: "busy" },
			},
		});
		new InterruptedTurnStore(h.file).write([marker()]);
		h.facts.push(fact({ tabId: "restored", running: false }));
		h.resume.launch();
		await settle();
		expect(h.commands.map(cmd => cmd.type)).toEqual(["restore_interrupted", "retry"]);
		expect(h.logs.at(-1)).toEqual([
			"continue",
			{
				tab: "restored",
				action: "restore",
				restored: "failed",
				retried: false,
				prompt: false,
				goal: false,
				started: false,
				restoreError: "RPC timeout (120000ms): restore_interrupted",
				retryError: "Agent is busy",
				retryCode: "busy",
			},
		]);
		// Nothing went on: the marker has nothing more to say.
		expect(h.store.read()).toEqual([]);
	});

	it("lets a restore that revived subagents of an idle session go on through the bridge's one follow-up, never a retry", async () => {
		// 18 Oct 2026, v0.38.1: the main turn had ended, six background subagents were revived and the session sat
		// silent. The bridge now tells the agent in one follow-up (`followUp`), which is the session's turn.
		h = setup({
			answers: { restore_interrupted: restoreAnswer({ subagents: ["Release", "Review"], followUp: true }) },
		});
		new InterruptedTurnStore(h.file).write([marker()]);
		h.facts.push(fact({ tabId: "restored", running: false }));
		h.resume.launch();
		await settle();
		expect(h.commands.map(cmd => cmd.type)).toEqual(["restore_interrupted"]);
		expect(h.logs.at(-1)).toEqual([
			"continue",
			{
				tab: "restored",
				action: "restore",
				restored: "subagents:2",
				retried: false,
				prompt: false,
				goal: false,
				started: true,
				followUp: true,
			},
		]);
		// The marker waits for that turn; once it ran, nothing restores the tab again in this launch.
		expect(h.store.read().map(entry => entry.tab)).toEqual(["restored"]);
		h.facts[0] = fact({ tabId: "restored", running: true });
		h.resume.sync();
		h.facts[0] = fact({ tabId: "restored", running: false });
		h.resume.sync();
		await settle();
		expect(h.commands.map(cmd => cmd.type)).toEqual(["restore_interrupted"]);
		expect(h.store.read()).toEqual([]);
	});

	it("lets the bridge's follow-up continue a turn stock's retry cannot see, and sends no retry on top", async () => {
		// 21 Oct 2026, v0.48.0 → v0.49.0: a note journaled after the aborted reply hid it from stock's `/retry`; the
		// relaunch logged `restored: nothing, retried: false` and two running sessions sat idle.
		h = setup({ answers: { restore_interrupted: restoreAnswer({ followUp: true, turnCut: true }) } });
		new InterruptedTurnStore(h.file).write([marker()]);
		h.facts.push(fact({ tabId: "restored", running: false }));
		h.resume.launch();
		await settle();
		expect(h.commands.map(cmd => cmd.type)).toEqual(["restore_interrupted"]);
		expect(h.logs.at(-1)).toEqual([
			"continue",
			{
				tab: "restored",
				action: "restore",
				restored: "turn-behind-notes",
				retried: false,
				prompt: false,
				goal: false,
				started: true,
				followUp: true,
			},
		]);
	});

	it("resumes a goal stock paused at startup after the restore, once", async () => {
		h = setup({ answers: { restore_interrupted: restoreAnswer({ turn: true, goalPausedByExit: true }) } });
		new InterruptedTurnStore(h.file).write([marker()]);
		h.facts.push(fact({ tabId: "restored", running: false }));
		h.resume.launch();
		await settle();
		expect(h.commands).toEqual([{ type: "restore_interrupted" }, { type: "set_goal", action: "resume" }]);
	});

	it("leaves a goal alone that was already paused before the exit, and uses an injected goal resume", async () => {
		h = setup({ answers: { restore_interrupted: restoreAnswer({ turn: true, goalPausedByExit: false }) } });
		new InterruptedTurnStore(h.file).write([marker()]);
		h.facts.push(fact({ tabId: "restored", running: false }));
		h.resume.launch();
		await settle();
		expect(h.commands.map(cmd => cmd.type)).toEqual(["restore_interrupted"]);
		rmSync(h.dir, { recursive: true, force: true });

		const resumed: string[] = [];
		h = setup({
			answers: { restore_interrupted: restoreAnswer({ goalPausedByExit: true }) },
			resumeGoal: async tabId => {
				resumed.push(tabId);
			},
		});
		new InterruptedTurnStore(h.file).write([marker()]);
		h.facts.push(fact({ tabId: "restored", running: false }));
		h.resume.launch();
		await settle();
		expect(resumed).toEqual(["restored"]);
		// The goal's continuation is the work going on: the marker stays until its turn runs.
		expect(h.commands.map(cmd => cmd.type)).toEqual(["restore_interrupted", "retry"]);
		expect(h.store.read().map(entry => entry.tab)).toEqual(["restored"]);
	});

	it("tells the goal hook how the launch continuation ended: resumed, none (also when the tab never came up), cancelled", async () => {
		const settled: Array<[string, GoalSettlement]> = [];
		const goalSettled = (tabId: string, outcome: GoalSettlement) => void settled.push([tabId, outcome]);
		h = setup({
			answers: { restore_interrupted: restoreAnswer({ turn: true, goalPausedByExit: true }) },
			resumeGoal: async () => undefined,
			goalSettled,
		});
		new InterruptedTurnStore(h.file).write([marker()]);
		h.facts.push(fact({ tabId: "restored", running: false }));
		h.resume.launch();
		await settle();
		expect(settled).toEqual([["restored", "resumed"]]);
		rmSync(h.dir, { recursive: true, force: true });

		settled.length = 0;
		h = setup({
			answers: { restore_interrupted: restoreAnswer({ turn: true, goalPausedByExit: false }) },
			goalSettled,
		});
		new InterruptedTurnStore(h.file).write([marker()]);
		h.facts.push(fact({ tabId: "restored", running: false }));
		h.resume.launch();
		await settle();
		expect(settled).toEqual([["restored", "none"]]);
		rmSync(h.dir, { recursive: true, force: true });

		settled.length = 0;
		h = setup({ status: "error", goalSettled });
		new InterruptedTurnStore(h.file).write([marker()]);
		h.facts.push(fact({ tabId: "restored", running: false }));
		h.resume.launch();
		await settle();
		expect(settled).toEqual([["restored", "none"]]);
		rmSync(h.dir, { recursive: true, force: true });

		// The toast's Stop while the tab's omp is still starting.
		settled.length = 0;
		h = setup({ status: "starting", goalSettled });
		new InterruptedTurnStore(h.file).write([marker()]);
		h.facts.push(fact({ tabId: "restored", running: false }));
		h.resume.launch();
		await h.resume.stopResumed("restored");
		h.setStatus("ready");
		await settle();
		expect(settled).toEqual([["restored", "cancelled"]]);
	});

	it("says how a tab whose omp came up again goes on: after its launch continuation, at once, or not at all", async () => {
		h = setup({ answers: { restore_interrupted: restoreAnswer({ turn: true }) } });
		new InterruptedTurnStore(h.file).write([marker()]);
		h.facts.push(fact({ tabId: "restored", running: false }));
		expect(h.resume.relaunchContinuation("restored")).toBe("now");
		h.resume.launch();
		expect(h.resume.relaunchContinuation("restored")).toBe("after_restore");
		expect(h.resume.relaunchContinuation("other")).toBe("now");
		h.state.enabled = false;
		expect(h.resume.relaunchContinuation("other")).toBe("off");
		await settle();
	});

	it("sends a new session's first prompt again when the cut-off turn left no file to restore", async () => {
		h = setup({ answers: { restore_interrupted: restoreAnswer({}) } });
		h.resume.launch();
		h.facts.push(fact({ running: true, unsavedPrompt: "list the fruits" }));
		h.resume.sync();
		expect(h.store.read()[0]?.prompt).toBe("list the fruits");
		const second = setup({ answers: { restore_interrupted: restoreAnswer({}) } });
		second.facts.push(fact({ tabId: "restored", running: false }));
		new InterruptedTurnStore(second.file).write(h.store.read());
		second.resume.launch();
		await settle();
		expect(second.commands).toEqual([
			{ type: "restore_interrupted" },
			{ type: "retry" },
			{ type: "prompt", message: "list the fruits" },
		]);
		// Sent once: the prompt left the marker before it went, the marker itself stays until the turn runs.
		expect(second.store.read()).toMatchObject([{ tab: "restored" }]);
		expect(second.store.read()[0]?.prompt).toBeUndefined();
		rmSync(second.dir, { recursive: true, force: true });
	});

	it("runs a first turn whose session was never written in the fresh tab the layout restored for it, not a hidden new one", async () => {
		h = setup({ answers: { restore_interrupted: restoreAnswer({}) } });
		// The layout drops a session path with no file, so its tab came back as a fresh session in the same folder.
		h.facts.push(fact({ tabId: "elsewhere", cwd: "/elsewhere", sessionFile: undefined }));
		h.facts.push(fact({ tabId: "restored", sessionFile: undefined }));
		new InterruptedTurnStore(h.file).write([
			marker({ sessionPath: join(h.dir, "never-written.jsonl"), prompt: "list the fruits" }),
			marker({ tab: "old-2", sessionPath: join(h.dir, "never-written-2.jsonl"), prompt: "list the vegetables" }),
		]);
		h.resume.launch();
		await settle();
		// One restored tab per unwritten session: the second has none left and gets a tab opened for it.
		expect(h.state.opened.map(entry => entry.prompt)).toEqual(["list the vegetables"]);
		expect(h.store.read().map(entry => entry.tab)).toEqual(["restored", "opened"]);
		expect(h.commands.filter(cmd => cmd.type === "prompt")).toEqual([
			{ type: "prompt", message: "list the fruits" },
			{ type: "prompt", message: "list the vegetables" },
		]);
	});

	it("never continues a session the user deleted (no fresh tab in its folder), while an unwritten one still continues", async () => {
		h = setup({ answers: { restore_interrupted: restoreAnswer({}) } });
		const deleted = join(h.dir, "deleted.jsonl");
		initDeletedSessions(null);
		deletedSessions().add(deleted);
		h.facts.push(fact({ tabId: "restored", sessionFile: undefined }));
		new InterruptedTurnStore(h.file).write([
			marker({ tab: "old-del", sessionPath: deleted, prompt: "deleted work" }),
			marker({ sessionPath: join(h.dir, "never-written.jsonl"), prompt: "list the fruits" }),
		]);
		h.resume.launch();
		await settle();
		initDeletedSessions(null);
		expect(h.state.opened).toEqual([]);
		expect(h.commands.filter(cmd => cmd.type === "prompt")).toEqual([{ type: "prompt", message: "list the fruits" }]);
		expect(h.store.read().map(entry => entry.sessionPath)).not.toContain(deleted);
	});

	it("shows the calm continuing row from launch until the turn runs, never for a reopened card", async () => {
		h = setup({ answers: { restore_interrupted: RESTORED } });
		new InterruptedTurnStore(h.file).write([
			marker(),
			marker({ tab: "asked", sessionPath: "/s/ask.jsonl", reason: "asking" }),
		]);
		h.facts.push(fact({ tabId: "restored", running: false }));
		h.facts.push(fact({ tabId: "asked", sessionFile: "/s/ask.jsonl", running: false }));
		h.resume.launch();
		expect(h.resuming).toEqual([["restored", true]]);
		await settle();
		h.facts[0] = fact({ tabId: "restored", running: true });
		h.resume.sync();
		expect(h.resuming).toEqual([
			["restored", true],
			["restored", false],
		]);
	});

	it("goes through the connection wait when the launch is offline, then continues once it is back", async () => {
		h = setup({ online: false, answers: { restore_interrupted: RESTORED } });
		new InterruptedTurnStore(h.file).write([marker()]);
		h.facts.push(fact({ tabId: "restored", running: false }));
		h.resume.launch();
		await settle();
		expect(h.awaiting).toEqual([["restored", true]]);
		expect(h.commands).toEqual([]);
		// Still marked (as the original action), so a crash while offline resumes as well.
		expect(h.store.read().map(entry => entry.reason)).toEqual(["running"]);

		h.net.online = true;
		h.resume.connectivityChanged();
		await settle();
		expect(h.commands.map(cmd => cmd.type)).toEqual(["restore_interrupted"]);
		expect(h.awaiting.at(-1)).toEqual(["restored", false]);
	});

	it("drops a held launch marker, and its wait, once its tab is closed", async () => {
		h = setup({ online: false, answers: { restore_interrupted: RESTORED } });
		new InterruptedTurnStore(h.file).write([marker()]);
		h.facts.push(fact({ tabId: "restored", running: false }));
		h.resume.launch();
		await settle();
		expect(h.store.read()).toHaveLength(1);

		// The user closes the held tab while still offline: nothing is left to continue on a later launch.
		h.facts.splice(0);
		h.resume.sync();
		expect(h.store.read()).toEqual([]);
		h.net.online = true;
		h.resume.connectivityChanged();
		await settle();
		expect(h.commands).toEqual([]);
	});

	it("Stop on the toast aborts what the launch resumed and marks it stopped", async () => {
		h = setup({ answers: { restore_interrupted: RESTORED } });
		new InterruptedTurnStore(h.file).write([marker()]);
		h.facts.push(fact({ tabId: "restored", running: false }));
		h.resume.launch();
		await settle();
		h.facts[0] = fact({ tabId: "restored", running: true });
		h.resume.sync();

		await h.resume.stopResumed("restored");
		expect(h.commands.map(cmd => cmd.type)).toEqual(["restore_interrupted", "abort"]);
		h.resume.sync();
		expect(h.store.read()).toEqual([]);
	});

	it("Stop on the toast while the resumed tab's omp still starts: nothing continues once it is ready", async () => {
		h = setup({ status: "starting", answers: { restore_interrupted: RESTORED } });
		new InterruptedTurnStore(h.file).write([marker()]);
		h.facts.push(fact({ tabId: "restored", running: false }));
		h.resume.launch();
		await settle();
		expect(h.commands).toEqual([]);

		await h.resume.stopResumed("restored");
		h.setStatus("ready");
		await settle();
		expect(h.commands.map(cmd => cmd.type)).not.toContain("restore_interrupted");
		h.resume.sync();
		expect(h.store.read()).toEqual([]);
		expect(h.statusListeners()).toBe(0);
	});

	it("Cancel while the held tab's omp still starts: the continuation never runs", async () => {
		h = setup({ online: false, status: "starting", answers: { restore_interrupted: RESTORED } });
		new InterruptedTurnStore(h.file).write([marker()]);
		h.facts.push(fact({ tabId: "restored", running: false }));
		h.resume.launch();
		h.net.online = true;
		h.resume.connectivityChanged();
		await settle();
		expect(h.commands).toEqual([]);

		h.resume.cancelWait("restored");
		h.setStatus("ready");
		await settle();
		expect(h.commands).toEqual([]);
		expect(h.store.read()).toEqual([]);
	});

	it("drops the marker of a tab whose omp already failed instead of waiting for a status that never comes", async () => {
		h = setup({ status: "error", answers: { restore_interrupted: RESTORED } });
		new InterruptedTurnStore(h.file).write([marker()]);
		h.facts.push(fact({ tabId: "restored", running: false }));
		h.resume.launch();
		await settle();
		expect(h.commands).toEqual([]);
		expect(h.store.read()).toEqual([]);
		expect(h.statusListeners()).toBe(0);
	});

	it("gives up on a tab whose omp never becomes ready", async () => {
		vi.useFakeTimers();
		try {
			h = setup({ status: "starting", answers: { restore_interrupted: RESTORED } });
			new InterruptedTurnStore(h.file).write([marker()]);
			h.facts.push(fact({ tabId: "restored", running: false }));
			h.resume.launch();
			await settle();
			expect(h.store.read()).toHaveLength(1);

			await vi.advanceTimersByTimeAsync(RESUME_READY_TIMEOUT_MS);
			expect(h.commands).toEqual([]);
			expect(h.store.read()).toEqual([]);
			expect(h.statusListeners()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("TurnResume connection wait", () => {
	let h: Harness;
	afterEach(() => rmSync(h.dir, { recursive: true, force: true }));

	const networkFailure = { stopReason: "error", errorMessage: "fetch failed: getaddrinfo ENOTFOUND api.example.com" };

	it("a network error while offline waits instead of failing, and the stock retry runs once the network is back", async () => {
		h = setup({ online: false, answers: { retry: RETRIED } });
		h.resume.launch();
		h.facts.push(fact({ running: false, lastRun: { ...networkFailure } }));
		h.resume.sync();
		expect(h.awaiting).toEqual([["t1", true]]);
		expect(h.commands).toEqual([]);
		// A crash during the wait still resumes: the marker says so.
		expect(h.store.read().map(entry => entry.reason)).toEqual(["network"]);

		h.net.online = true;
		h.resume.connectivityChanged();
		await settle();
		expect(h.commands.map(cmd => cmd.type)).toEqual(["retry"]);
		expect(h.awaiting.at(-1)).toEqual(["t1", false]);
	});

	it("leaves a paired host's tab to its host: no marker, no wait, no takeover by this computer's connection", async () => {
		h = setup({ online: false, answers: { retry: RETRIED } });
		h.resume.launch();
		h.facts.push(fact({ running: true, device: "host-1", retry: { errorMessage: "Connection error." } }));
		h.resume.sync();
		h.facts[0] = fact({ running: false, device: "host-1", lastRun: { ...networkFailure } });
		h.resume.sync();
		h.net.online = true;
		h.resume.connectivityChanged();
		await settle();
		expect(h.awaiting).toEqual([]);
		expect(h.commands).toEqual([]);
		expect(h.store.read()).toEqual([]);
	});

	it("a network error just after a wake waits too, and continues as soon as the network answers", async () => {
		h = setup({ online: true, waitAfterWake: true, answers: { retry: RETRIED } });
		h.resume.launch();
		h.facts.push(fact({ running: false, lastRun: { ...networkFailure } }));
		h.resume.sync();
		await settle();
		expect(h.commands.map(cmd => cmd.type)).toEqual(["retry"]);
	});

	it("an ordinary failure while online is a failure: no waiting, no retry", async () => {
		// Stock's retry is off here, so the scheduled retry (its own describe below) stays out of a test about the connection wait.
		h = setup({ online: true, answers: { get_settings: SETTINGS_OFF } });
		h.resume.launch();
		h.facts.push(fact({ running: false, lastRun: { stopReason: "error", errorMessage: "fetch failed: ENOTFOUND" } }));
		h.resume.sync();
		await settle();
		// A failed lookup is probed first (the row shows meanwhile); the way out answered, so it is a failure.
		expect(h.awaiting.at(-1)).toEqual(["t1", false]);
		expect(h.commands.map(cmd => cmd.type)).not.toContain("retry");
	});

	it("a non-network error while offline is not a wait", () => {
		h = setup({ online: false });
		h.resume.launch();
		h.facts.push(fact({ running: false, lastRun: { stopReason: "error", errorMessage: "429 usage limit reached" } }));
		h.resume.sync();
		expect(h.awaiting).toEqual([]);
	});

	it("Cancel ends the wait: the failure shows, nothing retries, and the same error does not re-arm it", async () => {
		h = setup({ online: false, answers: { retry: RETRIED } });
		h.resume.launch();
		h.facts.push(fact({ running: false, lastRun: { ...networkFailure } }));
		h.resume.sync();
		h.resume.cancelWait("t1");
		h.resume.sync();
		h.net.online = true;
		h.resume.connectivityChanged();
		await settle();
		expect(h.awaiting).toEqual([
			["t1", true],
			["t1", false],
		]);
		expect(h.commands).toEqual([]);
		expect(h.store.read()).toEqual([]);
	});

	it("a prompt sent during the wait replaces it: the waiting row goes and nothing retries into the new run", async () => {
		h = setup({ online: false, answers: { retry: RETRIED } });
		h.resume.launch();
		h.facts.push(fact({ running: false, lastRun: { ...networkFailure } }));
		h.resume.sync();
		expect(h.awaiting).toEqual([["t1", true]]);

		// Still offline, the user sends a new prompt: a new run starts on the held tab.
		h.facts[0] = fact({ running: true, awaitingConnection: true });
		h.resume.sync();
		expect(h.awaiting.at(-1)).toEqual(["t1", false]);
		expect(h.store.read().map(entry => entry.reason)).toEqual(["running"]);

		h.net.online = true;
		h.resume.connectivityChanged();
		await settle();
		expect(h.commands).toEqual([]);
	});

	it("a user-stopped turn is not a network wait", () => {
		h = setup({ online: false });
		h.resume.launch();
		h.facts.push(fact({ running: false, lastRun: { stopReason: "aborted" } }));
		h.resume.sync();
		expect(h.awaiting).toEqual([]);
	});

	it("offline, stock's auto-retry of a transport failure is taken over at its first attempt: cancelled, held, retried once online", async () => {
		h = setup({ online: false, answers: { retry: RETRIED } });
		h.resume.launch();
		h.facts.push(fact({ running: true, retry: { errorMessage: "Connection error." } }));
		h.resume.sync();
		h.resume.sync();
		await settle();
		expect(h.awaiting).toEqual([["t1", true]]);
		expect(h.commands.map(cmd => cmd.type)).toEqual(["abort_retry"]);
		expect(h.store.read().map(entry => entry.reason)).toEqual(["network"]);

		// The saga's auto_retry_end can come before its agent_end: still the held run, not a new one.
		h.facts[0] = { ...fact({ running: true }), awaitingConnection: true };
		h.resume.sync();
		expect(h.awaiting).toEqual([["t1", true]]);
		// The cancelled saga ends the turn failed while the wait holds it.
		h.facts[0] = {
			...fact({ running: false, lastRun: { stopReason: "error", errorMessage: "Retry cancelled" } }),
			awaitingConnection: true,
		};
		h.resume.sync();
		h.net.online = true;
		h.resume.connectivityChanged();
		await settle();
		expect(h.commands.map(cmd => cmd.type)).toEqual(["abort_retry", "retry"]);
		expect(h.awaiting.at(-1)).toEqual(["t1", false]);
	});

	it("leaves stock's auto-retry alone while online (a wake's window included) and for a non-transport failure", async () => {
		h = setup({ online: true, waitAfterWake: true });
		h.resume.launch();
		h.facts.push(fact({ running: true, retry: { errorMessage: "Connection error." } }));
		h.resume.sync();
		h.net.online = false;
		h.facts[0] = fact({ running: true, retry: { errorMessage: "529 overloaded" } });
		h.resume.sync();
		await settle();
		expect(h.awaiting).toEqual([]);
		expect(h.commands).toEqual([]);
	});

	it("judges a network failure as soon as it is the run's outcome, before the session settles", () => {
		h = setup({ online: false });
		h.resume.launch();
		h.facts.push(fact({ running: true, lastRun: { ...networkFailure } }));
		h.resume.sync();
		expect(h.awaiting).toEqual([["t1", true]]);
	});

	it("a network failure while the link is up but nothing answers (DNS down) waits for the connection, then continues by itself", async () => {
		h = setup({ online: true, unreachable: true, answers: { retry: RETRIED } });
		h.resume.launch();
		h.facts.push(fact({ running: false, lastRun: { ...networkFailure } }));
		h.resume.sync();
		await settle();
		expect(h.awaiting.length).toBeGreaterThan(0);
		expect(h.awaiting.every(([, waiting]) => waiting)).toBe(true);
		expect(h.net.verified).toEqual(["api.example.com"]);
		expect(h.retries).toEqual([]);
		expect(h.store.read().map(entry => entry.reason)).toEqual(["network"]);

		h.net.reachable = true;
		h.net.online = true;
		h.resume.connectivityChanged();
		await settle();
		expect(h.commands.map(cmd => cmd.type)).toEqual(["retry"]);
		expect(h.awaiting.at(-1)).toEqual(["t1", false]);
	});

	it("a network failure while the provider's way out answers keeps the scheduled retry (the failure was not the connection)", async () => {
		h = setup({ online: true, answers: { get_settings: SETTINGS_ON } });
		h.resume.launch();
		h.facts.push(fact({ running: false, lastRun: { ...networkFailure } }));
		h.resume.sync();
		await settle();
		expect(h.awaiting.at(-1)).toEqual(["t1", false]);
		expect(h.retries.map(retry => retry?.attempt)).toEqual([1]);
	});

	it("a prompt sent while the reachability probe is out wins: no wait is put over the new run", async () => {
		h = setup({ online: true, unreachable: true });
		h.resume.launch();
		h.facts.push(fact({ running: false, lastRun: { ...networkFailure } }));
		h.resume.sync();
		h.facts[0] = fact({ running: true });
		h.resume.sync();
		await settle();
		expect(h.awaiting.at(-1)).toEqual(["t1", false]);
	});

	it("only a failed lookup is probed: a dropped socket while online goes to the scheduled retry as before", async () => {
		h = setup({ online: true, unreachable: true, answers: { get_settings: SETTINGS_ON } });
		h.resume.launch();
		h.facts.push(fact({ running: false, lastRun: { stopReason: "error", errorMessage: "socket hang up" } }));
		h.resume.sync();
		await settle();
		expect(h.net.verified).toEqual([]);
		expect(h.awaiting).toEqual([]);
		expect(h.retries.map(retry => retry?.attempt)).toEqual([1]);
	});

	it.each([
		["Cancel", (x: Harness) => x.resume.cancelWait("t1")],
		[
			"Stop",
			(x: Harness) => {
				x.pool.noteStopped("t1");
				x.resume.sync();
			},
		],
		[
			"another session on the tab",
			(x: Harness) => {
				x.facts[0] = { ...(x.facts[0] as ResumeFact), sessionFile: "/s/other.jsonl" };
				x.resume.sync();
			},
		],
		[
			"a branch switch",
			(x: Harness) => {
				x.facts[0] = { ...(x.facts[0] as ResumeFact), touched: 1 };
				x.resume.sync();
			},
		],
	])("%s while the lookup is probed ends it: no wait, nothing retried once online", async (_name, interrupt) => {
		h = setup({ online: true, unreachable: true, answers: { retry: RETRIED, get_settings: SETTINGS_OFF } });
		h.resume.launch();
		h.facts.push(fact({ running: false, lastRun: { ...networkFailure } }));
		h.resume.sync();
		interrupt(h);
		await settle();
		expect(h.awaiting.at(-1)).toEqual(["t1", false]);
		h.net.reachable = true;
		h.net.online = true;
		h.resume.connectivityChanged();
		await settle();
		expect(h.commands.map(cmd => cmd.type)).not.toContain("retry");
	});
});

describe("dnsFailureHost", () => {
	it.each([
		[
			"Couldn't reach api.anthropic.com (getaddrinfo ENOTFOUND). Check the URL, your network, or proxy.",
			"api.anthropic.com",
		],
		["fetch failed: getaddrinfo ENOTFOUND api.example.com", "api.example.com"],
		["getaddrinfo EAI_AGAIN API.OpenAI.com", "api.openai.com"],
		["fetch failed: ENOTFOUND", ""],
		["socket hang up", null],
		["503 Service unavailable", null],
	])("%s → %s", (message, host) => {
		expect(dnsFailureHost(message)).toBe(host);
	});
});

describe("isTransientError", () => {
	it.each([
		"503 Service unavailable: fixture provider temporarily unavailable",
		"502 Bad Gateway",
		"HTTP 500 Internal Server Error",
		"500 internal server error",
		"504 Gateway Timeout",
		"524 A timeout occurred",
		"529 overloaded_error",
		"Overloaded",
		"The server is overloaded, try your request again",
		"Request timed out.",
		"Connection error.",
		"fetch failed: getaddrinfo ENOTFOUND api.anthropic.com",
		"read ECONNRESET",
		"stream ended before message_stop",
		"upstream connect error or disconnect/reset before headers",
		"Provider returned error",
		"websocket closed 1006",
		"terminated",
	])("%s is transient", message => {
		expect(isTransientError(message)).toBe(true);
	});

	it.each([
		// sign-in and permission
		"401 invalid x-api-key",
		"403 Forbidden",
		"Invalid API key provided",
		"Unauthorized",
		"Authentication failed: token has expired",
		"Not logged in · Please run /login",
		// quota, billing and rate limits (the quota-resume path owns these)
		"429 usage limit reached for this account",
		"Rate limit exceeded, 503 try later",
		"429 Too Many Requests",
		"You exceeded your current quota, please check your plan and billing details",
		"insufficient_quota",
		"Monthly usage limit reached",
		"Your credit balance is too low (insufficient funds)",
		// a request the provider rejected
		"400 Bad Request",
		"400 invalid_request_error: messages.0.content: Input should be a valid list",
		"Invalid request: temperature out of range",
		// a context that does not fit
		"prompt is too long: 215000 tokens > 200000 maximum",
		"context length exceeded",
		"This model's maximum context length is 128000 tokens, 503 requested",
		"too many tokens in the request",
		// certificates and TLS
		"unable to verify the first certificate",
		"self-signed certificate in certificate chain",
		"SSL routines: tlsv1 alert (connection error)",
		"ERR_TLS_CERT_ALTNAME_INVALID",
		// not provider failures at all
		"Something odd happened",
		undefined,
		"",
	])("%s is not", message => {
		expect(isTransientError(message)).toBe(false);
	});

	it("never reads a status code inside a bigger number", () => {
		expect(isTransientError("The request used 500000 tokens")).toBe(false);
		expect(isTransientError("id 1502 was not found")).toBe(false);
		expect(isTransientError("error 5030")).toBe(false);
		expect(isTransientError("error 503")).toBe(true);
	});
});

describe("retryDelays and TOUCH_COMMANDS", () => {
	it("defaults to 30 s, 2 min, 10 min and takes a comma list of milliseconds from the environment", () => {
		expect(SCHEDULED_RETRY_DELAYS_MS).toEqual([30_000, 120_000, 600_000]);
		expect(retryDelays(undefined)).toBe(SCHEDULED_RETRY_DELAYS_MS);
		expect(retryDelays("")).toBe(SCHEDULED_RETRY_DELAYS_MS);
		expect(retryDelays("abc")).toBe(SCHEDULED_RETRY_DELAYS_MS);
		expect(retryDelays("0,5")).toBe(SCHEDULED_RETRY_DELAYS_MS);
		expect(retryDelays("1500, 3000")).toEqual([1500, 3000]);
	});

	it("names the commands that move a tab to another session or branch", () => {
		expect(Object.keys(TOUCH_COMMANDS).sort()).toEqual([
			"branch",
			"fork",
			"new_session",
			"switch_leaf",
			"switch_session",
		]);
	});
});

const SETTINGS_ON: RpcResponse = {
	type: "response",
	command: "get_settings",
	success: true,
	data: { values: { "retry.enabled": true } },
};

const SETTINGS_OFF: RpcResponse = {
	type: "response",
	command: "get_settings",
	success: true,
	data: { values: { "retry.enabled": false } },
};

const SERVER_DOWN: IpcTabRunOutcome = { stopReason: "error", errorMessage: "503 Service unavailable" };

/** Longer than `settle`: the retry's chain asks the tab's settings, waits for the sidecar, then sends. */
const settleLong = async () => {
	for (let i = 0; i < 60; i++) await Promise.resolve();
};

describe("TurnResume scheduled retry", () => {
	let h: Harness;
	afterEach(() => rmSync(h.dir, { recursive: true, force: true }));

	/** A launched resume whose tab already ended its turn in `outcome` (transient by default). */
	async function failed(
		options: Parameters<typeof setup>[0] = {},
		outcome: IpcTabRunOutcome = { ...SERVER_DOWN },
		patch: Partial<ResumeFact> = {},
	): Promise<IpcTabRunOutcome> {
		h = setup({ answers: { get_settings: SETTINGS_ON, retry: RETRIED }, ...options });
		h.resume.launch();
		h.facts.push(fact({ running: true, ...patch }));
		h.resume.sync();
		h.facts[0] = fact({ lastRun: outcome, ...patch });
		h.resume.sync();
		await settleLong();
		return outcome;
	}

	/** The tab's own retry ran and ended (`outcome`): agent_start, then the end. */
	async function retryEnded(outcome: IpcTabRunOutcome): Promise<void> {
		h.facts[0] = fact({ running: true });
		h.resume.sync();
		h.facts[0] = fact({ lastRun: outcome });
		h.resume.sync();
		await settleLong();
	}

	const retrySent = () => h.commands.filter(command => command.type === "retry").length;

	it("schedules the first retry 30 s after a transient failure and shows it with its attempt number", async () => {
		await failed();
		expect(h.timers.map(timer => timer.ms)).toEqual([30_000]);
		expect(h.retries).toEqual([{ at: 31_000, attempt: 1 }]);
		expect(h.commands.map(command => command.type)).toEqual(["get_settings"]);
		expect(h.commands[0]).toMatchObject({ paths: ["retry.enabled"] });
	});

	it("also retries a dropped connection while online (stock gave up on it)", async () => {
		await failed(
			{},
			{ stopReason: "error", errorMessage: "fetch failed: getaddrinfo ENOTFOUND api.fixture.invalid" },
		);
		expect(h.timers).toHaveLength(1);
	});

	it.each([
		"401 invalid x-api-key",
		"403 Forbidden",
		"429 usage limit reached for this account",
		"Rate limit exceeded",
		"400 Bad Request",
		"prompt is too long: 215000 tokens > 200000 maximum",
		"context length exceeded",
		"unable to verify the first certificate",
		"Something odd happened",
	])("does not schedule after %s", async message => {
		await failed({}, { stopReason: "error", errorMessage: message });
		expect(h.timers).toEqual([]);
		expect(h.retries).toEqual([]);
		expect(h.commands).toEqual([]);
	});

	it("does not schedule after a turn that was aborted or succeeded", async () => {
		await failed({}, { stopReason: "aborted", errorMessage: "503 Service unavailable" });
		expect(h.timers).toEqual([]);
		rmSync(h.dir, { recursive: true, force: true });
		await failed({}, { stopReason: "stop", reply: "done" });
		expect(h.timers).toEqual([]);
	});

	it("leaves a network failure the connection wait holds to that wait (no second schedule)", async () => {
		await failed({ online: false }, { stopReason: "error", errorMessage: "fetch failed: ENOTFOUND" });
		expect(h.awaiting).toEqual([["t1", true]]);
		expect(h.timers).toEqual([]);
		expect(h.retries).toEqual([]);
	});

	it.each([
		["the tab is a paired device's hosted tab", { options: {}, patch: { peer: "device-x" } }],
		["the tab has no session file", { options: {}, patch: { sessionFile: undefined } }],
		["the user pressed Stop", { options: {}, patch: { stopped: true } }],
	])("does not schedule when %s", async (_name, { options, patch }) => {
		await failed(options, { ...SERVER_DOWN }, patch);
		expect(h.timers).toEqual([]);
		expect(retrySent()).toBe(0);
	});

	it.each([
		["stock's own retry setting is off", SETTINGS_OFF],
		["it cannot be read", { type: "response", command: "get_settings", success: false, error: "bridge down" }],
		[
			"it is missing from the answer",
			{ type: "response", command: "get_settings", success: true, data: { values: {} } },
		],
	] as const)("does not schedule when %s", async (_name, answer) => {
		await failed({ answers: { get_settings: answer as RpcResponse, retry: RETRIED } });
		expect(h.timers).toEqual([]);
		expect(h.retries).toEqual([]);
	});

	it("sends stock retry when the timer fires, waits 2 min, then 10 min, and keeps trying every 10 min after the third attempt", async () => {
		await failed();
		h.timers[0]?.run();
		await settleLong();
		expect(retrySent()).toBe(1);
		expect(h.retries.at(-1)).toBeUndefined();

		await retryEnded({ ...SERVER_DOWN });
		expect(h.timers.map(timer => timer.ms)).toEqual([30_000, 120_000]);
		expect(h.retries.at(-1)).toEqual({ at: 121_000, attempt: 2 });

		h.timers[1]?.run();
		await settleLong();
		await retryEnded({ ...SERVER_DOWN });
		expect(retrySent()).toBe(2);
		expect(h.timers.map(timer => timer.ms)).toEqual([30_000, 120_000, 600_000]);
		expect(h.retries.at(-1)).toEqual({ at: 601_000, attempt: 3 });

		// Past the third attempt the red card never stands: the same 10 minutes again, the attempt number counting on.
		for (const index of [2, 3, 4, 5]) {
			h.timers[index]?.run();
			await settleLong();
			await retryEnded({ ...SERVER_DOWN });
			expect(h.timers.map(timer => timer.ms).at(-1)).toBe(600_000);
			expect(h.retries.at(-1)).toEqual({ at: 601_000, attempt: index + 2 });
		}
		expect(retrySent()).toBe(6);
		expect(h.timers).toHaveLength(7);
	});

	it("a failure that is not transient any more ends a long chain at once: today's behaviour, no schedule", async () => {
		await failed();
		for (const index of [0, 1, 2, 3]) {
			h.timers[index]?.run();
			await settleLong();
			await retryEnded({ ...SERVER_DOWN });
		}
		expect(h.timers).toHaveLength(5);
		h.timers[4]?.run();
		await settleLong();
		await retryEnded({ stopReason: "error", errorMessage: "401 invalid x-api-key" });
		expect(h.timers).toHaveLength(5);
		expect(h.retries.at(-1)).toBeUndefined();
	});

	it("starts over when the user runs something new after many attempts, and when a retry ends otherwise", async () => {
		await failed();
		for (const index of [0, 1, 2]) {
			h.timers[index]?.run();
			await settleLong();
			await retryEnded({ ...SERVER_DOWN });
		}
		expect(h.timers).toHaveLength(4);
		expect(h.timers.map(timer => timer.ms).at(-1)).toBe(600_000);
		// A prompt of the user's: a new chain, 30 s again.
		h.facts[0] = fact({ running: true });
		h.resume.sync();
		h.facts[0] = fact({ lastRun: { ...SERVER_DOWN } });
		h.resume.sync();
		await settleLong();
		expect(h.timers.map(timer => timer.ms).at(-1)).toBe(30_000);
		expect(h.timers).toHaveLength(5);

		// A retry that succeeds resets the count too.
		h.timers[4]?.run();
		await settleLong();
		await retryEnded({ stopReason: "stop", reply: "ok" });
		h.facts[0] = fact({ running: true });
		h.resume.sync();
		h.facts[0] = fact({ lastRun: { ...SERVER_DOWN } });
		h.resume.sync();
		await settleLong();
		expect(h.timers.map(timer => timer.ms).at(-1)).toBe(30_000);
	});

	it("a retry that ends in a non-transient error ends the chain without a new schedule", async () => {
		await failed();
		h.timers[0]?.run();
		await settleLong();
		await retryEnded({ stopReason: "error", errorMessage: "401 invalid x-api-key" });
		expect(h.timers).toHaveLength(1);
		expect(h.retries.at(-1)).toBeUndefined();
	});

	it.each([
		[
			"the user sends a new prompt (or Retry now)",
			() => {
				h.facts[0] = fact({ running: true });
			},
		],
		[
			"the user presses Stop",
			() => {
				h.pool.noteStopped("t1");
			},
		],
		[
			"the user presses Cancel",
			() => {
				h.resume.cancelWait("t1");
			},
		],
		[
			"the tab switches session",
			() => {
				h.facts[0] = { ...(h.facts[0] as ResumeFact), sessionFile: "/s/b.jsonl" };
			},
		],
		[
			"the user edits the session (touched)",
			() => {
				h.facts[0] = { ...(h.facts[0] as ResumeFact), touched: 1 };
			},
		],
		[
			"the tab closes",
			() => {
				h.facts.length = 0;
			},
		],
	])("calls the retry off when %s", async (_name, act) => {
		await failed();
		expect(h.timers).toHaveLength(1);
		act();
		h.resume.sync();
		await settleLong();
		expect(h.timers[0]?.cancelled).toBe(true);
		expect(h.retries.at(-1)).toBeUndefined();
		// Even a timer that fires anyway sends nothing.
		h.timers[0]?.run();
		await settleLong();
		expect(retrySent()).toBe(0);
	});

	it("sends nothing once a quit is underway", async () => {
		await failed();
		h.state.frozen = true;
		h.timers[0]?.run();
		await settleLong();
		expect(retrySent()).toBe(0);
	});

	it("sends nothing when stock's retry setting was switched off while it waited", async () => {
		await failed();
		// The sidecar's scripted answer changes: the fire re-asks.
		const commands = h.commands;
		commands.length = 0;
		const ask = vi.spyOn(h.pool, "startTab").mockReturnValue({
			status: "ready",
			rpcClient: {
				command: async (cmd: RpcCommand) => {
					commands.push(cmd);
					return cmd.type === "get_settings" ? SETTINGS_OFF : RETRIED;
				},
			},
		} as unknown as SidecarLike);
		h.timers[0]?.run();
		await settleLong();
		ask.mockRestore();
		expect(retrySent()).toBe(0);
		expect(h.retries.at(-1)).toBeUndefined();
	});

	it("hands the attempt to the connection wait when the network is gone as the timer fires", async () => {
		await failed();
		h.net.online = false;
		h.timers[0]?.run();
		await settleLong();
		expect(h.awaiting).toEqual([["t1", true]]);
		expect(retrySent()).toBe(0);
		h.net.online = true;
		h.resume.connectivityChanged();
		await settleLong();
		expect(retrySent()).toBe(1);
		expect(h.awaiting.at(-1)).toEqual(["t1", false]);
	});

	it("sends nothing and forgets the chain when stock has nothing to retry", async () => {
		await failed({ answers: { get_settings: SETTINGS_ON, retry: { ...RETRIED, data: { retried: false } } } });
		h.timers[0]?.run();
		await settleLong();
		expect(retrySent()).toBe(1);
		expect(h.retries.at(-1)).toBeUndefined();
		// The next failure begins a new chain at 30 s, not at the second step.
		h.facts[0] = fact({ running: true });
		h.resume.sync();
		h.facts[0] = fact({ lastRun: { ...SERVER_DOWN } });
		h.resume.sync();
		await settleLong();
		expect(h.timers.map(timer => timer.ms).at(-1)).toBe(30_000);
	});

	it("does not touch the marker file: a scheduled retry is not an interrupted turn", async () => {
		await failed();
		expect(h.store.read()).toEqual([]);
	});
});

/** The connection wait's rules formal/turn-resume checks (F1 MarkerNetwork, F4 NoRetryAfterSessionChangeWhileHeld). */
describe("TurnResume connection wait (formal/turn-resume)", () => {
	let h: Harness;
	afterEach(() => rmSync(h.dir, { recursive: true, force: true }));

	// F1, MarkerNetwork: the scheduled retry's own hold rewrites the marker file (it runs from a timer, not from sync()).
	it("a scheduled retry that fires while offline hands over to the connection wait, and the marker file says `network` (a crash during the wait still retries)", async () => {
		h = setup({ answers: { get_settings: SETTINGS_ON, retry: RETRIED } });
		h.resume.launch();
		h.facts.push(fact({ running: true }));
		h.resume.sync();
		h.facts[0] = fact({ lastRun: { ...SERVER_DOWN } });
		h.resume.sync();
		await settleLong();
		expect(h.timers.map(timer => timer.ms)).toEqual([30_000]);
		// The connection drops before the 30 s timer fires.
		h.net.online = false;
		h.timers[0]?.run();
		await settleLong();
		// The wait row shows (the tab is held)...
		expect(h.awaiting.at(-1)).toEqual(["t1", true]);
		// ...so a relaunch now must still retry it: the marker file has to say `network` while the wait holds.
		expect(h.store.read().map(entry => entry.reason)).toEqual(["network"]);
	});

	// F4: a session or branch change calls the held wait off, as it does a probe and a scheduled retry.
	it.each<[string, Partial<ResumeFact>]>([
		["a branch or session command (`touched`)", { touched: 1 }],
		["another session file under the tab", { sessionFile: "/s/other.jsonl" }],
	])(
		"%s while the connection wait holds ends the wait, and nothing retries into the new session once online",
		async (_name, patch) => {
			h = setup({ online: false, answers: { retry: RETRIED } });
			h.resume.launch();
			h.facts.push(
				fact({
					running: false,
					lastRun: { stopReason: "error", errorMessage: "fetch failed: getaddrinfo ENOTFOUND api.example.com" },
				}),
			);
			h.resume.sync();
			expect(h.awaiting.at(-1)).toEqual(["t1", true]);
			h.facts[0] = { ...(h.facts[0] as ResumeFact), ...patch };
			h.resume.sync();
			h.net.online = true;
			h.resume.connectivityChanged();
			await settle();
			expect(h.awaiting.at(-1)).toEqual(["t1", false]);
			expect(h.store.read()).toEqual([]);
			expect(h.commands.map(command => command.type)).not.toContain("retry");
		},
	);

	it("keeps the wait when stock writes the session's first file after the hold: it is the same conversation", async () => {
		h = setup({ online: false, answers: { retry: RETRIED } });
		h.resume.launch();
		h.facts.push(
			fact({
				running: false,
				sessionFile: undefined,
				lastRun: { stopReason: "error", errorMessage: "fetch failed: getaddrinfo ENOTFOUND api.example.com" },
			}),
		);
		h.resume.sync();
		h.facts[0] = { ...(h.facts[0] as ResumeFact), sessionFile: "/s/a.jsonl" };
		h.resume.sync();
		expect(h.store.read().map(entry => entry.reason)).toEqual(["network"]);
		h.net.online = true;
		h.resume.connectivityChanged();
		await settle();
		expect(h.commands.map(command => command.type)).toContain("retry");
	});

	// The relaunch's wait (`launch()` while offline) follows the same rule as a failed turn's.
	it.each<[string, Partial<ResumeMarker>, Partial<ResumeFact>]>([
		[
			"a `network` marker's retry, then a branch or session command (`touched`)",
			{ reason: "network" },
			{ touched: 1 },
		],
		["a cut-off turn's restore, then another session file under the tab", {}, { sessionFile: "/s/other.jsonl" }],
	])(
		"a relaunch held offline for %s ends the wait: nothing continues into the new session",
		async (_name, saved, patch) => {
			h = setup({ online: false, answers: { restore_interrupted: RESTORED, retry: RETRIED } });
			new InterruptedTurnStore(h.file).write([marker(saved)]);
			h.facts.push(fact({ tabId: "restored", running: false }));
			h.resume.launch();
			await settle();
			expect(h.awaiting).toEqual([["restored", true]]);
			h.facts[0] = { ...(h.facts[0] as ResumeFact), ...patch };
			h.resume.sync();
			h.net.online = true;
			h.resume.connectivityChanged();
			await settle();
			expect(h.awaiting.at(-1)).toEqual(["restored", false]);
			expect(h.store.read()).toEqual([]);
			expect(h.commands).toEqual([]);
		},
	);

	// Review M1: a paired device's switch_session or new_session on an idle held tab moves its file with no sync() at
	// all (no `touched`, no run-state change), so the continuation itself has to look again before it sends.
	it("a session change no sync() saw still ends the wait when the connection comes back: nothing retries into it", async () => {
		h = setup({ online: false, answers: { retry: RETRIED } });
		h.resume.launch();
		h.facts.push(
			fact({
				running: false,
				lastRun: { stopReason: "error", errorMessage: "fetch failed: getaddrinfo ENOTFOUND api.example.com" },
			}),
		);
		h.resume.sync();
		h.facts[0] = { ...(h.facts[0] as ResumeFact), sessionFile: "/s/other.jsonl" };
		h.net.online = true;
		h.resume.connectivityChanged();
		await settle();
		expect(h.commands.map(command => command.type)).not.toContain("retry");
		expect(h.awaiting.at(-1)).toEqual(["t1", false]);
	});

	// Review minor 2: flush() already let the wait go and the tab's omp is still coming up when the session changes.
	it("a session change while the flushed wait's omp still starts ends it once the omp is up: nothing retries into it", async () => {
		h = setup({ online: false, status: "starting", answers: { retry: RETRIED } });
		h.resume.launch();
		h.facts.push(
			fact({
				running: false,
				lastRun: { stopReason: "error", errorMessage: "fetch failed: getaddrinfo ENOTFOUND api.example.com" },
			}),
		);
		h.resume.sync();
		h.net.online = true;
		h.resume.connectivityChanged();
		await settle();
		h.facts[0] = { ...(h.facts[0] as ResumeFact), touched: 1 };
		h.resume.sync();
		h.setStatus("ready");
		await settle();
		expect(h.commands.map(command => command.type)).not.toContain("retry");
		expect(h.logs.at(-1)).toEqual(["continue", { tab: "t1", action: "retry", ready: true, cancelled: true }]);
	});

	// Review M2: "Branch from here" writes a new session for another window; the tab it was sent to stays on its own.
	it("Branch from here (fork_from) leaves the tab where it is: it is no session change", () => {
		expect(TOUCH_COMMANDS.fork_from).toBeUndefined();
		const forked: RpcResponse = {
			type: "response",
			command: "fork_from",
			success: true,
			data: { sessionPath: "/s/b.jsonl" },
		};
		expect(movesTab("fork_from", forked)).toBe(false);
	});

	// Review minor 1: `touched` counts only a change that happened.
	it.each<[string, RpcResponse, boolean]>([
		["a switch that worked", { type: "response", command: "switch_session", success: true, data: {} }, true],
		[
			"a cancelled new session",
			{ type: "response", command: "new_session", success: true, data: { cancelled: true } },
			false,
		],
		[
			"a failed switch",
			{ type: "response", command: "switch_session", success: false, error: "no such file" },
			false,
		],
	])("tells whether %s moved the tab", (_name, response, moved) => {
		expect(movesTab(response.command, response)).toBe(moved);
	});

	// The same gap for a scheduled retry: its timer fired and its omp is still coming up when the tab moves.
	it("a session change while a fired scheduled retry's omp still starts ends it once the omp is up: nothing retries into it", async () => {
		h = setup({ status: "starting", answers: { get_settings: SETTINGS_ON, retry: RETRIED } });
		h.resume.launch();
		h.facts.push(fact({ running: true }));
		h.resume.sync();
		h.facts[0] = fact({ lastRun: { ...SERVER_DOWN } });
		h.resume.sync();
		await settleLong();
		h.timers[0]?.run();
		await settleLong();
		h.facts[0] = { ...(h.facts[0] as ResumeFact), touched: 1 };
		h.resume.sync();
		h.setStatus("ready");
		await settleLong();
		expect(h.commands.map(command => command.type)).not.toContain("retry");
	});
});

/** Races a review found after v0.82.0 (a launch wait that ends unheard, a continuation that outlives a move). */
describe("TurnResume races (review of v0.82.0)", () => {
	let h: Harness;
	afterEach(() => rmSync(h.dir, { recursive: true, force: true }));

	const restoreAnswer = (data: Record<string, unknown>): RpcResponse => ({
		type: "response",
		command: "restore_interrupted",
		success: true,
		data,
	});
	/** A restore that answers when the test says so (the real one takes up to `RESUME_COMMAND_TIMEOUT_MS`). */
	const slowRestore = () => {
		const answer = Promise.withResolvers<RpcResponse>();
		return {
			answer: () => answer.promise,
			release: (data: Record<string, unknown>) => answer.resolve(restoreAnswer(data)),
		};
	};
	const sent = () => h.commands.map(command => command.type);
	const move = (patch: Partial<ResumeFact> = { touched: 1 }) => {
		h.facts[0] = { ...(h.facts[0] as ResumeFact), ...patch };
		h.resume.sync();
	};

	// Finding 1: Autopilot's `#onReady` put the tab in `#awaitingResume` and waits for the launch continuation's end.
	describe("a launch continuation held offline that is called off", () => {
		it.each<[string, () => void | Promise<void>]>([
			["the waiting row's Cancel", () => h.resume.cancelWait("restored")],
			["the resuming row's Stop", () => h.resume.stopResumed("restored")],
			["a new prompt on the held tab", () => move({ running: true })],
			["another session file under the tab", () => move({ sessionFile: "/s/other.jsonl" })],
			["a branch or session command (`touched`)", () => move({ touched: 1 })],
		])("%s tells Autopilot `cancelled` once, and nothing continues once online", async (_name, callOff) => {
			h = setup({ online: false, answers: { restore_interrupted: RESTORED, retry: RETRIED } });
			new InterruptedTurnStore(h.file).write([marker()]);
			h.facts.push(fact({ tabId: "restored", running: false }));
			h.resume.launch();
			await settle();
			expect(h.goals).toEqual([]);

			await callOff();
			expect(h.goals).toEqual([["restored", "cancelled"]]);

			h.net.online = true;
			h.resume.connectivityChanged();
			await settle();
			expect(h.goals).toEqual([["restored", "cancelled"]]);
			expect(sent()).not.toContain("restore_interrupted");
			expect(sent()).not.toContain("retry");
		});

		it("says nothing for a failed turn's connection wait (no launch marker, no goal waits on it)", async () => {
			h = setup({ online: false, answers: { retry: RETRIED } });
			h.resume.launch();
			h.facts.push(
				fact({
					running: false,
					lastRun: { stopReason: "error", errorMessage: "fetch failed: getaddrinfo ENOTFOUND api.example.com" },
				}),
			);
			h.resume.sync();
			expect(h.awaiting.at(-1)).toEqual(["t1", true]);
			h.resume.cancelWait("t1");
			expect(h.goals).toEqual([]);
		});
	});

	// Finding 2: `restore_interrupted` takes up to two minutes, and the tab can move meanwhile (the user, a paired device).
	describe("a launch continuation whose tab moves while its commands run", () => {
		it("does not send stock retry into the other session after a slow restore, and ends `cancelled`", async () => {
			const restore = slowRestore();
			h = setup({ answers: { restore_interrupted: restore.answer, retry: RETRIED } });
			new InterruptedTurnStore(h.file).write([marker()]);
			h.facts.push(fact({ tabId: "restored", running: false }));
			h.resume.launch();
			await settle();
			expect(sent()).toEqual(["restore_interrupted"]);

			move({ touched: 1 });
			restore.release({});
			await settle();

			expect(sent()).toEqual(["restore_interrupted"]);
			expect(h.goals).toEqual([["restored", "cancelled"]]);
			expect(h.logs.at(-1)).toEqual([
				"continue",
				expect.objectContaining({ tab: "restored", started: false, cancelled: true }),
			]);
			expect(h.store.read()).toEqual([]);
		});

		it("does not send the unwritten first prompt into the other session", async () => {
			const restore = slowRestore();
			h = setup({ answers: { restore_interrupted: restore.answer } });
			new InterruptedTurnStore(h.file).write([
				marker({ sessionPath: join(h.dir, "never-written.jsonl"), prompt: "list the fruits" }),
			]);
			h.facts.push(fact({ tabId: "restored", sessionFile: undefined }));
			h.resume.launch();
			await settle();

			move({ touched: 1 });
			restore.release({});
			await settle();

			expect(sent()).not.toContain("prompt");
			expect(h.goals).toEqual([["restored", "cancelled"]]);
		});

		it("does not resume the goal in the other session after the restore", async () => {
			const restore = slowRestore();
			const resumed: string[] = [];
			h = setup({
				answers: { restore_interrupted: restore.answer },
				resumeGoal: async tabId => {
					resumed.push(tabId);
				},
			});
			new InterruptedTurnStore(h.file).write([marker()]);
			h.facts.push(fact({ tabId: "restored", running: false }));
			h.resume.launch();
			await settle();

			move({ sessionFile: "/s/other.jsonl" });
			restore.release({ turn: true, goalPausedByExit: true });
			await settle();

			expect(resumed).toEqual([]);
			expect(h.goals).toEqual([["restored", "cancelled"]]);
		});

		it("an online launch holds for the session it found: a move while the omp starts ends it before any command", async () => {
			h = setup({ status: "starting", answers: { restore_interrupted: RESTORED } });
			new InterruptedTurnStore(h.file).write([marker()]);
			h.facts.push(fact({ tabId: "restored", running: false }));
			h.resume.launch();
			await settle();
			move({ touched: 1 });
			h.setStatus("ready");
			await settle();
			expect(h.commands).toEqual([]);
			expect(h.goals).toEqual([["restored", "cancelled"]]);
		});

		it("still restores and retries when the tab stays where it was", async () => {
			const restore = slowRestore();
			h = setup({ answers: { restore_interrupted: restore.answer, retry: RETRIED } });
			new InterruptedTurnStore(h.file).write([marker()]);
			h.facts.push(fact({ tabId: "restored", running: false }));
			h.resume.launch();
			await settle();
			restore.release({});
			await settle();
			expect(sent()).toEqual(["restore_interrupted", "retry"]);
			expect(h.goals).toEqual([["restored", "none"]]);
		});
	});

	// Finding 3: `touched` counts a move after its reply, so a retry could run between the move's send and its reply.
	describe("a move whose command is still on its way", () => {
		const armedRetry = async () => {
			h = setup({ answers: { get_settings: SETTINGS_ON, retry: RETRIED } });
			h.resume.launch();
			h.facts.push(fact({ running: true }));
			h.resume.sync();
			h.facts[0] = fact({ lastRun: { ...SERVER_DOWN } });
			h.resume.sync();
			await settleLong();
			expect(h.timers.map(timer => timer.ms)).toEqual([30_000]);
		};

		it("holds a scheduled retry that fires meanwhile until the answer says whether the tab moved: it moved, no retry", async () => {
			await armedRetry();
			const answered = h.moves.begin("t1");
			h.timers[0]?.run();
			await settleLong();
			expect(sent()).not.toContain("retry");

			// The pool counts the move, then marks its command done (`trackMove`).
			move({ touched: 1 });
			answered();
			await settleLong();
			expect(sent()).not.toContain("retry");
			expect(h.retries.at(-1)).toBeUndefined();
		});

		it("holds it the same way, and retries once the answer shows the move was cancelled", async () => {
			await armedRetry();
			const answered = h.moves.begin("t1");
			h.timers[0]?.run();
			await settleLong();
			expect(sent()).not.toContain("retry");

			answered();
			await settleLong();
			expect(sent()).toContain("retry");
		});

		it("holds a connection wait's flush until the answer: the tab moved, nothing retries into the new session", async () => {
			h = setup({ online: false, answers: { retry: RETRIED } });
			h.resume.launch();
			h.facts.push(
				fact({
					running: false,
					lastRun: { stopReason: "error", errorMessage: "fetch failed: getaddrinfo ENOTFOUND api.example.com" },
				}),
			);
			h.resume.sync();
			const answered = h.moves.begin("t1");
			h.net.online = true;
			h.resume.connectivityChanged();
			await settle();
			expect(sent()).not.toContain("retry");

			move({ touched: 1 });
			answered();
			await settle();
			expect(sent()).not.toContain("retry");
			expect(h.awaiting.at(-1)).toEqual(["t1", false]);
		});
	});

	// A11 (left unchecked in v0.82.1): the person's prompt while a continuation waits for a move's answer or its restore
	// runs looks, to `#judge`, like the continuation's own run; stock `retry` could land in the person's run.
	describe("a person's prompt while a continuation is on its way", () => {
		const prompt = () => move({ prompted: 1, running: true });

		it("drops a launch continuation whose restore is running: no stock retry into the person's run, goal `cancelled`", async () => {
			const restore = slowRestore();
			h = setup({ answers: { restore_interrupted: restore.answer, retry: RETRIED } });
			new InterruptedTurnStore(h.file).write([marker()]);
			h.facts.push(fact({ tabId: "restored", running: false }));
			h.resume.launch();
			await settle();
			expect(sent()).toEqual(["restore_interrupted"]);

			prompt();
			restore.release({});
			await settle();

			expect(sent()).toEqual(["restore_interrupted"]);
			expect(h.goals).toEqual([["restored", "cancelled"]]);
			expect(h.logs.at(-1)).toEqual([
				"continue",
				expect.objectContaining({ tab: "restored", started: false, cancelled: true }),
			]);
			// The marker is the person's own run's now, not the continuation's.
			expect(h.store.read()).toEqual([expect.objectContaining({ tab: "restored", reason: "running" })]);
		});

		it("does not send the unwritten first prompt or resume the goal after the person's prompt", async () => {
			const restore = slowRestore();
			const resumed: string[] = [];
			h = setup({
				answers: { restore_interrupted: restore.answer },
				resumeGoal: async tabId => {
					resumed.push(tabId);
				},
			});
			new InterruptedTurnStore(h.file).write([
				marker({ sessionPath: join(h.dir, "never-written.jsonl"), prompt: "list the fruits" }),
			]);
			h.facts.push(fact({ tabId: "restored", sessionFile: undefined }));
			h.resume.launch();
			await settle();

			prompt();
			restore.release({ goalPausedByExit: true });
			await settle();

			expect(sent()).toEqual(["restore_interrupted"]);
			expect(resumed).toEqual([]);
			expect(h.goals).toEqual([["restored", "cancelled"]]);
		});

		it("drops a connection wait's flush that waits for a move's answer: nothing retries into the person's run", async () => {
			h = setup({ online: false, answers: { retry: RETRIED } });
			h.resume.launch();
			h.facts.push(
				fact({
					running: false,
					lastRun: { stopReason: "error", errorMessage: "fetch failed: getaddrinfo ENOTFOUND api.example.com" },
				}),
			);
			h.resume.sync();
			const answered = h.moves.begin("t1");
			h.net.online = true;
			h.resume.connectivityChanged();
			await settle();

			// The move was cancelled (no `touched`), but the person typed meanwhile.
			prompt();
			answered();
			await settle();

			expect(sent()).not.toContain("retry");
			expect(h.awaiting.at(-1)).toEqual(["t1", false]);
		});

		it("calls off a scheduled retry that fires while a move is on its way and the person prompted", async () => {
			h = setup({ answers: { get_settings: SETTINGS_ON, retry: RETRIED } });
			h.resume.launch();
			h.facts.push(fact({ running: true }));
			h.resume.sync();
			h.facts[0] = fact({ lastRun: { ...SERVER_DOWN } });
			h.resume.sync();
			await settleLong();
			const answered = h.moves.begin("t1");
			h.timers[0]?.run();
			await settleLong();

			prompt();
			answered();
			await settleLong();

			expect(sent()).not.toContain("retry");
		});

		it("ends only the continuation: the person's own run that failed offline keeps its connection wait and is retried once online", async () => {
			const restore = slowRestore();
			h = setup({ answers: { restore_interrupted: restore.answer, retry: RETRIED } });
			new InterruptedTurnStore(h.file).write([marker()]);
			h.facts.push(fact({ tabId: "restored", running: false }));
			h.resume.launch();
			await settle();
			expect(sent()).toEqual(["restore_interrupted"]);

			// The person prompts while the restore runs; their turn fails on the network, which is down.
			h.net.online = false;
			prompt();
			move({
				running: false,
				lastRun: { stopReason: "error", errorMessage: "fetch failed: getaddrinfo ENOTFOUND api.example.com" },
			});
			expect(h.awaiting.at(-1)).toEqual(["restored", true]);

			restore.release({});
			await settle();
			expect(sent()).toEqual(["restore_interrupted"]);
			expect(h.goals).toEqual([["restored", "cancelled"]]);
			expect(h.awaiting.at(-1)).toEqual(["restored", true]);

			h.net.online = true;
			h.resume.connectivityChanged();
			await settle();
			expect(sent()).toEqual(["restore_interrupted", "retry"]);
			// Autopilot heard the launch continuation once; the retry of the person's run is its own continuation.
			expect(h.goals).toEqual([
				["restored", "cancelled"],
				["restored", "none"],
			]);
		});

		it("still continues when the person prompted before the continuation started", async () => {
			h = setup({ answers: { restore_interrupted: RESTORED, retry: RETRIED } });
			new InterruptedTurnStore(h.file).write([marker()]);
			h.facts.push(fact({ tabId: "restored", running: false, prompted: 3 }));
			h.resume.launch();
			await settle();
			expect(sent()).toEqual(["restore_interrupted"]);
			expect(h.goals).toEqual([["restored", "none"]]);
		});
	});

	describe("personsPrompt", () => {
		it("is the person's own prompt, steer or follow-up, never an agent's wrapped message or another command", () => {
			expect(personsPrompt({ type: "prompt", message: "hello" })).toBe(true);
			expect(personsPrompt({ type: "steer", message: "hello" })).toBe(true);
			expect(personsPrompt({ type: "follow_up", message: "hello" })).toBe(true);
			expect(personsPrompt({ type: "prompt", message: wrapAgentMessage("do it", "an agent") })).toBe(false);
			expect(personsPrompt({ type: "get_state" })).toBe(false);
			expect(personsPrompt({ type: "bash", message: "ls" })).toBe(false);
		});
	});

	describe("trackMove", () => {
		const ok = (command: string, data: unknown = {}): RpcResponse => ({
			type: "response",
			command,
			success: true,
			data,
		});
		const tracked = () => {
			const moves = new MovesInFlight();
			const order: string[] = [];
			const tracker = {
				begin: () => {
					order.push("begin");
					const end = moves.begin("t");
					return () => {
						order.push("end");
						end();
					};
				},
				moved: () => order.push("moved"),
			};
			return { moves, order, tracker };
		};

		it("marks a move in flight until it answered and `touched` counted it", async () => {
			const { moves, order, tracker } = tracked();
			const answer = Promise.withResolvers<RpcResponse>();
			let quiet = false;
			const run = trackMove("switch_leaf", tracker, () => answer.promise);
			void moves.settled("t").then(() => {
				quiet = true;
			});
			await settle();
			expect(quiet).toBe(false);
			answer.resolve(ok("switch_leaf"));
			await run;
			await settle();
			expect(quiet).toBe(true);
			expect(order).toEqual(["begin", "moved", "end"]);
		});

		it.each<[string, RpcResponse]>([
			["a cancelled move", ok("new_session", { cancelled: true })],
			["a failed move", { type: "response", command: "switch_session", success: false, error: "no such file" }],
		])("releases %s without counting it", async (_name, response) => {
			const { order, tracker } = tracked();
			await trackMove(response.command, tracker, async () => response);
			expect(order).toEqual(["begin", "end"]);
		});

		it("counts a move that timed out: omp may have run it (`switch_leaf` with a summary outlives 8 s)", async () => {
			const { order, tracker } = tracked();
			await expect(
				trackMove("switch_leaf", tracker, async () => {
					throw new RpcTimeoutError(8_000, "switch_leaf");
				}),
			).rejects.toThrow("RPC timeout (8000ms): switch_leaf");
			expect(order).toEqual(["begin", "moved", "end"]);
			expect(movesTabUnknown("switch_leaf", new RpcTimeoutError(8_000, "switch_leaf"))).toBe(true);
		});

		it("counts no other failure (an omp that died moved nothing) and no timeout of another command", async () => {
			const { order, tracker } = tracked();
			await expect(
				trackMove("switch_leaf", tracker, async () => {
					throw new Error("sidecar exited");
				}),
			).rejects.toThrow("sidecar exited");
			expect(order).toEqual(["begin", "end"]);
			expect(movesTabUnknown("get_state", new RpcTimeoutError(8_000, "get_state"))).toBe(false);
			expect(movesTabUnknown("fork_from", new RpcTimeoutError(8_000, "fork_from"))).toBe(false);
		});

		it("leaves any other command untouched: nothing in flight", async () => {
			const { order, tracker } = tracked();
			await trackMove("get_state", tracker, async () => ok("get_state"));
			expect(order).toEqual([]);
		});
	});
});

/**
 * A continuation held for the connection has no timer of its own (a held wait and the relaunch's, `#hold`): it waits as
 * long as the computer is really offline, the person sees the wait the whole time (`awaitingConnection` on the tab, which
 * the pane's row, the tab and sidebar signal and a paired device read), and a probe that answers releases it within a
 * minute even when no `online` event ever came (`ConnectivityMonitor`'s re-probe).
 */
describe("a continuation held for the connection", () => {
	let h: Harness;
	afterEach(() => rmSync(h.dir, { recursive: true, force: true }));

	const networkFailure = { stopReason: "error", errorMessage: "fetch failed: getaddrinfo ENOTFOUND api.example.com" };

	/** The real monitor, with its timers and the world's answer in the test's hands; it drives `h`'s connection. */
	function monitored() {
		const world = { reachable: false };
		const timers: Array<{ run: () => void; ms: number; live: boolean }> = [];
		const monitor = new ConnectivityMonitor({
			isOnline: () => true,
			probe: async () => world.reachable,
			now: () => 1_000,
			schedule: (run, ms) => {
				const timer = { run, ms, live: true };
				timers.push(timer);
				return () => {
					timer.live = false;
				};
			},
			changed: online => {
				h.net.online = online;
				h.resume.connectivityChanged();
			},
		});
		/** The oldest timer the monitor still holds fires, and its probe settles. */
		const fireNext = async () => {
			const timer = timers.find(candidate => candidate.live);
			if (!timer) throw new Error("the monitor holds no timer: nothing would ever release the wait");
			timer.live = false;
			timer.run();
			await settle();
		};
		return { world, monitor, timers, fireNext };
	}

	it("a failed turn's wait is shown without a gap for as long as the computer is offline, then released by a probe that answers though no `online` event came", async () => {
		h = setup({ answers: { retry: RETRIED } });
		const { world, monitor, fireNext } = monitored();
		h.resume.launch();
		// A window's `offline` event, and the tab's turn fails on the network.
		monitor.report(false);
		h.facts.push(fact({ running: false, lastRun: { ...networkFailure } }));
		h.resume.sync();
		expect(h.awaiting).toEqual([["t1", true]]);
		expect(h.facts[0]?.awaitingConnection).toBe(true);
		expect(h.store.read().map(entry => entry.reason)).toEqual(["network"]);

		// Hours offline: the wait is still shown every time anything looks, never cleared, nothing sent.
		for (let i = 0; i < 480; i++) {
			await fireNext();
			h.resume.sync();
			expect(h.facts[0]?.awaitingConnection).toBe(true);
		}
		expect(h.awaiting).toEqual([["t1", true]]);
		expect(h.commands).toEqual([]);
		expect(h.store.read().map(entry => entry.reason)).toEqual(["network"]);

		// The network comes back and no event says so: the next probe releases the continuation.
		world.reachable = true;
		await fireNext();
		expect(monitor.online).toBe(true);
		expect(h.commands.map(cmd => cmd.type)).toEqual(["retry"]);
		expect(h.awaiting.at(-1)).toEqual(["t1", false]);
	});

	it("the relaunch's own wait is held the same way and released by the same probe", async () => {
		h = setup({ answers: { restore_interrupted: RESTORED } });
		const { world, monitor, fireNext } = monitored();
		monitor.report(false);
		new InterruptedTurnStore(h.file).write([marker()]);
		h.facts.push(fact({ tabId: "restored", running: false }));
		h.resume.launch();
		await settle();
		expect(h.awaiting).toEqual([["restored", true]]);
		for (let i = 0; i < 120; i++) await fireNext();
		expect(h.facts[0]?.awaitingConnection).toBe(true);
		expect(h.commands).toEqual([]);
		expect(h.store.read().map(entry => entry.reason)).toEqual(["running"]);

		world.reachable = true;
		await fireNext();
		expect(h.commands.map(cmd => cmd.type)).toEqual(["restore_interrupted"]);
		expect(h.awaiting.at(-1)).toEqual(["restored", false]);
	});

	it("a sleep whose wake event never came releases it too", async () => {
		h = setup({ answers: { retry: RETRIED } });
		const { world, monitor, fireNext } = monitored();
		h.resume.launch();
		monitor.suspend();
		h.facts.push(fact({ running: false, lastRun: { ...networkFailure } }));
		h.resume.sync();
		expect(h.awaiting).toEqual([["t1", true]]);
		// The wake's probe loop never started (no `resume` event); the network answers and the re-probe finds it.
		world.reachable = true;
		await fireNext();
		expect(h.commands.map(cmd => cmd.type)).toEqual(["retry"]);
	});
});
