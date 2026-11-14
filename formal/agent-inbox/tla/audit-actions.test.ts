import { describe, expect, test } from "bun:test";
import { auditActions } from "./audit-actions";

const model = (action: string, variables = "x, y", next = "A") => `
VARIABLES ${variables}
vars == <<${variables}>>
Init == /\\ x = 0 /\\ y = 0
${action}
Next == ${next}
`;

describe("native inbox successor coverage audit", () => {
	test("reports newly introduced state omitted from an existing action", () => {
		const report = auditActions(model("A == /\\ x' = x + 1 /\\ UNCHANGED <<y>>", "x, y, newState"));
		expect(report.ok).toBe(false);
		expect(report.actions).toEqual([{ name: "A", assigned: ["x"], unchanged: ["y"], missing: ["newState"], repeated: [] }]);
	});

	test("accepts a complete parameterized Next action without counting its local binder as state", () => {
		const report = auditActions(model("A(id) == /\\ x' = id /\\ UNCHANGED <<y>>", "x, y", "(\\E id \\in {1, 2} : A(id))"));
		expect(report).toEqual({ variables: ["x", "y"], actions: [{ name: "A", assigned: ["x"], unchanged: ["y"], missing: [], repeated: [] }], ok: true });
	});

	test("does not mistake comment or string references for successor assignments", () => {
		const report = auditActions(model(`A == /\\ x' = x /\\ y = "y' = y" \\* UNCHANGED <<y>>
(* nested (* y' = y *) comment *)`));
		expect(report.actions[0].missing).toEqual(["y"]);
		expect(report.ok).toBe(false);
	});

	test("audits a Next action with no successor clauses rather than silently excluding it", () => {
		const report = auditActions(model("A == x > 0"));
		expect(report.actions[0].missing).toEqual(["x", "y"]);
		expect(report.ok).toBe(false);
	});

	test("reports state assigned and held unchanged by the same action", () => {
		const report = auditActions(model("A == /\\ x' = x + 1 /\\ UNCHANGED <<x, y>>"));
		expect(report.actions[0].repeated).toEqual(["x"]);
		expect(report.ok).toBe(false);
	});

	test("refuses unsupported tuple expressions instead of claiming complete coverage", () => {
		expect(() => auditActions(model("A == /\\ x' = x /\\ UNCHANGED <<y + 1>>"))).toThrow("plain state-variable");
	});
});
