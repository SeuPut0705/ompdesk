import { useNowTick } from "../../../lib/now-tick";
import { useQuotaResumeStore } from "../../../stores/quota-resume";
import { useSessionStore } from "../../../stores/session";

/**
 * When this session's booked usage-limit resume falls due (epoch ms), or undefined with none booked. A run that
 * stopped on the quota keeps its Goal active, so the booking is what says it is waiting; it ends when `retry` runs.
 */
export function useAutopilotReservation(): number | undefined {
	const sessionId = useSessionStore(s => s.sessionId);
	const booked = useQuotaResumeStore(s => (sessionId ? s.reservations[sessionId] : undefined));
	const now = useNowTick(booked !== undefined);
	return booked !== undefined && booked > now ? booked : undefined;
}
