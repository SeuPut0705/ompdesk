import { afterEach, describe, expect, it, vi } from "vitest";
import type { Origin, RunResult, Snapshot } from "../../shared/checks-contract";
import { createFakeChecksHub, type FakeChecksHub, sampleAnswer, sampleSnapshot } from "../../shared/checks-fixture";
import { advanceCoreTimers, fakeCoreTimers, realCoreTimers } from "../core/test-clock";
import { CoreChecksHub } from "./client";

const SESSION: Origin = { kind: "session", session: "0a1b2c3d", device: "local" };

const opened: CoreChecksHub[] = [];

afterEach(async () => {
	for (const hub of opened.splice(0)) await hub.close();
});

/** A scripted hub and the clock its waits run on. */
interface Subject {
	make(): FakeChecksHub;
	fakeTimers(): Promise<void>;
	advance(ms: number): Promise<void>;
	realTimers(): Promise<void>;
}

/** The two scripted hubs, held to the same cases: the page's in-memory one and the core's over the real wire. */
const HUBS: [string, Subject][] = [
	[
		"the in-memory fake",
		{
			make: createFakeChecksHub,
			fakeTimers: async () => void vi.useFakeTimers(),
			advance: async ms => void (await vi.advanceTimersByTimeAsync(ms)),
			realTimers: async () => void vi.useRealTimers(),
		},
	],
	[
		"the core's fake hub",
		{
			make: () => {
				const hub = new CoreChecksHub({ fake: true });
				opened.push(hub);
				return hub;
			},
			fakeTimers: fakeCoreTimers,
			advance: advanceCoreTimers,
			realTimers: realCoreTimers,
		},
	],
];

/** Resolves once the hub has kept `count` calls: a wait is in from then on. */
async function called(hub: FakeChecksHub, count: number): Promise<void> {
	while ((await hub.apply({ op: "calls" }))?.length !== count) await Promise.resolve();
}

describe.each(HUBS)("a scripted checks hub: %s", (_name, { make, fakeTimers, advance, realTimers }) => {
	it("starts a run of its own, then answers the scripted reply, and keeps who asked", async () => {
		const hub = make();
		const first = await hub.start(SESSION, { purpose: "branch", scope: "changed" });
		expect(first).toMatchObject({ runId: "fake-1", decision: "started", placement: { kind: "github-hosted" } });
		const held = {
			runId: "run-9",
			decision: "held",
			placement: null,
			expectedStartMin: 12,
			reason: "macOS is full",
		} as const;
		await hub.apply({ op: "startReply", reply: held });
		expect(await hub.start(SESSION, { purpose: "release", scope: "full", ref: "release/1.4" })).toEqual(held);
		expect(await hub.apply({ op: "calls" })).toEqual([
			{ op: "start", origin: SESSION, request: { purpose: "branch", scope: "changed" } },
			{ op: "start", origin: SESSION, request: { purpose: "release", scope: "full", ref: "release/1.4" } },
		]);
	});

	it("ends a wait with the result handed in for its run, and tells every result listener", async () => {
		const hub = make();
		const results: RunResult[] = [];
		hub.onResult(result => results.push(result));
		const waiting = hub.wait(SESSION, { runId: "run-41", until: "result", timeoutSeconds: 60 });
		// The wait is in once the hub has kept its call.
		await expect.poll(async () => (await hub.apply({ op: "calls" }))?.length).toBe(1);
		const result: RunResult = { runId: "run-41", origin: SESSION, answer: sampleAnswer() };
		await hub.apply({ op: "finish", result });
		expect(await waiting).toEqual(sampleAnswer());
		await expect.poll(() => results).toEqual([result]);
	});

	it("answers unknown, never an error, when a wait runs out", async () => {
		const hub = make();
		await fakeTimers();
		try {
			const waiting = hub.wait(SESSION, { runId: "run-41", until: "result", timeoutSeconds: 60 });
			await called(hub, 1);
			await advance(60_000);
			expect(await waiting).toMatchObject({
				runId: "run-41",
				verdict: "unknown",
				next: "wait",
				notes: ["no result within 60 s: wait again"],
				said: [{ code: "wait-timed-out", seconds: 60 }],
			});
		} finally {
			await realTimers();
		}
	});

	it("stops a wait whose caller gave up", async () => {
		const hub = make();
		const gaveUp = new AbortController();
		const waiting = hub.wait(SESSION, { runId: "run-41", until: "result", timeoutSeconds: 60 }, gaveUp.signal);
		await expect.poll(async () => (await hub.apply({ op: "calls" }))?.length).toBe(1);
		gaveUp.abort();
		await expect(waiting).rejects.toThrow();
	});

	it("shows watchers the snapshot now and at each change, and refuses starts while paused", async () => {
		const hub = make();
		const seen: Snapshot[] = [];
		const stop = hub.watch(snapshot => seen.push(snapshot));
		await expect.poll(() => seen.length).toBe(1);
		expect(seen[0]).toMatchObject({ paused: false, pools: [], runs: [] });
		await hub.apply({ op: "snapshot", snapshot: sampleSnapshot() });
		await expect.poll(() => seen.at(-1)).toEqual(sampleSnapshot());
		expect(await hub.status(SESSION, { scope: "all" })).toEqual(sampleSnapshot());
		await hub.pause(true);
		await expect.poll(() => seen.at(-1)?.paused).toBe(true);
		expect(await hub.start(SESSION, { purpose: "branch", scope: "changed" })).toEqual({
			runId: null,
			decision: "refused",
			placement: null,
			expectedStartMin: null,
			reason: "paused by the owner",
		});
		stop();
	});

	it("keeps what main tells it", async () => {
		const hub = make();
		const tags = { kind: "sessions", tags: { "3f9a": SESSION } } as const;
		await hub.told({ kind: "repos", repos: ["example/app"] });
		await hub.told(tags);
		expect(await hub.apply({ op: "calls" })).toEqual([
			{ op: "told", origin: null, request: { kind: "repos", repos: ["example/app"] } },
			{ op: "told", origin: null, request: tags },
		]);
	});
});

describe("the core's checks hub", () => {
	it("opens the real hub, whose status costs no GitHub request", async () => {
		const hub = new CoreChecksHub();
		opened.push(hub);
		const snapshot = await hub.status(SESSION, { scope: "all" });
		expect(snapshot).toMatchObject({ paused: false, queue: [], answers: [] });
	});

	it("takes how gh and git run and keeps nothing of their environment", async () => {
		const hub = new CoreChecksHub({ fake: true });
		opened.push(hub);
		const gh = {
			bin: "/usr/bin/gh",
			args: [],
			env: { GH_TOKEN: "ghp_never-in-an-answer" },
			timeoutMs: 1000,
			maxBytes: 1024,
		};
		await hub.runners(gh, null, "/home/me");
		const calls = await hub.apply({ op: "calls" });
		expect(calls).toEqual([{ op: "runners", origin: null, request: { gh: true, git: false } }]);
	});
});
