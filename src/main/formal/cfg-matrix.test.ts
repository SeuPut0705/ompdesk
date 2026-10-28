import { describe, expect, it } from "vitest";
import {
	overrideConstants,
	parseCfg,
} from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/cfg";
import {
	judge,
	parseMatrix,
} from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/matrix";
import type { TlcResult } from "../../../resources/omp-builtin/formal/skills/ompdesk-formal-verify/scripts/lib/tlc-parse";

const CFG = `\\* a comment
CONSTANTS
    Workers = {w1, w2}
    UseFencing = TRUE
    MaxClaims = 3
SPECIFICATION Spec
INVARIANTS
    TypeOK
    SingleCommit
PROPERTIES
    ClaimedEventuallyDone
CHECK_DEADLOCK FALSE
`;

describe("cfg", () => {
	it("lists the invariants, properties, constants and the deadlock switch", () => {
		expect(parseCfg(CFG)).toEqual({
			invariants: ["TypeOK", "SingleCommit"],
			properties: ["ClaimedEventuallyDone"],
			checkDeadlock: false,
			constants: { Workers: "{w1, w2}", UseFencing: "TRUE", MaxClaims: "3" },
		});
		expect(parseCfg("SPECIFICATION Spec\nINVARIANT A B\n").invariants).toEqual(["A", "B"]);
	});

	it("overrides constants and keeps everything else", () => {
		const text = overrideConstants(CFG, { Workers: "{w1, w2, w3}", Extra: "1" });
		const parsed = parseCfg(text);
		expect(parsed.constants).toEqual({ UseFencing: "TRUE", MaxClaims: "3", Workers: "{w1, w2, w3}", Extra: "1" });
		expect(parsed.invariants).toEqual(["TypeOK", "SingleCommit"]);
		expect(parsed.properties).toEqual(["ClaimedEventuallyDone"]);
		expect(parsed.checkDeadlock).toBe(false);
		expect(text.match(/Workers/g)).toHaveLength(1);
	});

	it("handles the one-line CONSTANT form and a set that wraps over lines", () => {
		const text = overrideConstants("CONSTANT N = 2\nCONSTANTS\n  S = {a,\n       b}\n  T = 1\nINIT I\nNEXT N\n", {
			S: "{c}",
		});
		expect(parseCfg(text).constants).toEqual({ N: "2", T: "1", S: "{c}" });
		expect(text).not.toContain("b}");
	});
});

describe("matrix", () => {
	it("validates runs", () => {
		expect(
			parseMatrix({ runs: [{ name: "a" }, { name: "b", config: "X.cfg", expect: "violation", workers: 4 }] }),
		).toEqual([
			{ name: "a", expect: "pass" },
			{ name: "b", expect: "violation", config: "X.cfg", workers: "4" },
		]);
		expect(() => parseMatrix({})).toThrow(/runs/);
		expect(() => parseMatrix({ runs: [{ name: "a" }, { name: "a" }] })).toThrow(/duplicate/);
		expect(() => parseMatrix({ runs: [{ name: "a", expect: "maybe" }] })).toThrow(/expect/);
		expect(() => parseMatrix({ runs: [{ name: "a", constants: { N: 3 } }] })).toThrow(/constants/);
	});

	const result = (outcome: TlcResult["outcome"], property?: string): TlcResult => ({
		outcome,
		...(property ? { property } : {}),
		stats: {},
		trace: [],
		errors: [],
		warnings: [],
	});

	it("judges a run against what the matrix expected", () => {
		expect(judge({ expect: "pass" }, result("pass")).ok).toBe(true);
		expect(judge({ expect: "pass" }, result("invariant", "A")).ok).toBe(false);
		expect(judge({ expect: "violation" }, result("deadlock")).ok).toBe(true);
		expect(judge({ expect: "violation" }, result("pass")).ok).toBe(false);
		expect(judge({ expect: "violation" }, result("parse-error")).ok).toBe(false);
		expect(judge({ expect: "invariant", property: "A" }, result("invariant", "A")).ok).toBe(true);
		expect(judge({ expect: "invariant", property: "A" }, result("invariant", "B")).reason).toContain(
			"got invariant B",
		);
		expect(judge({ expect: "temporal" }, result("action", "P")).ok).toBe(false);
		expect(judge({ expect: "violation", property: "deadlock" }, result("deadlock")).ok).toBe(true);
	});
});
