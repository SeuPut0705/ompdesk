/**
 * Run `callback` in an idle moment, at the latest after `timeoutMs`; returns the cancel. Safari (the iPhone and
 * iPad web client) has no `requestIdleCallback`, so there it is a timer of `FALLBACK_DELAY_MS`.
 */
const FALLBACK_DELAY_MS = 2000;

export function whenIdle(callback: () => void, timeoutMs: number): () => void {
	if (typeof requestIdleCallback === "function") {
		const handle = requestIdleCallback(callback, { timeout: timeoutMs });
		return () => cancelIdleCallback(handle);
	}
	const timer = setTimeout(callback, Math.min(FALLBACK_DELAY_MS, timeoutMs));
	return () => clearTimeout(timer);
}
