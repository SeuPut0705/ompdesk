/**
 * A `ChecksHub` in memory that a test or the dev harness scripts, with the rules of the core's fake hub
 * (`native/ompdesk/crates/core/src/checks/fake.rs`; `src/main/checks/client.test.ts` runs the same cases over both):
 * it decides nothing and reads nothing. A start answers the next scripted reply (else `started` with a run id of its
 * own), a wait ends when a result is handed in for its run, `status` and `watch` show the snapshot last set, and every
 * call is kept. `sampleSnapshot` is made-up data for screens (invented repos, no real name or address).
 */
import {
	type Answer,
	CHECKS_LIMITS,
	type ChecksHub,
	emptySnapshot,
	type FakeCall,
	type FakeOp,
	type Origin,
	type RunResult,
	type Snapshot,
	type StartReply,
} from "./checks-contract";

/** A hub a test scripts: `apply` is `checks.fake`'s op (`calls` answers the calls so far, the others null). */
export interface FakeChecksHub extends ChecksHub {
	apply(op: FakeOp): Promise<FakeCall[] | null>;
}

function pending(runId: string, note: string): Answer {
	return {
		runId,
		verdict: "unknown",
		asOf: Date.now(),
		counts: { passed: 0, failed: 0 },
		failed: [],
		blocksRelease: null,
		expectedWaitMin: null,
		next: "wait",
		notes: [note],
	};
}

export function createFakeChecksHub(): FakeChecksHub {
	let snapshot = emptySnapshot(Date.now());
	let started = 0;
	/** Grows with every snapshot and result: what `until: any` waits on. */
	let changes = 0;
	const replies: StartReply[] = [];
	const answers = new Map<string, Answer>();
	const calls: FakeCall[] = [];
	const watchers = new Set<(snapshot: Snapshot) => void>();
	const resultListeners = new Set<(result: RunResult) => void>();
	const wakers = new Set<() => void>();

	const called = (op: string, origin: Origin | null, request: unknown) =>
		calls.push({ op, origin, request: structuredClone(request) });
	const show = (next: Snapshot) => {
		snapshot = next;
		changes += 1;
		for (const watcher of [...watchers]) watcher(snapshot);
		for (const wake of [...wakers]) wake();
	};

	return {
		async start(origin, request) {
			called("start", origin, request);
			if (snapshot.paused) {
				return {
					runId: null,
					decision: "refused",
					placement: null,
					expectedStartMin: null,
					reason: "paused by the owner",
				};
			}
			const scripted = replies.shift();
			if (scripted) return scripted;
			started += 1;
			return {
				runId: `fake-${started}`,
				decision: "started",
				placement: { kind: "github-hosted" },
				expectedStartMin: 0,
				reason: "the fake hub starts everything",
			};
		},

		async wait(origin, request, signal) {
			called("wait", origin, request);
			const seconds = request.timeoutSeconds ?? CHECKS_LIMITS.waitDefaultSeconds;
			const before = changes;
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				for (const wake of [...wakers]) wake();
			}, seconds * 1000);
			try {
				for (;;) {
					signal?.throwIfAborted();
					const answer = answers.get(request.runId);
					if (answer) return answer;
					if (request.until === "any" && changes > before) return pending(request.runId, "The run changed.");
					if (timedOut) return pending(request.runId, `Still running after waiting ${seconds} s.`);
					const woken = Promise.withResolvers<void>();
					const wake = () => woken.resolve();
					wakers.add(wake);
					signal?.addEventListener("abort", wake, { once: true });
					await woken.promise;
					wakers.delete(wake);
					signal?.removeEventListener("abort", wake);
				}
			} finally {
				clearTimeout(timer);
			}
		},

		async status(origin, request) {
			called("status", origin, request);
			return snapshot;
		},

		watch(listener) {
			watchers.add(listener);
			listener(snapshot);
			return () => watchers.delete(listener);
		},

		onResult(listener) {
			resultListeners.add(listener);
			return () => resultListeners.delete(listener);
		},

		async pause(paused) {
			called("pause", null, paused);
			show({ ...snapshot, paused });
		},

		async told(fact) {
			called("told", null, fact);
		},

		async apply(op) {
			switch (op.op) {
				case "snapshot":
					show(op.snapshot);
					return null;
				case "startReply":
					replies.push(op.reply);
					return null;
				case "finish":
					answers.set(op.result.runId, op.result.answer);
					changes += 1;
					for (const listener of [...resultListeners]) listener(op.result);
					for (const wake of [...wakers]) wake();
					return null;
				case "calls":
					return structuredClone(calls);
			}
		},
	};
}

const SESSION: Origin = { kind: "session", session: "0a1b2c3d", device: "local", goal: "Ship release 2" };

/** A red run's answer, as an agent would receive it. */
export function sampleAnswer(runId = "run-41"): Answer {
	return {
		runId,
		verdict: "red",
		asOf: 1_794_000_700_000,
		counts: { passed: 1143, failed: 1 },
		failed: [
			{
				test: "src/store/save.test.ts > saves the file once",
				firstError: "AssertionError: expected 1 to be 2",
				knownFlaky: true,
				history: "failed 3 of the last 20 runs on unchanged inputs",
			},
		],
		blocksRelease: { gate: "gate-mac" },
		expectedWaitMin: null,
		next: "rerun-failed",
		notes: ["1 rerun left for this run"],
	};
}

/** A busy moment for screens: GitHub's macOS pool full with a queue, two computers, a release gate, three runs. */
export function sampleSnapshot(asOf = 1_794_000_700_000): Snapshot {
	const minute = 60_000;
	return {
		asOf,
		paused: false,
		pools: [
			{
				id: "github-macos",
				os: "macos",
				where: { kind: "github-hosted" },
				limit: 5,
				running: 5,
				queued: 3,
				oldestWaitMs: 9 * minute,
				asOf,
				state: "live",
				foreign: [],
			},
			{
				id: "github-linux",
				os: "linux",
				where: { kind: "github-hosted" },
				limit: 40,
				running: 6,
				queued: 0,
				oldestWaitMs: 0,
				asOf,
				state: "live",
				foreign: [],
			},
			{
				id: "device-macbook",
				os: "macos",
				where: { kind: "device", deviceId: "local" },
				limit: 3,
				running: 2,
				queued: 0,
				oldestWaitMs: 0,
				diskFreeGb: 212.4,
				asOf,
				state: "live",
				foreign: [{ kind: "cargo", pid: 4242, command: "cargo build --release -p game", processes: 9 }],
			},
			{
				id: "device-mini",
				os: "macos",
				where: { kind: "device", deviceId: "mac-mini" },
				limit: 1,
				running: 0,
				queued: 0,
				oldestWaitMs: 0,
				diskFreeGb: 18.9,
				asOf: asOf - 14 * minute,
				state: "offline",
				foreign: [],
			},
		],
		runs: [
			{
				id: "run-41",
				repo: "example/app",
				ref: "release/1.4",
				sha: "9f2c1d7e4b6a8c0d2e4f6a8b0c1d3e5f7a9b1c3d",
				lane: "release",
				trigger: "dispatch",
				origin: SESSION,
				gate: "gate-mac",
				jobs: [
					{
						id: "job-411",
						name: "mac-smoke",
						os: "macos",
						pool: "github-macos",
						state: "running",
						queuedAt: asOf - 21 * minute,
						startedAt: asOf - 18 * minute,
					},
					{
						id: "job-412",
						name: "check (node 1/2)",
						os: "linux",
						pool: "github-linux",
						state: "passed",
						queuedAt: asOf - 21 * minute,
						startedAt: asOf - 21 * minute,
						endedAt: asOf - 9 * minute,
						billedMin: 12,
					},
				],
				digest: "sha256:7be1",
			},
			{
				id: "run-42",
				repo: "example/app",
				ref: "omp/agent/search-index",
				sha: "1a3c5e7092b4d6f8a0c2e4f6081a3c5e7092b4d6",
				lane: "branch",
				trigger: "dispatch",
				origin: { kind: "session", session: "4e5f6a7b", device: "mac-mini" },
				jobs: [
					{
						id: "job-421",
						name: "mac-native",
						os: "macos",
						pool: "github-macos",
						state: "held",
						queuedAt: asOf - 6 * minute,
					},
				],
				digest: "sha256:02af",
			},
			{
				id: "run-40",
				repo: "example/site",
				ref: "main",
				sha: "c0ffee1234567890c0ffee1234567890c0ffee12",
				lane: "branch",
				trigger: "push",
				origin: { kind: "person" },
				jobs: [
					{
						id: "job-401",
						name: "build",
						os: "linux",
						pool: "github-linux",
						state: "failed",
						queuedAt: asOf - 40 * minute,
						startedAt: asOf - 40 * minute,
						endedAt: asOf - 31 * minute,
						billedMin: 9,
					},
				],
				verdict: "red",
				digest: "sha256:91d0",
			},
		],
		gates: [
			{
				gate: {
					id: "gate-mac",
					release: "v1.4.0",
					jobs: { workflow: "ci.yml", jobs: ["mac-smoke", "mac-native"] },
					required: true,
				},
				state: "running",
				run: "run-41",
			},
			{
				gate: {
					id: "gate-linux",
					release: "v1.4.0",
					jobs: { workflow: "ci.yml", jobs: ["static", "check", "build"] },
					required: true,
				},
				state: "green",
				run: "run-41",
			},
		],
		queue: [
			{
				id: "q-1",
				repo: "example/app",
				base: "main",
				branch: "omp/agent/search-index",
				pr: 128,
				title: "Index the search results",
				sha: "1a3c5e7092b4d6f8a0c2e4f6081a3c5e7092b4d6",
				lane: "land",
				position: 1,
				batch: "batch-3",
				state: "testing",
			},
		],
		decisions: [
			{
				policy: "cancel-superseded",
				run: "run-39",
				action: "cancel-superseded",
				reason: "run-42 is a newer run of the same ref and workflow",
				why: { code: "newer-run", run: "run-42" },
				at: asOf - 6 * minute,
			},
			{
				policy: "release-first",
				run: "run-42",
				action: "hold",
				reason: "macOS is full (5 of 5) and a release job is ahead",
				why: { code: "release-ahead", pool: "github-macos", running: 5, limit: 5 },
				at: asOf - 6 * minute,
			},
		],
		answers: [{ runId: "run-40", origin: SESSION, answer: { ...sampleAnswer("run-40"), blocksRelease: null } }],
		adoption: { started: 14, refused: 2, polls: 0, wrongGreens: 0 },
		trends: {
			tests: [
				{
					test: "t-91ac",
					name: "e2e/smoke.e2e.ts › opens a tab",
					os: "windows",
					p50Ms30d: 4200,
					runs7d: 140,
					fails7d: 11,
					state: "quarantined",
					flakedOn: "sha256:a31f",
					quarantinedAt: asOf - 2 * 24 * 60 * minute,
					quarantinedBy: SESSION,
					cleanSince: 2,
				},
			],
			slowdowns: [
				{
					test: "t-55d0",
					name: "src/store/save.test.ts > saves the file once",
					os: "linux",
					p50Ms30d: 900,
					lastMs: [880, 910, 1300, 1280, 1410],
					sinceSha: "9f2c1d7e4b6a8c0d2e4f6a8b0c1d3e5f7a9b1c3d",
				},
			],
			minutes: [
				{ os: "macos", month: "2026-11", minutes: 412.5, costUsd: 33 },
				{ os: "linux", month: "2026-11", minutes: 1890, costUsd: 15.12 },
			],
			queueDepth: [
				{ at: asOf - 30 * minute, pool: "github-macos", queued: 1 },
				{ at: asOf, pool: "github-macos", queued: 3 },
			],
			lostMs7d: 90 * minute,
			lostMsPrev7d: 150 * minute,
			savedByRerunMs7d: 360 * minute,
			savedByReuseMs7d: 240 * minute,
			storeBytes: 6_800_000_000,
		},
	};
}
