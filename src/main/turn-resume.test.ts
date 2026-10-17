import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcScheduledRetry, IpcTabRunOutcome } from "../shared/ipc-types";
import type { RpcCommand, RpcResponse } from "../shared/rpc-types";
import type { SidecarLike } from "./sidecar-types";
import {
	continuingCount,
	deriveMarkers,
	InterruptedTurnStore,
	isNetworkError,
	isTransientError,
	launchAction,
	RESUME_READY_TIMEOUT_MS,
	type ResumeFact,
	type ResumeMarker,
	type ResumePool,
	retryDelays,
	SCHEDULED_RETRY_DELAYS_MS,
	TOUCH_COMMANDS,
	TurnResume,
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

	it("does not count a reopened card as a continuing task", () => {
		expect(continuingCount([marker(), marker({ reason: "network" }), marker({ reason: "asking" })])).toBe(2);
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
});

/** A tab's sidecar: records the commands main sends and answers them as scripted; `setStatus` moves it like a spawn. */
function fakeSidecar(answers: Partial<Record<string, RpcResponse>> = {}, status = "ready") {
	const commands: RpcCommand[] = [];
	const events = new EventEmitter();
	const sidecar = Object.assign(events, {
		status,
		rpcClient: {
			command: async (cmd: RpcCommand): Promise<RpcResponse> => {
				commands.push(cmd);
				return answers[cmd.type] ?? { type: "response", command: cmd.type, success: true, data: {} };
			},
		},
	});
	const setStatus = (next: string) => {
		sidecar.status = next;
		sidecar.emit("status", { status: next });
	};
	return {
		sidecar: sidecar as unknown as SidecarLike,
		commands,
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
	net: { online: boolean; wake: boolean };
	state: { enabled: boolean; frozen: boolean; notices: number[]; opened: ResumeMarker[] };
	resume: TurnResume;
	pool: ResumePool;
	/** Moves the tab's sidecar to another status (a spawn becoming ready, a crash). */
	setStatus: (status: string) => void;
	/** How many `status` listeners the resume left on the sidecar. */
	statusListeners: () => number;
	/** Every `setScheduledRetry` call the resume made, in order (`undefined` = cleared). */
	retries: Array<IpcScheduledRetry | undefined>;
	/** The retry timers it armed; a test fires one the way a clock would. */
	timers: Array<{ run: () => void; ms: number; cancelled: boolean }>;
	/** Settings › Agent behavior › Smart automation › retry. */
	prefs: { scheduledRetry: boolean };
	/** Every `setResuming` call (the calm "continuing" row), in order. */
	resuming: Array<[string, boolean]>;
}

function setup(
	options: {
		enabled?: boolean;
		online?: boolean;
		waitAfterWake?: boolean;
		answers?: Partial<Record<string, RpcResponse>>;
		/** The tab's sidecar status when the resume first looks (default ready). */
		status?: string;
		/** Settings pref for the scheduled retry (default on). */
		scheduledRetry?: boolean;
		/** An injected goal resume (autopilot's); default: the tab's `set_goal` resume. */
		resumeGoal?: (tabId: string) => Promise<void>;
	} = {},
): Harness {
	const dir = mkdtempSync(join(tmpdir(), "ompdesk-resume-"));
	const file = join(dir, "interrupted-turns.json");
	const store = new InterruptedTurnStore(file);
	const facts: ResumeFact[] = [];
	const awaiting: Array<[string, boolean]> = [];
	const retries: Array<IpcScheduledRetry | undefined> = [];
	const timers: Array<{ run: () => void; ms: number; cancelled: boolean }> = [];
	const prefs = { scheduledRetry: options.scheduledRetry ?? true };
	const resuming: Array<[string, boolean]> = [];
	const { sidecar, commands, setStatus, listeners } = fakeSidecar(options.answers, options.status);
	const net = { online: options.online ?? true, wake: options.waitAfterWake ?? false };
	const state = {
		enabled: options.enabled ?? true,
		frozen: false,
		notices: [] as number[],
		opened: [] as ResumeMarker[],
	};
	const pool: ResumePool = {
		resumeFacts: () => facts.map(entry => ({ ...entry })),
		setAwaitingConnection: (tabId, value) => {
			awaiting.push([tabId, value]);
			const entry = facts.find(candidate => candidate.tabId === tabId);
			if (entry) entry.awaitingConnection = value;
		},
		startTab: () => sidecar,
		tabForSession: (sessionPath, peer) =>
			facts.find(entry => entry.sessionFile === sessionPath && entry.peer === peer)?.tabId ?? null,
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
		},
		enabled: () => state.enabled,
		scheduledRetry: {
			enabled: () => prefs.scheduledRetry,
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
		notify: count => state.notices.push(count),
		...(options.resumeGoal ? { resumeGoal: options.resumeGoal } : {}),
	});
	return {
		dir,
		file,
		store,
		facts,
		awaiting,
		commands,
		net,
		state,
		resume,
		pool,
		setStatus,
		statusListeners: listeners,
		retries,
		timers,
		prefs,
		resuming,
	};
}

/** Let the resume's async chain (ready → command → sync) finish. */
const settle = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
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

	it("writes no markers, and clears old ones, when the setting is off", () => {
		h = setup({ enabled: false });
		writeFileSync(h.file, JSON.stringify([marker()]));
		h.resume.launch();
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
		expect(h.state.notices).toEqual([1]);
		// The marker stays until the resumed turn is seen running: a second crash resumes it again.
		expect(h.store.read().map(entry => entry.tab)).toEqual(["restored"]);

		h.facts[0] = fact({ tabId: "restored", running: true });
		h.resume.sync();
		expect(h.store.read()[0]).toMatchObject({ tab: "restored", reason: "running" });
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
		expect(h.state.notices).toEqual([]);
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
		expect(h.state.notices).toEqual([]);
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
		expect(h.state.notices).toEqual([]);
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
		expect(h.state.notices).toEqual([1]);
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

		await h.resume.stopResumed();
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

		await h.resume.stopResumed();
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
		// The scheduled retry (its own describe below) is off here: this is about the connection wait.
		h = setup({ online: true, scheduledRetry: false });
		h.resume.launch();
		h.facts.push(fact({ running: false, lastRun: { stopReason: "error", errorMessage: "fetch failed: ENOTFOUND" } }));
		h.resume.sync();
		await settle();
		expect(h.awaiting).toEqual([]);
		expect(h.commands).toEqual([]);
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
			"fork_from",
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

	it("schedules the first retry 30 s after a transient failure and shows it with attempt and total", async () => {
		await failed();
		expect(h.timers.map(timer => timer.ms)).toEqual([30_000]);
		expect(h.retries).toEqual([{ at: 31_000, attempt: 1, max: 3 }]);
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
		["the pref is off", { options: { scheduledRetry: false }, patch: {} }],
		["the tab is a paired device's hosted tab", { options: {}, patch: { peer: "device-x" } }],
		["the tab has no session file", { options: {}, patch: { sessionFile: undefined } }],
		["the user pressed Stop", { options: {}, patch: { stopped: true } }],
	])("does not schedule when %s", async (_name, { options, patch }) => {
		await failed(options, { ...SERVER_DOWN }, patch);
		expect(h.timers).toEqual([]);
		expect(retrySent()).toBe(0);
	});

	it.each([
		[
			"stock's own retry setting is off",
			{ type: "response", command: "get_settings", success: true, data: { values: { "retry.enabled": false } } },
		],
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

	it("sends stock retry when the timer fires, then waits 2 min and 10 min, and stops after the third attempt", async () => {
		await failed();
		h.timers[0]?.run();
		await settleLong();
		expect(retrySent()).toBe(1);
		expect(h.retries.at(-1)).toBeUndefined();

		await retryEnded({ ...SERVER_DOWN });
		expect(h.timers.map(timer => timer.ms)).toEqual([30_000, 120_000]);
		expect(h.retries.at(-1)).toEqual({ at: 121_000, attempt: 2, max: 3 });

		h.timers[1]?.run();
		await settleLong();
		await retryEnded({ ...SERVER_DOWN });
		expect(retrySent()).toBe(2);
		expect(h.timers.map(timer => timer.ms)).toEqual([30_000, 120_000, 600_000]);
		expect(h.retries.at(-1)).toEqual({ at: 601_000, attempt: 3, max: 3 });

		h.timers[2]?.run();
		await settleLong();
		await retryEnded({ ...SERVER_DOWN });
		expect(retrySent()).toBe(3);
		// Three attempts failed: the red error card stands.
		expect(h.timers).toHaveLength(3);
		expect(h.retries.at(-1)).toBeUndefined();
	});

	it("starts over when the user runs something new after the attempts are spent, and when a retry ends otherwise", async () => {
		await failed();
		for (const index of [0, 1, 2]) {
			h.timers[index]?.run();
			await settleLong();
			await retryEnded({ ...SERVER_DOWN });
		}
		expect(h.timers).toHaveLength(3);
		// A prompt of the user's: a new chain, 30 s again.
		h.facts[0] = fact({ running: true });
		h.resume.sync();
		h.facts[0] = fact({ lastRun: { ...SERVER_DOWN } });
		h.resume.sync();
		await settleLong();
		expect(h.timers.map(timer => timer.ms).at(-1)).toBe(30_000);
		expect(h.timers).toHaveLength(4);

		// A retry that succeeds resets the count too.
		h.timers[3]?.run();
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
			"the setting is switched off",
			() => {
				h.prefs.scheduledRetry = false;
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
		const off: RpcResponse = {
			type: "response",
			command: "get_settings",
			success: true,
			data: { values: { "retry.enabled": false } },
		};
		// The sidecar's scripted answer changes: the fire re-asks.
		const commands = h.commands;
		commands.length = 0;
		const ask = vi.spyOn(h.pool, "startTab").mockReturnValue({
			status: "ready",
			rpcClient: {
				command: async (cmd: RpcCommand) => {
					commands.push(cmd);
					return cmd.type === "get_settings" ? off : RETRIED;
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
