/**
 * Per-session memory of the automatic mode choice: what the user's own actions ruled out, and whether the plan mode
 * now on was entered for one request (an automatic plan ends with that plan). Dependency-free (plan.ts writes it,
 * modes/auto-mode.ts reads it). Keyed by the transcript id, so a new or switched session starts clean.
 */
interface Flags {
	planRejected: boolean;
	suppressed: boolean;
	autoPlan: boolean;
}

const sessions = new Map<string, Flags>();
const KEPT = 50;
const NONE: Readonly<Flags> = { planRejected: false, suppressed: false, autoPlan: false };

function flags(sessionId: string): Flags {
	let entry = sessions.get(sessionId);
	if (!entry) {
		entry = { ...NONE };
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

/** Plan mode was entered for one request (true) or is the user's own or off (false). */
export function setAutoPlan(sessionId: string, auto: boolean): void {
	if (auto || sessions.has(sessionId)) flags(sessionId).autoPlan = auto;
}

export function autoModeFlags(sessionId: string): Readonly<Flags> {
	return sessions.get(sessionId) ?? NONE;
}

export function resetAutoModeFlags(): void {
	sessions.clear();
}
