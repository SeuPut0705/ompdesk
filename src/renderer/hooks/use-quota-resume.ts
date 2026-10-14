import { useEffect, useState } from "react";
import { translate } from "../lib/i18n";
import { createTabRpc } from "../lib/tab-rpc";
import { QUOTA_RESUME_GRACE_MS, useQuotaResumeStore } from "../stores/quota-resume";
import { sessionRuntime } from "../stores/session-runtime-context";
import { useTabsStore } from "../stores/tabs";
import { toast, toastError } from "../stores/toast";

/** setTimeout's ceiling (about 24.8 days); a later booking re-arms when it fires. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Runs the usage-limit resume bookings (`stores/quota-resume.ts`): at a
 * booking's reset time, once its session's tab is open and idle, stock
 * `retry` runs the failed turn again. A booking whose session has moved on
 * (nothing left to retry) ends quietly. Mounted once, by App.
 */
export function useQuotaResume(): void {
	const reservations = useQuotaResumeStore(state => state.reservations);
	const tabs = useTabsStore(state => state.tabs);
	const [tick, setTick] = useState(0);

	useEffect(() => {
		void useQuotaResumeStore.getState().load();
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `tick` re-runs the check when the next booking falls due.
	useEffect(() => {
		const now = Date.now();
		const { cancel } = useQuotaResumeStore.getState();
		let next = Number.POSITIVE_INFINITY;
		for (const [sessionId, resetAt] of Object.entries(reservations)) {
			if (resetAt > now) {
				next = Math.min(next, resetAt);
				continue;
			}
			if (now - resetAt > QUOTA_RESUME_GRACE_MS) {
				cancel(sessionId);
				continue;
			}
			const tab = tabs.find(candidate => candidate.sessionId === sessionId && candidate.status === "ready");
			const runtime = tab ? sessionRuntime(tab.id) : null;
			if (!runtime) continue;
			cancel(sessionId);
			void createTabRpc(runtime.command)
				.retry()
				.then(response => {
					if (!response.success) throw new Error(response.error);
					const { data } = response;
					if (typeof data === "object" && data !== null && "retried" in data && data.retried === true)
						toast({ variant: "info", message: translate("turnError.resume.started") });
				})
				.catch(error => toastError({ title: translate("turnError.retryFailed"), error }));
		}
		if (next === Number.POSITIVE_INFINITY) return;
		const timer = setTimeout(() => setTick(value => value + 1), Math.min(next - now + 250, MAX_TIMER_MS));
		return () => clearTimeout(timer);
	}, [reservations, tabs, tick]);
}
