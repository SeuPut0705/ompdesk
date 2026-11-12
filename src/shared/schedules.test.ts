import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ScheduleDraft, scheduleDraftProblem } from "./schedules";

const draft: ScheduleDraft = {
	name: "Nightly review",
	prompt: "Review yesterday's commits",
	cwd: "/work/app",
	frequency: { kind: "daily", time: "09:30", days: [] },
	model: null,
	autoApprove: false,
	enabled: true,
};

describe("scheduleDraftProblem", () => {
	it("names the first field that keeps a draft from saving", () => {
		expect(scheduleDraftProblem(draft)).toBeNull();
		expect(scheduleDraftProblem({ ...draft, name: " " })).toBe("name");
		expect(scheduleDraftProblem({ ...draft, prompt: "" })).toBe("prompt");
		expect(scheduleDraftProblem({ ...draft, cwd: "relative/dir" })).toBe("cwd");
		expect(scheduleDraftProblem({ ...draft, cwd: "C:\\work" })).toBeNull();
		expect(scheduleDraftProblem({ ...draft, frequency: { kind: "interval", minutes: 2 } })).toBe("interval");
		expect(scheduleDraftProblem({ ...draft, frequency: { kind: "daily", time: "24:00", days: [] } })).toBe("time");
		expect(scheduleDraftProblem({ ...draft, frequency: { kind: "daily", time: "07:05", days: [7] } })).toBe("days");
	});

	it("answers every captured row as the core's copy does", () => {
		/** The rows the core's copy is held to (`crates/core/src/schedules/rules.rs`), captured from this one. */
		const captured: { draftProblem: { draft: ScheduleDraft; problem?: string | null; throws?: true }[] } = JSON.parse(
			readFileSync(join(__dirname, "../../native/ompdesk/crates/core/src/schedules/captured.json"), "utf8"),
		);
		expect(captured.draftProblem.length).toBeGreaterThan(150);
		for (const row of captured.draftProblem) {
			const told = JSON.stringify(row.draft);
			if (row.throws) expect(() => scheduleDraftProblem(row.draft), told).toThrow(TypeError);
			else expect(scheduleDraftProblem(row.draft), told).toBe(row.problem);
		}
	});
});
