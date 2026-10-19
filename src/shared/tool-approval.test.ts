import { describe, expect, it } from "vitest";
import { approvalChoices, isApprovalSelect } from "./tool-approval";

// Stock's own shapes are pinned by src/main/tool-approval-stock.test.ts; these are the selects that only look alike.
describe("tool approval select", () => {
	const approval = { method: "select", title: "Allow tool: bash\nls", options: ["Approve", "Deny"] };

	it("refuses a select that is not stock's approval", () => {
		expect(isApprovalSelect({ ...approval, options: ["Approve", "Deny", "Always"] })).toBe(false);
		expect(isApprovalSelect({ ...approval, options: ["Approve", "Always approve", "Deny"] })).toBe(false);
		expect(isApprovalSelect({ ...approval, options: ["Approve", "Approve  for this session", "Deny"] })).toBe(false);
		expect(isApprovalSelect({ ...approval, options: ["Deny", "Approve"] })).toBe(false);
		expect(isApprovalSelect({ ...approval, title: "Pick one" })).toBe(false);
		expect(isApprovalSelect({ ...approval, method: "confirm" })).toBe(false);
		expect(approvalChoices({ ...approval, title: "Pick one" })).toBeUndefined();
		// A grant list stock never builds: an "Always" label with no grant of its own, or a grant without its always.
		expect(
			isApprovalSelect({
				...approval,
				options: ["Approve File", "Always Approve Directory: ~/x", "Approve Once", "Deny"],
			}),
		).toBe(false);
		expect(isApprovalSelect({ ...approval, options: ["Approve File", "Approve Once", "Deny"] })).toBe(false);
		expect(
			isApprovalSelect({ ...approval, options: ["Approve File", "Always Approve File", "Approve", "Deny"] }),
		).toBe(false);
	});
});
