import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelResult } from "./distill-model";
import { jevJudge, type PageDigest, type PagePair, smolJudge } from "./memory-judge";

const page = (title: string, saved: string, text = "body"): PageDigest => ({
	path: `decisions/${title}.md`,
	title,
	kind: "decision",
	saved,
	scope: "project",
	text,
});
const pair = (a = "old", b = "new"): PagePair => ({ a: page(a, "2026-10-18"), b: page(b, "2026-10-19") });

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
