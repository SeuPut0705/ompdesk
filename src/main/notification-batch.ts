/**
 * Batched completion notifications. When several tabs of one window finish, fail or ask
 * within `BATCH_WINDOW_MS`, the user gets one summary ("3 tasks finished · 1 needs you")
 * instead of a banner per tab. Electron-free: the clock, the timer and the OS notification
 * are injected so tests drive it.
 *
 * The first event of a window shows at once (a lone event never waits) and opens a fixed
 * window. Followers are recorded silently; when the window ends with followers the first
 * banner is closed and one summary replaces it. Stock omp has no such thing (it is a TUI).
 */
import type { IpcNotifyKind } from "../shared/ipc-types";
import type { UiLanguage } from "../shared/ui-language";
import { MAIN_TEXT } from "./i18n-text";

export type NoticeKind = IpcNotifyKind;

export const BATCH_WINDOW_MS = 4000;
/** Tab titles named in a summary's body before "+N more". */
const BODY_TITLES = 3;

/** Higher wins: a tab that asked outranks one that failed, which outranks a finished one. */
const PRIORITY: Record<NoticeKind, number> = { completion: 0, error: 1, ask: 2 };

export interface BatchNotice {
	title: string;
	body?: string;
	tabId?: string;
	kind?: NoticeKind;
}

export interface ShownNotice {
	title: string;
	body: string;
	/** The tab a click switches to; null for a notification about no tab. */
	tabId: string | null;
}

export interface BatchCounts {
	finished: number;
	failed: number;
	asks: number;
}

/** What a shown notice is, for a sink that needs more than its text (Web Push filters and ranks by kind). */
export interface ShownInfo {
	/** A lone event's kind; a summary's is its strongest member's. */
	kind: NoticeKind;
	/** The tally a summary banner reports; null for a lone event. */
	summary: BatchCounts | null;
}

export interface BatcherDeps {
	/** Show one notification for a window; `close` withdraws it. `info` is null for a notice with no `kind`. */
	show: (windowId: number, notice: ShownNotice, info: ShownInfo | null) => { close: () => void };
	language: () => UiLanguage;
	setTimer: (fn: () => void, ms: number) => unknown;
	clearTimer: (handle: unknown) => void;
}

interface Entry {
	title: string;
	kind: NoticeKind;
	/** Arrival order of the entry's latest event, for "most recent first". */
	seq: number;
}

interface Batch {
	first: { close: () => void };
	entries: Map<string, Entry>;
	followers: number;
	timer: unknown;
}

function text(key: keyof typeof MAIN_TEXT, language: UiLanguage, params: Record<string, string | number>): string {
	return MAIN_TEXT[key][language].replace(/\{(\w+)\}/g, (match, name: string) =>
		name in params ? String(params[name]) : match,
	);
}

/** Title and body of the summary banner; `titles` are the tab titles, most important first. */
export function formatBatchSummary(
	counts: BatchCounts,
	titles: readonly string[],
	language: UiLanguage,
): { title: string; body: string } {
	const parts: string[] = [];
	if (counts.finished > 0) {
		const key = counts.finished === 1 ? "batch.finished.one" : "batch.finished.other";
		parts.push(text(key, language, { count: counts.finished }));
	}
	if (counts.failed > 0) parts.push(text("batch.failed", language, { count: counts.failed }));
	if (counts.asks > 0) {
		const key = counts.asks === 1 ? "batch.needsYou.one" : "batch.needsYou.other";
		parts.push(text(key, language, { count: counts.asks }));
	}
	const list = titles.slice(0, BODY_TITLES).join(", ");
	const rest = titles.length - BODY_TITLES;
	return {
		title: parts.join(" · "),
		body: rest > 0 ? text("batch.more", language, { list, count: rest }) : list,
	};
}

export class NotificationBatcher {
	readonly #deps: BatcherDeps;
	readonly #batches = new Map<number, Batch>();
	#seq = 0;

	constructor(deps: BatcherDeps) {
		this.#deps = deps;
	}

	/** `enabled` is the user's pref; without it, a `kind` or a tab, the notice shows as it always did. */
	notify(windowId: number, notice: BatchNotice, enabled: boolean): void {
		const shown: ShownNotice = { title: notice.title, body: notice.body ?? "", tabId: notice.tabId ?? null };
		const { kind, tabId } = notice;
		if (!enabled || !kind || !tabId) {
			this.#deps.show(windowId, shown, kind ? { kind, summary: null } : null);
			return;
		}
		const batch = this.#batches.get(windowId);
		if (!batch) {
			const first = this.#deps.show(windowId, shown, { kind, summary: null });
			const opened: Batch = {
				first,
				entries: new Map(),
				followers: 0,
				timer: this.#deps.setTimer(() => this.#settle(windowId), BATCH_WINDOW_MS),
			};
			this.#record(opened, tabId, notice.title, kind);
			this.#batches.set(windowId, opened);
			return;
		}
		batch.followers++;
		this.#record(batch, tabId, notice.title, kind);
	}

	/**
	 * A tab's ask was answered (or withdrawn) before its window ended: the summary must not count it. Only an ask
	 * entry goes; what the window already showed was closed by whoever retracted the ask.
	 */
	retract(windowId: number, tabId: string): void {
		const batch = this.#batches.get(windowId);
		if (batch?.entries.get(tabId)?.kind === "ask") batch.entries.delete(tabId);
	}

	/** A window closed: its pending summary has nobody to go to. */
	dropWindow(windowId: number): void {
		const batch = this.#batches.get(windowId);
		if (!batch) return;
		this.#deps.clearTimer(batch.timer);
		this.#batches.delete(windowId);
	}

	dispose(): void {
		for (const windowId of [...this.#batches.keys()]) this.dropWindow(windowId);
	}

	#record(batch: Batch, tabId: string, title: string, kind: NoticeKind): void {
		const previous = batch.entries.get(tabId);
		const winner = previous && PRIORITY[previous.kind] > PRIORITY[kind] ? previous.kind : kind;
		batch.entries.set(tabId, { title, kind: winner, seq: this.#seq++ });
	}

	#settle(windowId: number): void {
		const batch = this.#batches.get(windowId);
		if (!batch) return;
		this.#batches.delete(windowId);
		if (batch.followers === 0 || batch.entries.size === 0) return;
		const ranked = [...batch.entries].sort(([, a], [, b]) => PRIORITY[b.kind] - PRIORITY[a.kind] || b.seq - a.seq);
		const counts: BatchCounts = { finished: 0, failed: 0, asks: 0 };
		for (const [, entry] of ranked) {
			if (entry.kind === "ask") counts.asks++;
			else if (entry.kind === "error") counts.failed++;
			else counts.finished++;
		}
		const summary = formatBatchSummary(
			counts,
			ranked.map(([, entry]) => entry.title),
			this.#deps.language(),
		);
		batch.first.close();
		const strongest = ranked[0]?.[1].kind ?? "completion";
		this.#deps.show(windowId, { ...summary, tabId: ranked[0]?.[0] ?? null }, { kind: strongest, summary: counts });
	}
}
