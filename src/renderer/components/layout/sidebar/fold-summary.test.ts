import { describe, expect, it } from "vitest";
import { translate } from "../../../lib/i18n";
import { childFoldSignal, foldSummary, foldSummaryText, sessionFoldSignal } from "./fold-summary";

describe("sessionFoldSignal", () => {
	it("follows the row's own token: its own prompt, then its run, then an unseen finish", () => {
		expect(sessionFoldSignal({ waiting: "approval", running: false, done: false })).toBe("approval");
		expect(sessionFoldSignal({ waiting: undefined, running: true, done: false })).toBe("running");
		expect(sessionFoldSignal({ waiting: undefined, running: false, done: true })).toBe("done");
		expect(sessionFoldSignal({ waiting: undefined, running: false, done: false })).toBeNull();
	});

	it("leaves a waiting child to the child's own row, so one prompt counts once", () => {
		expect(sessionFoldSignal({ waiting: "childWaiting", running: false, done: false })).toBeNull();
		// Its own turn still runs while the child waits.
		expect(sessionFoldSignal({ waiting: "childWaiting", running: true, done: false })).toBe("running");
	});
});

describe("childFoldSignal", () => {
	it("counts an opened session that runs or waits, by its own prompt; failed, unmerged, finished and unrun ones are quiet", () => {
		expect(childFoldSignal({ status: "running" })).toBe("running");
		expect(childFoldSignal({ status: "waiting", ask: "approval" })).toBe("approval");
		// A host only knows a prompt waits: the row reads it as a question.
		expect(childFoldSignal({ status: "waiting" })).toBe("question");
		for (const status of ["failed", "unmerged", "done", null] as const)
			expect(childFoldSignal({ status })).toBeNull();
	});
});

describe("foldSummary", () => {
	it("counts each session once by its signal and keeps the first prompt's kind", () => {
		const summary = foldSummary(["running", "approval", "running", "question", "done", null, "running"]);
		expect(summary).toEqual({ running: 3, waiting: 2, done: 1, ask: "approval" });
	});

	it("is quiet when nothing inside works, waits or finished unseen", () => {
		const quiet = { waiting: 0, running: 0, done: 0, ask: null };
		expect(foldSummary([null, null])).toEqual(quiet);
		expect(foldSummary([])).toEqual(quiet);
	});
});

describe("foldSummaryText", () => {
	it("says one prompt by the row's word and several by their count, the work board's words", () => {
		expect(foldSummaryText(foldSummary(["approval", "running"]), translate)).toBe(
			`${translate("attention.approval")} · ${translate("workBoard.head.running", { count: 1 })}`,
		);
		expect(foldSummaryText(foldSummary(["question", "approval", "done", "done"]), translate)).toBe(
			`${translate("workBoard.head.needs", { count: 2 })} · ${translate("workBoard.doneFolded", { count: 2 })}`,
		);
		expect(foldSummaryText(foldSummary([null]), translate)).toBe("");
	});
});
