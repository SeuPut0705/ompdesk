import { describe, expect, it } from "vitest";
import { fillText } from "../shared/fill-text";
import {
	askBackgroundWork,
	type BackgroundWorkMember,
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

const member = (key: string, answer: () => Promise<unknown>): BackgroundWorkMember => ({
	key,
	request: async method => {
		expect(method).toBe("composer.jobs");
		return answer();
	},
});

describe("askBackgroundWork", () => {
	it("merges the running work of every omp", async () => {
		const a = member("a", async () => [job("task", "LayoutSplit")]);
		const b = member("b", async () => [job("bash", "dev server")]);
		expect(await askBackgroundWork(() => [a, b])).toMatchObject({ subagents: 1, jobs: 1 });
	});

	it("counts an omp whose answer failed or never came as unknown work", async () => {
		const ok = member("ok", async () => [job("task", "A")]);
		const broken = member("broken", async () => {
			throw new Error("gui-bridge not connected");
		});
		const hung = member("hung", () => new Promise(() => {}));
		const junk = member("junk", async () => "not rows");
		const work = await askBackgroundWork(() => [broken, hung, junk, ok], 20);
		expect(work).toMatchObject({ subagents: 1, jobs: 0, unknown: 2, subagentLabels: ["A"] });
		expect(hasBackgroundWork(await askBackgroundWork(() => [hung], 20))).toBe(true);
	});

	it("never throws, and reads unknown work, when listing the omps does", async () => {
		const work = await askBackgroundWork(() => {
			throw new Error("pool gone");
		});
		expect(work.unknown).toBe(1);
	});

	it("says none when no omp runs", async () => {
		expect(await askBackgroundWork(() => [])).toBe(NO_BACKGROUND_WORK);
	});
});
