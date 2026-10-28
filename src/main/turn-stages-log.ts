/**
 * The bridge's `turn_stages` frame (resources/gui-bridge/turn-stages.ts, rules in its core) as one runtime-log line,
 * source `turn-stages`: a model call that waited long for its first output, or ended aborted or errored with none.
 * The frame comes from our own bridge; it is still read defensively, since a line that cannot be written is a lost
 * explanation, not an error to raise.
 */
import { TURN_STAGES_EVENT } from "../../resources/gui-bridge/turn-stages-contracts";
import type { RuntimeLogReport } from "./runtime-log-core";

export function turnStagesReport(frame: Record<string, unknown>): RuntimeLogReport | undefined {
	if (frame.type !== TURN_STAGES_EVENT || typeof frame.message !== "string") return undefined;
	const raw = frame.details;
	if (typeof raw !== "object" || raw === null) return { source: "turn-stages", message: frame.message };
	const details: Record<string, string | number | boolean> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") details[key] = value;
	}
	return { source: "turn-stages", message: frame.message, details };
}
