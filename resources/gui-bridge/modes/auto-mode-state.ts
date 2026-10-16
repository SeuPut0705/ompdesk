/**
 * Per-session memory of the automatic mode choice: what the user's own actions ruled out. Dependency-free (plan.ts
 * writes it, modes/auto-mode.ts reads it). Keyed by the transcript id, so a new or switched session starts clean.
 */
interface Flags {
	planRejected: boolean;
	suppressed: boolean;
}

const sessions = new Map<string, Flags>();
const KEPT = 50;

function flags(sessionId: string): Flags {
	let entry = sessions.get(sessionId);
	if (!entry) {
		entry = { planRejected: false, suppressed: false };
		sessions.set(sessionId, entry);
		if (sessions.size > KEPT) sessions.delete(sessions.keys().next().value as string);
	}
	return entry;
}

/** The user rejected a proposed plan: plan mode is never entered automatically again in this session. */
export function markPlanRejected(sessionId: string): void {
	flags(sessionId).planRejected = true;
}

/** The user undid an automatic decision: no automatic mode again in this session. */
export function markSuppressed(sessionId: string): void {
	flags(sessionId).suppressed = true;
}

export function autoModeFlags(sessionId: string): Readonly<Flags> {
	return sessions.get(sessionId) ?? { planRejected: false, suppressed: false };
}

export function resetAutoModeFlags(): void {
	sessions.clear();
}
