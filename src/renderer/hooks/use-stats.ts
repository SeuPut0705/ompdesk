import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFocusedTabDevice } from "../stores/remote";

const POLL_INTERVAL_MS = 30_000;
/** While the bundled stats server is still booting, retry quickly instead of waiting a full poll tick. */
const STARTING_RETRY_MS = 2_000;
/** A normal boot answers within a few seconds; past this the section says the server is down. */
const STARTING_BUDGET_MS = 8_000;
/** Once the down state shows, keep asking (main revives the server on these reads) so a late server still appears. */
const DOWN_RETRY_MS = 5_000;
/**
 * Each machine's current stats outage (first and latest down reply), shared by
 * every section: one opened while the server is known to be down says so at
 * once instead of spinning through the boot budget again. Cleared by any
 * answer; an outage nobody has asked about for a poll interval is over.
 */
const outageByDevice = new Map<string, { since: number; seen: number }>();

interface StatsState<T> {
	key: string;
	data: T | null;
	isLoading: boolean;
	error: string | null;
	/** `error` is main's localized "stats server is not answering" sentence, not a raw failure. */
	serverDown: boolean;
	updatedAt: number | null;
}

/** Main's down-state reply (`{error, unavailable, stopped?}`); `stopped` = no revive left this run. */
function downReply(result: unknown): { message: string; stopped: boolean } | null {
	if (!result || typeof result !== "object") return null;
	const reply = result as { error?: unknown; unavailable?: unknown; stopped?: unknown };
	if (reply.unavailable !== true && reply.stopped !== true) return null;
	return { message: typeof reply.error === "string" ? reply.error : "", stopped: reply.stopped === true };
}

/**
 * One visible query at a time; stale responses never cross a path/range
 * boundary. The stats come from the focused tab's machine: a paired host's
 * own stats server when the tab runs there.
 */
function useStatsResource<T>(path: string, params: Record<string, string> | undefined, expectList: boolean) {
	const device = useFocusedTabDevice();
	const sortedParams = Object.entries(params ?? {}).sort(([a], [b]) => a.localeCompare(b));
	const serializedParams = JSON.stringify(sortedParams);
	// biome-ignore lint/correctness/useExhaustiveDependencies: serializedParams is the semantic key for this freshly rebuilt entries array.
	const queryParams = useMemo(() => Object.fromEntries(sortedParams), [serializedParams]);
	const key = `${device ?? ""}|${path}:${serializedParams}`;
	const [state, setState] = useState<StatsState<T>>({
		key,
		data: null,
		isLoading: true,
		error: null,
		serverDown: false,
		updatedAt: null,
	});
	const fetchRef = useRef<() => void>(() => {});
	const refetch = useCallback(() => fetchRef.current(), []);

	useEffect(() => {
		let active = true;
		let inFlight = false;
		let retryTimer: number | undefined;
		const deviceKey = device ?? "";
		/** `quiet`: a background read (poll, down-state retry) leaves the shown state alone until it answers. */
		const load = async (quiet = false) => {
			if (!active || inFlight) return;
			inFlight = true;
			if (retryTimer !== undefined) window.clearTimeout(retryTimer);
			retryTimer = undefined;
			if (!quiet) {
				setState(previous =>
					previous.key === key
						? { ...previous, isLoading: previous.data === null }
						: { key, data: null, isLoading: true, error: null, serverDown: false, updatedAt: null },
				);
			}
			try {
				const result = await window.omp.stats.fetch(path, queryParams, device);
				const down = downReply(result);
				if (down) {
					// Booting: stay in the loading state for a few seconds. Past that the
					// section says so (with a retry), and the reads keep going in the
					// background so a server that binds late still fills it on its own.
					const now = Date.now();
					const outage = outageByDevice.get(deviceKey);
					const since = outage && now - outage.seen <= POLL_INTERVAL_MS ? outage.since : now;
					if (!down.stopped) outageByDevice.set(deviceKey, { since, seen: now });
					const booting = !down.stopped && now - since <= STARTING_BUDGET_MS;
					if (!active) return;
					setState(previous =>
						booting
							? { ...previous, isLoading: true, error: null, serverDown: false }
							: { ...previous, isLoading: false, error: down.message, serverDown: true },
					);
					if (!down.stopped) {
						retryTimer = window.setTimeout(
							() => {
								if (active) void load(true);
							},
							booting ? STARTING_RETRY_MS : DOWN_RETRY_MS,
						);
					}
					return;
				}
				if (result && typeof result === "object" && "error" in result && typeof result.error === "string")
					throw new Error(result.error);
				if (expectList && !Array.isArray(result))
					throw new Error(`${path} did not return a list (${result === null ? "null" : typeof result})`);
				outageByDevice.delete(deviceKey);
				if (active)
					setState({
						key,
						data: result as T,
						isLoading: false,
						error: null,
						serverDown: false,
						updatedAt: Date.now(),
					});
			} catch (cause) {
				const message = cause instanceof Error ? cause.message : String(cause);
				if (active) setState(previous => ({ ...previous, isLoading: false, error: message, serverDown: false }));
			} finally {
				inFlight = false;
			}
		};
		fetchRef.current = () => void load();
		const refreshVisible = () => {
			if (document.visibilityState !== "hidden") void load(true);
		};
		void load();
		const timer = window.setInterval(refreshVisible, POLL_INTERVAL_MS);
		document.addEventListener("visibilitychange", refreshVisible);
		return () => {
			active = false;
			if (retryTimer !== undefined) window.clearTimeout(retryTimer);
			window.clearInterval(timer);
			document.removeEventListener("visibilitychange", refreshVisible);
		};
	}, [device, expectList, key, path, queryParams]);

	return state.key === key
		? { ...state, refetch }
		: { key, data: null, isLoading: true, error: null, serverDown: false, updatedAt: null, refetch };
}

export function useStats<T>(path: string, params?: Record<string, string>) {
	return useStatsResource<T>(path, params, false);
}

/** Endpoints whose contract is a bare JSON array; a wrong-shaped reply is an error state, not rows. */
export function useStatsList<T>(path: string, params?: Record<string, string>) {
	return useStatsResource<T[]>(path, params, true);
}
