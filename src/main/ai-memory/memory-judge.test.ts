import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelResult } from "./distill-model";
import {
	chainJudges,
	JEV_MIN_CONFIDENCE,
	jevJudge,
	jevRequest,
	jevVerdict,
	type PageDigest,
	type PagePair,
	type PairJudge,
	pageText,
	parseSmolVerdicts,
	smolJudge,
	smolMessage,
} from "./memory-judge";

const page = (title: string, saved: string, text = "body"): PageDigest => ({
	path: `decisions/${title}.md`,
	title,
	kind: "decision",
	saved,
	scope: "project",
	text,
});
const pair = (a = "old", b = "new"): PagePair => ({ a: page(a, "2026-10-18"), b: page(b, "2026-10-19") });

describe("pageText", () => {
	it("drops the H1 and the source line and folds whitespace", () => {
		expect(pageText("# Title\n\nFirst   line\nsecond.\n\n_Source: the owner's messages #1 (memory upkeep)._")).toBe(
			"First line second.",
		);
	});

	it("cuts a long body", () => {
		expect(pageText(`# T\n\n${"x".repeat(5000)}`).length).toBe(600);
	});
});

describe("parseSmolVerdicts", () => {
	const answer = (pairs: unknown) => JSON.stringify({ pairs });

	it("reads one verdict per shown id", () => {
		expect(
			parseSmolVerdicts(
				answer([
					{ id: "p2", relation: "a_outdated" },
					{ id: "p1", relation: "unrelated" },
				]),
				2,
			).map(verdict => verdict?.relation),
		).toEqual(["unrelated", "a_outdated"]);
	});

	it("accepts the object in one code fence", () => {
		expect(
			parseSmolVerdicts(`\`\`\`json\n${answer([{ id: "p1", relation: "duplicate" }])}\n\`\`\``, 1)[0]?.relation,
		).toBe("duplicate");
	});

	it("leaves everything undecided when the text is not one JSON object", () => {
		expect(parseSmolVerdicts("Sure! Here you go: {}", 2)).toEqual([null, null]);
		expect(parseSmolVerdicts(`${answer([{ id: "p1", relation: "duplicate" }])} thanks`, 1)).toEqual([null]);
		expect(parseSmolVerdicts("[]", 1)).toEqual([null]);
	});

	it("refuses an unknown relation, an id never shown and a pair answered twice", () => {
		const verdicts = parseSmolVerdicts(
			answer([
				{ id: "p1", relation: "obsolete" },
				{ id: "p9", relation: "duplicate" },
				{ id: "p2", relation: "duplicate" },
				{ id: "p2", relation: "unrelated" },
				{ id: "p3", relation: "a_outdated" },
			]),
			3,
		);
		expect(verdicts.map(verdict => verdict?.relation ?? null)).toEqual([null, null, "a_outdated"]);
	});
});

describe("smolMessage", () => {
	it("numbers the pairs, marks older and newer, and adds the rules outline only when there is one", () => {
		const withRules = smolMessage([pair("pairing code", "tailscale")], "## Tailscale\n- No pairing code");
		expect(withRules.user).toContain("p1");
		expect(withRules.user).toContain("A (2026-10-18");
		expect(withRules.user).toContain("B (2026-10-19");
		expect(withRules.user).toContain("No pairing code");
		expect(smolMessage([pair()], "").user).not.toContain("rules file");
		expect(withRules.system).toContain("When you are not sure");
	});
});

describe("jevVerdict", () => {
	const answers = (choice: string, probability: number) => ({
		relation: { type: "choice", choice, probabilities: { [choice]: probability }, confidence: 0.9 },
	});

	it("maps the choice and applies the confidence bar", () => {
		expect(jevVerdict(answers("A_outdated", 0.96))).toEqual({ relation: "a_outdated", confidence: 0.96 });
		expect(jevVerdict(answers("duplicate", JEV_MIN_CONFIDENCE - 0.01))).toBeNull();
		expect(jevVerdict(answers("duplicate", JEV_MIN_CONFIDENCE))?.relation).toBe("duplicate");
	});

	it("reads anything else as no verdict", () => {
		expect(jevVerdict(null)).toBeNull();
		expect(jevVerdict({ relation: { type: "noul", noul: 0.9 } })).toBeNull();
		expect(jevVerdict(answers("nonsense", 0.99))).toBeNull();
		expect(jevVerdict(answers("constructor", 0.99))).toBeNull();
	});
});

describe("jevRequest", () => {
	it("puts both notes, older first, and never the rules outline", () => {
		const request = jevRequest(pair());
		expect(Object.keys(request.questions)).toEqual(["relation"]);
		expect(request.state.noteA.saved).toBe("2026-10-18");
		expect(request.state.noteB.saved).toBe("2026-10-19");
		expect(request.state).not.toHaveProperty("currentRules");
	});
});

describe("smolJudge", () => {
	const result = (text: string): ModelResult => ({
		text,
		model: "pi/smol",
		inputTokens: 10,
		outputTokens: 5,
		costUsd: 0.002,
	});

	it("makes one call for all pairs and reports its cost", async () => {
		const calls: string[] = [];
		const judge = smolJudge({
			model: async message => {
				calls.push(message.user);
				return result(
					JSON.stringify({
						pairs: [
							{ id: "p1", relation: "duplicate" },
							{ id: "p2", relation: "unrelated" },
						],
					}),
				);
			},
		});
		const judgment = await judge([pair("a1", "b1"), pair("a2", "b2")], "");
		expect(calls).toHaveLength(1);
		expect(judgment?.by).toBe("smol");
		expect(judgment?.verdicts.map(verdict => verdict?.relation)).toEqual(["duplicate", "unrelated"]);
		expect(judgment?.costUsd).toBe(0.002);
	});

	it("did not decide when omp fails or answers prose", async () => {
		expect(
			await smolJudge({ model: async () => Promise.reject(new Error("omp exited 1")) })([pair()], ""),
		).toBeNull();
		expect(await smolJudge({ model: async () => result("I think they differ") })([pair()], "")).toBeNull();
	});

	it("asks nothing for no pairs", async () => {
		let called = false;
		const judge = smolJudge({
			model: async () => {
				called = true;
				return result("{}");
			},
		});
		expect(await judge([], "")).toBeNull();
		expect(called).toBe(false);
	});
});

describe("chainJudges", () => {
	const answering =
		(by: "jev" | "smol", decided: boolean[], seen: number[]): PairJudge =>
		async pairs => {
			seen.push(pairs.length);
			return {
				by,
				verdicts: decided.map(yes => (yes ? { relation: "duplicate", confidence: 0.9 } : null)),
				model: by,
				costUsd: 1,
				ms: 1,
			};
		};

	it("uses the first judge that answers for the whole batch and does not ask a later one about pairs it left undecided", async () => {
		const jevSeen: number[] = [];
		const smolSeen: number[] = [];
		const judgment = await chainJudges(
			answering("jev", [true, false, true], jevSeen),
			answering("smol", [true, true, true], smolSeen),
		)([pair(), pair(), pair()], "");
		expect(jevSeen).toEqual([3]);
		expect(smolSeen).toEqual([]);
		expect(judgment?.by).toBe("jev");
		expect(judgment?.verdicts.map(verdict => verdict?.relation ?? null)).toEqual(["duplicate", null, "duplicate"]);
		expect(judgment?.costUsd).toBe(1);
	});

	it("goes on to the next judge when one did not answer at all", async () => {
		const smolSeen: number[] = [];
		const judgment = await chainJudges(async () => null, answering("smol", [true], smolSeen))([pair()], "");
		expect(judgment?.by).toBe("smol");
		expect(smolSeen).toEqual([1]);
	});

	it("did not decide when no judge decided", async () => {
		expect(
			await chainJudges(
				async () => null,
				async () => null,
			)([pair()], ""),
		).toBeNull();
	});
});

describe.skipIf(process.platform === "win32")("jevJudge", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	/** An `omp` that is a shell script: it records its argv and writes `output` where the host would. */
	function fakeOmp(output: unknown) {
		const dir = mkdtempSync(join(tmpdir(), "memory-judge-test-"));
		dirs.push(dir);
		const bin = join(dir, "omp");
		writeFileSync(
			bin,
			`#!/bin/sh\necho "$@" > "${dir}/argv"\ncp "$OMP_GUI_MEMORY_JUDGE_IN" "${dir}/in.json"\nprintf '%s' '${JSON.stringify(output)}' > "$OMP_GUI_MEMORY_JUDGE_OUT"\n`,
		);
		chmodSync(bin, 0o755);
		return { bin, dir };
	}

	const answered = (choice: string, probability: number) => ({
		available: true,
		results: [
			{
				id: "0",
				ms: 5,
				answers: {
					relation: { type: "choice", choice, probabilities: { [choice]: probability }, confidence: 0.9 },
				},
			},
		],
		usage: [{ model: "typesafe/jev-1.14", usage: { cost: { total: 0.00002 } } }],
	});

	it("runs the host omp with the bridge file and returns its verdicts and cost", async () => {
		const { bin, dir } = fakeOmp(answered("A_outdated", 0.95));
		const judgment = await jevJudge({
			omp: { bin },
			hostFile: "/x/memory-judge-host.ts",
			enabled: () => true,
			cwd: dir,
		})([pair()], "- rules");
		expect(judgment).toMatchObject({ by: "jev", model: "typesafe/jev-1.14", costUsd: 0.00002 });
		expect(judgment?.verdicts[0]).toEqual({ relation: "a_outdated", confidence: 0.95 });
		expect(readFileSync(join(dir, "argv"), "utf8")).toContain(
			"--mode rpc --no-session --no-extensions --no-skills --no-rules -e /x/memory-judge-host.ts",
		);
		const input = JSON.parse(readFileSync(join(dir, "in.json"), "utf8"));
		expect(input.requests).toHaveLength(1);
		expect(input.requests[0].request.state.noteA.title).toBe("old");
		expect(JSON.stringify(input)).not.toContain("- rules");
	});

	it("did not decide with no native judge (the host says unavailable)", async () => {
		const { bin, dir } = fakeOmp({ available: false });
		expect(await jevJudge({ omp: { bin }, hostFile: "h", enabled: () => true, cwd: dir })([pair()], "")).toBeNull();
	});

	it("never starts omp while the judge switch is off", async () => {
		const { bin, dir } = fakeOmp(answered("duplicate", 0.99));
		expect(await jevJudge({ omp: { bin }, hostFile: "h", enabled: () => false, cwd: dir })([pair()], "")).toBeNull();
		expect(() => readFileSync(join(dir, "argv"))).toThrow();
	});

	it("did not decide when every answer is under the bar", async () => {
		const { bin, dir } = fakeOmp(answered("duplicate", 0.4));
		expect(await jevJudge({ omp: { bin }, hostFile: "h", enabled: () => true, cwd: dir })([pair()], "")).toBeNull();
	});
});
