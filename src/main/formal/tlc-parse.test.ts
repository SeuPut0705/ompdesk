/**
 * TLC's text output (recorded from TLC 2026.10.28 on the job-lease example and two tiny specs, `fixtures/`) read into
 * results, reduced to the variables that changed per step, and mapped to code through `@code` comments.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { indexDefinitions } from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/code-tags";
import {
	describeOutcome,
	formatTrace,
	parseTlcOutput,
	reduceTrace,
} from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/tlc-parse";

const fixture = (name: string): string => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");
const definitions = indexDefinitions(fixture("JobLease.tla"));

describe("parseTlcOutput", () => {
	it("reads a pass with its statistics and no trace", () => {
		const result = parseTlcOutput(fixture("tlc-pass.txt"), 0);
		expect(result.outcome).toBe("pass");
		expect(result.stats).toEqual({ generated: 43, distinct: 25, queue: 0, depth: 7 });
		expect(result.trace).toEqual([]);
		expect(result.property).toBeUndefined();
	});

	it("also recognises a pass from the text alone", () => {
		expect(parseTlcOutput(fixture("tlc-pass.txt")).outcome).toBe("pass");
	});

	it("reads an invariant violation: the property, six states, the failing step last", () => {
		const result = parseTlcOutput(fixture("tlc-invariant.txt"), 12);
		expect(result.outcome).toBe("invariant");
		expect(result.property).toBe("SingleCommit");
		expect(describeOutcome(result)).toBe("invariant violated: SingleCommit");
		expect(result.trace.map(state => state.index)).toEqual([1, 2, 3, 4, 5, 6]);
		expect(result.trace.map(state => state.actionText)).toEqual([
			undefined,
			"Claim(w1)",
			"Expire",
			"Claim(w2)",
			"Commit(w1)",
			"Commit(w2)",
		]);
		expect(result.trace[1]?.action).toBe("Claim");
		expect(result.trace[1]?.location).toEqual({ module: "JobLease", line: 31, col: 5, endLine: 36, endCol: 37 });
		expect(result.trace[5]?.vars.commits).toBe("{w1, w2}");
		expect(result.stats.depth).toBe(6);
	});

	it("reads a deadlock", () => {
		const result = parseTlcOutput(fixture("tlc-deadlock.txt"), 11);
		expect(result.outcome).toBe("deadlock");
		expect(result.property).toBeUndefined();
		expect(result.trace).toHaveLength(3);
	});

	it("reads a liveness failure that ends in stuttering", () => {
		const result = parseTlcOutput(fixture("tlc-temporal.txt"), 13);
		expect(result.outcome).toBe("temporal");
		expect(result.property).toBe("ClaimedEventuallyDone");
		expect(result.lasso).toEqual({ stuttering: true });
		expect(result.trace.at(-1)?.kind).toBe("stuttering");
	});

	it("reads a liveness failure that goes back to an earlier state, with a single-variable spec", () => {
		const result = parseTlcOutput(fixture("tlc-lasso.txt"), 13);
		expect(result.outcome).toBe("temporal");
		expect(result.property).toBe("NeverDone");
		expect(result.lasso).toEqual({ stuttering: false, backTo: 1 });
		expect(result.trace.filter(state => state.kind !== "back").map(state => state.vars.x)).toEqual(["0", "1", "2"]);
	});

	it("tells a parse error and a configuration error from a violation", () => {
		const parse = parseTlcOutput(fixture("tlc-parse-error.txt"), 150);
		expect(parse.outcome).toBe("parse-error");
		expect(parse.trace).toEqual([]);
		const config = parseTlcOutput(fixture("tlc-config-error.txt"), 151);
		expect(config.outcome).toBe("parse-error");
		expect(config.message).toContain("The invariant Missing");
	});

	it("falls back to the exit code when TLC names nothing, and never throws on junk", () => {
		expect(parseTlcOutput("", 12).outcome).toBe("invariant");
		expect(parseTlcOutput("", 13).outcome).toBe("temporal");
		expect(parseTlcOutput("", 75).outcome).toBe("error");
		expect(parseTlcOutput("\u0000 not tlc output at all", 1).outcome).toBe("error");
		expect(parseTlcOutput("State 1: <Initial predicate>\n/\\ x = ", 12).trace).toHaveLength(1);
	});

	it("joins a value TLC wrapped over several lines", () => {
		const text = [
			"Error: Invariant Inv is violated.",
			"Error: The behavior up to this point is:",
			"State 1: <Initial predicate>",
			"/\\ db = [a |-> 1,",
			"         b |-> {2,",
			"                3}]",
			"/\\ n = 0",
			"",
		].join("\n");
		const [state] = parseTlcOutput(text, 12).trace;
		expect(state?.vars.db).toBe("[a |-> 1, b |-> {2, 3}]");
		expect(state?.vars.n).toBe("0");
	});
});

describe("reduceTrace", () => {
	const result = parseTlcOutput(fixture("tlc-invariant.txt"), 12);
	const rows = reduceTrace(result.trace, { definitions: () => definitions, outcome: result.outcome });

	it("shows only the variables that changed, all of them for the first state", () => {
		expect(Object.keys(rows[0]?.changed ?? {}).sort()).toEqual(
			["commits", "expired", "jobDone", "owner", "token", "wpc", "wtok"].sort(),
		);
		expect(rows[2]?.step).toBe("Expire");
		expect(rows[2]?.changed).toEqual({ expired: { from: "FALSE", to: "TRUE" } });
		expect(rows[5]?.changed).toEqual({
			wpc: { from: '(w1 :> "done" @@ w2 :> "working")', to: '(w1 :> "done" @@ w2 :> "done")' },
			commits: { from: "{w1}", to: "{w1, w2}" },
		});
	});

	it("maps each action to the code its @code comment names, and none to an environment step", () => {
		expect(rows.map(row => row.code)).toEqual([
			[],
			["src/worker.ts:12-13"],
			[],
			["src/worker.ts:12-13"],
			["src/worker.ts:17-19"],
			["src/worker.ts:17-19"],
		]);
	});

	it("marks the step where the invariant breaks", () => {
		expect(rows.map(row => row.violation === true)).toEqual([false, false, false, false, false, true]);
		const text = formatTrace(rows, result);
		expect(text).toContain("#6  Commit(w2)   [src/worker.ts:17-19]   <-- violation");
		expect(text).toContain("commits: {w1}  ->  {w1, w2}");
	});

	it("marks the last real state of a liveness failure and says how the behavior ends", () => {
		const temporal = parseTlcOutput(fixture("tlc-temporal.txt"), 13);
		const temporalRows = reduceTrace(temporal.trace, { outcome: temporal.outcome });
		expect(temporalRows.find(row => row.violation)?.n).toBe(6);
		expect(temporalRows.at(-1)?.step).toBe("Stuttering");
		expect(formatTrace(temporalRows, temporal)).toContain("stutters forever");
		const lasso = parseTlcOutput(fixture("tlc-lasso.txt"), 13);
		expect(formatTrace(reduceTrace(lasso.trace, { outcome: lasso.outcome }), lasso)).toContain(
			"repeats from state 1",
		);
	});
});
