import { describe, expect, it } from "vitest";
import type { Job, Run } from "../../../shared/checks-contract";
import { emptySnapshot } from "../../../shared/checks-contract";
import { sampleSnapshot } from "../../../shared/checks-fixture";
import type { ChecksFrame } from "../../../shared/checks-frame";
import { sampleNames } from "../../../shared/checks-frame-fixture";
import {
	freshness,
	gateProgress,
	jobTally,
	lastAnswer,
	originView,
	poolFill,
	poolsWithWork,
	releases,
	releaseWaits,
	runState,
	runsByLane,
	waitedRun,
	waitingJobs,
} from "./view";

const NOW = 1_794_000_700_000;
const frame = (): ChecksFrame => ({ snapshot: sampleSnapshot(NOW), names: sampleNames(), hub: "live" });
const run = (id: string): Run => {
	const found = sampleSnapshot(NOW).runs.find(entry => entry.id === id);
	if (!found) throw new Error(`the sample has ${id}`);
	return found;
};
const job = (state: Job["state"], os: Job["os"] = "macos"): Job => ({
	id: `${os}-${state}`,
	name: `${os} ${state}`,
	os,
	pool: `github-${os}`,
	state,
	queuedAt: NOW,
});

describe("freshness", () => {
	it("is lost while main cannot reach the hub, whatever the pools say", () => {
		expect(freshness({ ...frame(), hub: "lost" })).toBe("lost");
	});

	it("is stale only once the hub reads no pool as live", () => {
		const live = frame();
		expect(freshness(live)).toBe("live");
		const pools = live.snapshot.pools.map(pool => ({ ...pool, state: "stale" as const }));
		expect(freshness({ ...live, snapshot: { ...live.snapshot, pools } })).toBe("stale");
	});

	it("is live for a hub with no pool yet: there is nothing old to distrust", () => {
		expect(freshness({ ...frame(), snapshot: emptySnapshot(NOW) })).toBe("live");
	});
});

describe("pools", () => {
	it("lists only the pools with work, GitHub's first, then this computer", () => {
		expect(poolsWithWork(frame()).map(pool => pool.id)).toEqual(["github-macos", "github-linux", "device-macbook"]);
	});

	it("never counts an offline computer's work or its queue", () => {
		const base = frame();
		const pools = base.snapshot.pools.map(pool =>
			pool.id === "device-mini" ? { ...pool, running: 1, queued: 4 } : pool,
		);
		const offline = { ...base, snapshot: { ...base.snapshot, pools } };
		expect(poolsWithWork(offline).map(pool => pool.id)).not.toContain("device-mini");
		expect(waitingJobs(offline.snapshot)).toBe(3);
	});

	it("reads a pool with no free slot as full, and one with no slots as empty", () => {
		const [mac, linux] = sampleSnapshot(NOW).pools;
		if (!mac || !linux) throw new Error("the sample has both GitHub pools");
		expect(poolFill(mac)).toEqual({ fraction: 1, tone: "full" });
		expect(poolFill(linux)).toEqual({ fraction: 0.15, tone: "plain" });
		expect(poolFill({ ...mac, limit: 0 })).toEqual({ fraction: 0, tone: "plain" });
	});

	it("counts heavy work outside OMPdesk against a computer's slots, and as work there", () => {
		const macbook = sampleSnapshot(NOW).pools.find(pool => pool.id === "device-macbook");
		if (!macbook) throw new Error("the sample has this computer's pool");
		expect(macbook.running).toBe(2);
		expect(poolFill(macbook)).toEqual({ fraction: 1, tone: "full" });
		const idle = { ...macbook, running: 0, queued: 0 };
		expect(poolsWithWork({ ...frame(), snapshot: { ...frame().snapshot, pools: [idle] } })).toEqual([idle]);
		expect(
			poolsWithWork({ ...frame(), snapshot: { ...frame().snapshot, pools: [{ ...idle, foreign: [] }] } }),
		).toEqual([]);
	});
});

describe("releases", () => {
	it("groups the gates by release with the runs that decide them", () => {
		const [release, ...rest] = releases(sampleSnapshot(NOW));
		expect(rest).toEqual([]);
		expect(release?.id).toBe("v1.4.0");
		expect(release?.gates.map(status => status.gate.id)).toEqual(["gate-mac", "gate-linux"]);
		expect(release?.runs.map(entry => entry.id)).toEqual(["run-41"]);
		expect(release && gateProgress(release)).toEqual({ green: 1, total: 2 });
	});

	it("says which pool a release's jobs wait at, the full one first", () => {
		const snapshot = sampleSnapshot(NOW);
		const [release] = releases(snapshot);
		if (!release) throw new Error("the sample has a release");
		expect(releaseWaits(release, snapshot)).toEqual([]);
		const waiting = {
			...release,
			runs: release.runs.map(entry => ({
				...entry,
				jobs: [...entry.jobs, job("queued", "linux"), job("held"), job("queued")],
			})),
		};
		expect(releaseWaits(waiting, snapshot).map(wait => [wait.pool.id, wait.jobs, wait.full])).toEqual([
			["github-macos", 2, true],
			["github-linux", 1, false],
		]);
	});
});

describe("runs", () => {
	it("names a run by what ended it, else by how far its jobs got", () => {
		expect(runState(run("run-41"))).toBe("running");
		expect(runState(run("run-42"))).toBe("held");
		expect(runState(run("run-40"))).toBe("failed");
		const live = run("run-42");
		expect(runState({ ...live, jobs: [job("queued")] })).toBe("queued");
		expect(runState({ ...live, verdict: "green" })).toBe("passed");
		expect(runState({ ...live, verdict: "green", reusedFrom: "run-1" })).toBe("reused");
		expect(runState({ ...live, verdict: "cancelled", supersededBy: "run-50" })).toBe("superseded");
	});

	it("puts runs under their lane in admission order and counts each lane's states", () => {
		const groups = runsByLane(sampleSnapshot(NOW).runs);
		expect(groups.map(group => [group.lane, group.runs.map(entry => entry.id)])).toEqual([
			["release", ["run-41"]],
			["branch", ["run-42", "run-40"]],
		]);
		expect(groups[1]?.states).toEqual({ held: 1, failed: 1 });
	});

	it("tallies a run's jobs per OS, the OS with live work first", () => {
		const tallies = jobTally([job("passed", "linux"), job("running"), job("queued"), job("queued")]);
		expect(tallies.map(tally => [tally.os, tally.running, tally.queued, tally.done])).toEqual([
			["macos", 1, 2, false],
			["linux", 0, 0, true],
		]);
	});

	it("finds the live run a session waits on by its saved or tab id on its computer, never a finished one", () => {
		const snapshot = sampleSnapshot(NOW);
		expect(waitedRun(snapshot, { ids: ["0a1b2c3d"], device: "local" })?.id).toBe("run-41");
		expect(waitedRun(snapshot, { ids: ["tab-9", "4e5f6a7b"], device: "mac-mini" })?.id).toBe("run-42");
		expect(waitedRun(snapshot, { ids: ["4e5f6a7b"], device: "local" })).toBeNull();
		expect(waitedRun(snapshot, { ids: ["nobody"], device: "local" })).toBeNull();
		const ended = { ...snapshot, runs: snapshot.runs.map(entry => ({ ...entry, verdict: "green" as const })) };
		expect(waitedRun(ended, { ids: ["0a1b2c3d"], device: "local" })).toBeNull();
	});
});

describe("who and what", () => {
	it("names a session's origin from the frame's names, its goal as written, and leaves an unknown id unnamed", () => {
		const names = sampleNames();
		const origin = run("run-41").origin;
		expect(originView(origin, names)).toEqual({
			kind: "session",
			title: "Ship 1.4 (Autopilot)",
			goal: origin.kind === "session" ? origin.goal : undefined,
			device: "MacBook",
			autopilot: true,
		});
		expect(originView({ kind: "session", session: "zzz", device: "elsewhere" }, names)).toEqual({ kind: "session" });
		expect(originView({ kind: "outside", claimedName: "ci-bot" }, names)).toEqual({
			kind: "outside",
			title: "ci-bot",
		});
		expect(originView({ kind: "person" }, names)).toEqual({ kind: "person" });
	});

	it("takes the newest answer as the last an agent received", () => {
		const snapshot = sampleSnapshot(NOW);
		const [first] = snapshot.answers;
		if (!first) throw new Error("the sample has an answer");
		const newer = {
			...first,
			runId: "run-41",
			answer: { ...first.answer, runId: "run-41", asOf: first.answer.asOf + 1 },
		};
		expect(lastAnswer({ ...snapshot, answers: [newer, first] })?.runId).toBe("run-41");
		expect(lastAnswer(emptySnapshot(NOW))).toBeNull();
	});
});
