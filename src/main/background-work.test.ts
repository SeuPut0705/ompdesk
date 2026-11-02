import { describe, expect, it } from "vitest";
import { fillText } from "../shared/fill-text";
import {
	BACKGROUND_WORK_REFRESH_MS,
	type BackgroundWorkMember,
	BackgroundWorkWatcher,
	backgroundWorkSentence,
	hasBackgroundWork,
	mergeBackgroundWork,
	NO_BACKGROUND_WORK,
	namedBackgroundWork,
	summarizeJobRows,
} from "./background-work";
import { MAIN_TEXT, type MainTextKey } from "./i18n-text";

type JobType = "bash" | "task" | "eval";
const job = (type: JobType, label: string, status = "running", depth = 0) => ({
	kind: "job",
	depth,
	cancellable: true,
	job: { id: `${type}:${label}`, type, status, label, startTime: 1 },
});

describe("summarizeJobRows", () => {
	it("counts running subagents and the sessions' own running shells and evals, with their labels", () => {
		const work = summarizeJobRows([
			job("task", "LayoutSplit"),
			job("task", "StreamFast"),
			job("bash", "dev server"),
			job("eval", "notebook"),
			job("task", "Old", "completed"),
			job("bash", "failed one", "failed"),
			{ kind: "agent", agentId: "a1", depth: 1 },
		]);
		expect(work).toEqual({
			subagents: 2,
			jobs: 2,
			subagentLabels: ["LayoutSplit", "StreamFast"],
			jobLabels: ["dev server", "notebook"],
		});
	});

	it("leaves a subagent's own shells to the subagent, but counts a subagent nested in one", () => {
		const work = summarizeJobRows([
			job("task", "Outer"),
			job("bash", "inner shell", "running", 1),
			job("task", "Nested", "running", 1),
		]);
		expect(work.subagents).toBe(2);
		expect(work.jobs).toBe(0);
	});

	it("reads anything that is not a job list as no work", () => {
		expect(summarizeJobRows(undefined)).toBe(NO_BACKGROUND_WORK);
		expect(summarizeJobRows({ rows: [] })).toBe(NO_BACKGROUND_WORK);
		expect(summarizeJobRows([null, 3, { kind: "job" }, { kind: "job", job: { status: "running" } }])).toBe(
			NO_BACKGROUND_WORK,
		);
	});
});

describe("namedBackgroundWork", () => {
	it("names subagents first, at most three in all, and says where more ran", () => {
		const work = mergeBackgroundWork([
			summarizeJobRows([job("task", "A"), job("task", "B"), job("bash", "C")]),
			summarizeJobRows([job("task", "D")]),
		]);
		expect(namedBackgroundWork(work)).toEqual({
			subagents: { count: 3, names: ["A", "B", "D"], more: false },
			jobs: { count: 1, names: [], more: true },
		});
		expect(namedBackgroundWork(summarizeJobRows([job("task", "A")]))).toEqual({
			subagents: { count: 1, names: ["A"], more: false },
			jobs: { count: 0, names: [], more: false },
		});
	});

	it("shortens a long label to one line", () => {
		const { jobs } = namedBackgroundWork(summarizeJobRows([job("bash", `npm run\n${"x".repeat(100)}`)]));
		expect(jobs.names[0]).toHaveLength(40);
		expect(jobs.names[0]?.endsWith("…")).toBe(true);
		expect(jobs.names[0]).not.toContain("\n");
	});
});

describe("backgroundWorkSentence", () => {
	const say = (language: "en" | "ko") => (key: MainTextKey, params?: Record<string, string | number>) =>
		fillText(MAIN_TEXT[key][language], params);
	const work = summarizeJobRows([job("task", "LayoutSplit"), job("task", "StreamFast"), job("bash", "dev server")]);

	it("says the counts with the names, in each language", () => {
		expect(backgroundWorkSentence(work, say("en"))).toBe(
			"2 subagents (LayoutSplit, StreamFast) and 1 background job (dev server)",
		);
		expect(backgroundWorkSentence(work, say("ko"))).toBe(
			"서브에이전트 2개 (LayoutSplit, StreamFast), 백그라운드 작업 1개 (dev server)",
		);
	});

	it("says one kind alone, singular, and marks names it left out", () => {
		const many = summarizeJobRows(["A", "B", "C", "D"].map(label => job("task", label)));
		expect(backgroundWorkSentence(many, say("en"))).toBe("4 subagents (A, B, C, …)");
		expect(backgroundWorkSentence(summarizeJobRows([job("task", "A")]), say("en"))).toBe("1 subagent (A)");
		expect(backgroundWorkSentence(summarizeJobRows([job("eval", "")]), say("en"))).toBe("1 background job");
	});

	it("names the sessions whose answer did not come, so the confirm never reads empty", () => {
		expect(backgroundWorkSentence({ ...NO_BACKGROUND_WORK, unknown: 1 }, say("en"))).toBe(
			"1 session that did not answer",
		);
		expect(
			backgroundWorkSentence(mergeBackgroundWork([work, { ...NO_BACKGROUND_WORK, unknown: 2 }]), say("ko")),
		).toBe(
			"서브에이전트 2개 (LayoutSplit, StreamFast), 백그라운드 작업 1개 (dev server), 응답하지 않은 세션 2개의 작업",
		);
	});
});

/** A watcher on a clock the test moves, over omps whose answers it controls. */
function watched(members: BackgroundWorkMember[], timeoutMs = 20) {
	let time = 1_000_000;
	const watcher = new BackgroundWorkWatcher({ members: () => members, now: () => time, timeoutMs });
	return {
		watcher,
		advance(ms: number) {
			time += ms;
		},
	};
}

const member = (key: string, answer: () => Promise<unknown>): BackgroundWorkMember & { asked: number } => {
	const self = {
		key,
		asked: 0,
		request: async (method: string) => {
			self.asked++;
			expect(method).toBe("composer.jobs");
			return answer();
		},
	};
	return self;
};

describe("BackgroundWorkWatcher", () => {
	it("reads pending until the first answer lands, then the merged work of every omp", async () => {
		const a = member("a", async () => [job("task", "LayoutSplit")]);
		const b = member("b", async () => [job("bash", "dev server")]);
		const t = watched([a, b]);
		expect(t.watcher.read().pending).toBe(true);
		await t.watcher.fresh();
		const reading = t.watcher.read();
		expect(reading.pending).toBe(false);
		expect(reading.work).toMatchObject({ subagents: 1, jobs: 1 });
	});

	it("never overlaps requests and asks again only after the refresh interval", async () => {
		let release: (rows: unknown) => void = () => {};
		const slow = member("slow", () => new Promise(resolve => (release = resolve)));
		const t = watched([slow], 10_000);
		t.watcher.read();
		t.watcher.read();
		t.advance(BACKGROUND_WORK_REFRESH_MS * 3);
		t.watcher.read();
		expect(slow.asked).toBe(1);
		release([job("task", "A")]);
		await t.watcher.fresh();
		expect(slow.asked).toBe(1);
		t.watcher.read();
		expect(slow.asked).toBe(1);
		t.advance(BACKGROUND_WORK_REFRESH_MS - 1);
		t.watcher.read();
		expect(slow.asked).toBe(1);
		t.advance(1);
		t.watcher.read();
		expect(slow.asked).toBe(2);
	});

	it("counts an omp whose answer failed or never came as unknown work, which holds like running work", async () => {
		const ok = member("ok", async () => [job("task", "A")]);
		const broken = member("broken", async () => {
			throw new Error("gui-bridge not connected");
		});
		const hung = member("hung", () => new Promise(() => {}));
		const junk = member("junk", async () => "not rows");
		const t = watched([broken, hung, junk, ok]);
		const work = await t.watcher.fresh();
		expect(work).toMatchObject({ subagents: 1, jobs: 0, unknown: 2, subagentLabels: ["A"] });
		expect(hasBackgroundWork(await watched([hung]).watcher.fresh())).toBe(true);
	});

	// The advisory on the 2 Nov 2026 fix: an omp running a subagent whose next answer timed out read as no work.
	it("never reads a running subagent as gone when the next answer times out", async () => {
		let hang = false;
		const m = member("m", () => (hang ? new Promise(() => {}) : Promise.resolve([job("task", "StreamFast")])));
		const t = watched([m]);
		expect(hasBackgroundWork(await t.watcher.fresh())).toBe(true);
		hang = true;
		t.advance(BACKGROUND_WORK_REFRESH_MS);
		expect(hasBackgroundWork(await t.watcher.fresh())).toBe(true);
		expect(hasBackgroundWork(t.watcher.read().work)).toBe(true);
	});

	it("says when the answer it holds was asked", async () => {
		const t = watched([member("m", async () => [])]);
		expect(t.watcher.read().askedAt).toBeUndefined();
		const asked = t.watcher.fresh();
		t.advance(500);
		await asked;
		expect(t.watcher.read().askedAt).toBe(1_000_000);
	});

	it("never throws, and holds, when listing the omps does", async () => {
		const watcher = new BackgroundWorkWatcher({
			members: () => {
				throw new Error("pool gone");
			},
		});
		expect(hasBackgroundWork(await watcher.fresh())).toBe(true);
	});

	it("asks nothing when no omp runs, and says none", async () => {
		const t = watched([]);
		expect(await t.watcher.fresh()).toBe(NO_BACKGROUND_WORK);
		expect(t.watcher.read()).toEqual({ work: NO_BACKGROUND_WORK, pending: false, askedAt: 1_000_000, frozen: false });
	});

	it("starts a new live period after idle: pending again, the old answer dropped, a late answer ignored", async () => {
		const answers: Array<(rows: unknown) => void> = [];
		const m = member("m", () => new Promise(resolve => answers.push(resolve)));
		const t = watched([m], 10_000);
		const first = t.watcher.fresh();
		t.watcher.idle();
		answers[0]?.([job("task", "A")]);
		await first;
		// The answer began before idle: it is of the earlier period and says nothing now.
		expect(t.watcher.read()).toEqual({ work: NO_BACKGROUND_WORK, pending: true, frozen: false });
		answers[1]?.([job("task", "B")]);
		await t.watcher.fresh();
		expect(t.watcher.read()).toMatchObject({ pending: false, work: { subagentLabels: ["B"] } });
		t.watcher.idle();
		expect(t.watcher.read()).toEqual({ work: NO_BACKGROUND_WORK, pending: true, frozen: false });
	});
});

/**
 * An omp with the bridge's job gate (resources/gui-bridge/job-gate.ts): `composer.freeze_jobs` answers its rows and
 * closes the gate when it runs nothing and no tool call is under way; `composer.thaw_jobs` opens it.
 */
function gated(key: string, rows: () => unknown[], options: { starting?: number; hang?: boolean } = {}) {
	const self = {
		key,
		frozen: false,
		calls: [] as string[],
		request: async (method: string): Promise<unknown> => {
			self.calls.push(method);
			if (method === "composer.thaw_jobs") {
				const thawed = self.frozen;
				self.frozen = false;
				return { thawed };
			}
			if (method === "composer.freeze_jobs") {
				if (options.hang) return new Promise(() => {});
				const answer = rows();
				const starting = options.starting ?? 0;
				const frozen = !hasBackgroundWork(summarizeJobRows(answer)) && starting === 0;
				if (frozen) self.frozen = true;
				return { rows: answer, frozen, starting };
			}
			return rows();
		},
	};
	return self;
}

// The limit the 2 Nov 2026 fix left: a job started in the second between the countdown's last look and the install was
// cut. The last look also stops every omp from starting work, so nothing can start between it and the quit.
describe("BackgroundWorkWatcher.freeze", () => {
	it("stops job starts on every omp and reads frozen only when none runs anything", async () => {
		const a = gated("a", () => []);
		const b = gated("b", () => [job("task", "Done", "completed")]);
		const t = watched([a, b]);
		expect(await t.watcher.freeze()).toBe(NO_BACKGROUND_WORK);
		expect(t.watcher.read()).toEqual({ work: NO_BACKGROUND_WORK, pending: false, askedAt: 1_000_000, frozen: true });
		expect([a.frozen, b.frozen]).toEqual([true, true]);
	});

	it("lets every omp start work again at once when one runs work, and reads not frozen", async () => {
		const idle = gated("idle", () => []);
		const busy = gated("busy", () => [job("task", "LayoutSplit")]);
		const t = watched([idle, busy]);
		const work = await t.watcher.freeze();
		expect(work.subagentLabels).toEqual(["LayoutSplit"]);
		expect(t.watcher.read().frozen).toBe(false);
		expect(idle.frozen).toBe(false);
		expect(idle.calls).toEqual(["composer.freeze_jobs", "composer.thaw_jobs"]);
	});

	it("reads an omp that does not answer in time as unknown work and thaws every omp it asked", async () => {
		const idle = gated("idle", () => []);
		const silent = gated("silent", () => [], { hang: true });
		const t = watched([idle, silent]);
		expect((await t.watcher.freeze()).unknown).toBe(1);
		expect(t.watcher.read().frozen).toBe(false);
		expect(idle.frozen).toBe(false);
		// Its answer may still come and close its gate: it hears the thaw too.
		expect(silent.calls).toEqual(["composer.freeze_jobs", "composer.thaw_jobs"]);
	});

	it("counts tool calls under way as starting work: the gate stays open, yet nothing reads as running", async () => {
		const m = gated("m", () => [], { starting: 1 });
		const t = watched([m]);
		const work = await t.watcher.freeze();
		expect(work.starting).toBe(1);
		expect(hasBackgroundWork(work)).toBe(false);
		expect(t.watcher.read().frozen).toBe(false);
	});

	it("thaw and idle let every frozen omp start work again", async () => {
		const m = gated("m", () => []);
		const t = watched([m]);
		await t.watcher.freeze();
		t.watcher.thaw();
		expect(m.frozen).toBe(false);
		expect(t.watcher.read().frozen).toBe(false);
		await t.watcher.freeze();
		t.watcher.idle();
		expect(m.frozen).toBe(false);
		expect(t.watcher.read().frozen).toBe(false);
	});

	it("never lets a plain look asked before the freeze replace the frozen answer", async () => {
		let release: (rows: unknown) => void = () => {};
		let slow = true;
		const m = {
			...gated("m", () => []),
		};
		const plain = m.request;
		m.request = (method: string) =>
			method === "composer.jobs" && slow ? new Promise(resolve => (release = resolve)) : plain(method);
		const t = watched([m], 10_000);
		const look = t.watcher.fresh();
		slow = false;
		t.advance(1000);
		await t.watcher.freeze();
		release([job("task", "Stale")]);
		await look;
		expect(t.watcher.read()).toEqual({ work: NO_BACKGROUND_WORK, pending: false, askedAt: 1_001_000, frozen: true });
	});
});
