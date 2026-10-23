/**
 * Where an idle session the caller opened left its work, read from what it said: its answer's verdict line and its
 * last report to the opener. An idle row alone says nothing about whether the work ended well, ended badly or was
 * dropped. Idea after OpenRig's pickup receipt, computed on read (mvschwarz/openrig,
 * docs/as-built/architecture/coordination-primitive.md, Apache-2.0), re-implemented on OMPdesk's own signals.
 */
import { parseWorkerResult } from "../../shared/agent-control";
import type { MailKind } from "./mail";

export interface PickupFacts {
	/** Its last answer, whose final line may be `Result: ok` / `Result: problem — <reason>`. */
	answer: string | null;
	/** Its last report to the opener, if any. */
	report?: { kind: MailKind; at: number };
	/** When its last turn started (epoch ms); a report from before it belongs to earlier work. */
	busySince?: number;
}

/** One short clause for an idle opened session's row, or null when nothing it said tells. */
export function pickupOf(facts: PickupFacts): string | null {
	const verdict = parseWorkerResult(facts.answer);
	if (verdict?.kind === "ok") return "finished: Result ok";
	if (verdict?.kind === "problem")
		return `finished with a problem${verdict.reason ? `: ${verdict.reason.slice(0, 160)}` : ""}`;
	const report = facts.report && facts.report.at >= (facts.busySince ?? 0) ? facts.report : undefined;
	if (report?.kind === "done" || report?.kind === "review") return `finished: reported ${report.kind}`;
	if (report?.kind === "blocked") return "stopped: reported blocked";
	if (!facts.answer) return "has not answered yet";
	return "ended its turn with no verdict line and no done report: read its answer, or ask it where the work stands";
}
