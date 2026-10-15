import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcCommand, RpcResponse } from "../shared/rpc-types";
import type { SidecarLike } from "./sidecar-pool";
import {
	continuingCount,
	deriveMarkers,
	InterruptedTurnStore,
	isNetworkError,
	launchAction,
	type ResumeFact,
	type ResumeMarker,
	type ResumePool,
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

	it("records a paired host's tab with its device", () => {
		expect(deriveMarkers([fact({ running: true, device: "host-1" })], [], 500)[0]?.device).toBe("host-1");
	});
});

describe("launch rules", () => {
	it("restores a cut-off turn, retries one that waited for the network, reopens an ask through stock restore", () => {
		expect(launchAction(marker({ reason: "running" }))).toBe("restore");
		expect(launchAction(marker({ reason: "network" }))).toBe("retry");
		expect(launchAction(marker({ reason: "asking" }))).toBe("restore");
	});

	it("skips a paired host's tab: the host owns its own resume", () => {
		expect(launchAction(marker({ device: "host-1" }))).toBeNull();
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

/** A tab's sidecar: records the commands main sends and answers them as scripted. */
function fakeSidecar(answers: Partial<Record<string, RpcResponse>> = {}) {
	const commands: RpcCommand[] = [];
	const sidecar = {
		status: "ready",
		on: vi.fn(),
		off: vi.fn(),
		rpcClient: {
			command: async (cmd: RpcCommand): Promise<RpcResponse> => {
				commands.push(cmd);
				return answers[cmd.type] ?? { type: "response", command: cmd.type, success: true, data: {} };
			},
		},
	} as unknown as SidecarLike;
	return { sidecar, commands };
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
}

function setup(
	options: {
		enabled?: boolean;
		online?: boolean;
		waitAfterWake?: boolean;
		answers?: Partial<Record<string, RpcResponse>>;
	} = {},
): Harness {
	const dir = mkdtempSync(join(tmpdir(), "ompdesk-resume-"));
	const file = join(dir, "interrupted-turns.json");
	const store = new InterruptedTurnStore(file);
	const facts: ResumeFact[] = [];
	const awaiting: Array<[string, boolean]> = [];
	const { sidecar, commands } = fakeSidecar(options.answers);
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
		tabForSession: sessionPath => facts.find(entry => entry.sessionFile === sessionPath)?.tabId ?? null,
		noteStopped: tabId => {
			const entry = facts.find(candidate => candidate.tabId === tabId);
			if (entry) entry.stopped = true;
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
		frozen: () => state.frozen,
		now: () => 1_000,
		openTab: markerToOpen => {
			state.opened.push(markerToOpen);
			facts.push(fact({ tabId: "opened", sessionFile: markerToOpen.sessionPath }));
			return "opened";
		},
		notify: count => state.notices.push(count),
	});
	return { dir, file, store, facts, awaiting, commands, net, state, resume, pool };
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

	it("skips a paired host's turn and drops its marker", async () => {
		h = setup();
		new InterruptedTurnStore(h.file).write([marker({ device: "host-1" })]);
		h.resume.launch();
		await settle();
		expect(h.commands).toEqual([]);
		expect(h.state.notices).toEqual([]);
		expect(h.store.read()).toEqual([]);
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

	it("a network error just after a wake waits too, and continues as soon as the network answers", async () => {
		h = setup({ online: true, waitAfterWake: true, answers: { retry: RETRIED } });
		h.resume.launch();
		h.facts.push(fact({ running: false, lastRun: { ...networkFailure } }));
		h.resume.sync();
		await settle();
		expect(h.commands.map(cmd => cmd.type)).toEqual(["retry"]);
	});

	it("an ordinary failure while online is a failure: no waiting, no retry", async () => {
		h = setup({ online: true });
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
