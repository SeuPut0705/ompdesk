/**
 * Resume-session picker: searchable list of on-disk sessions. Search mirrors
 * the TUI session-selector — literal matches first (recency order), then
 * subsequence fuzzy matches over title/firstMessage/cwd, then full-transcript
 * content hits from the main-process session-file grep. Scope toggles between
 * this folder and all projects (TUI Tab parity); sort and path display are
 * user options. Selection calls rpc.switchSession and rehydrates the renderer
 * stores. Follows the ModelPicker overlay pattern.
 */

import { ArrowDownAZ, Check, Clock, Folder, FolderTree, Globe, History, MessageCircle, RotateCw } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import type { SessionInfo } from "../../../shared/ipc-types";
import { requestSessionSwitch, switchSessionNow } from "../../hooks/use-session-switch";
import { type InlineFailure, inlineFailure } from "../../lib/error-detail";
import { formatTimeAgo, shortenPath } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { useProjectNames } from "../../lib/project-origin";
import { mergeContentMatches, rankSessions, type SessionSortMode } from "../../lib/session-search";
import { sessionDisplayTitle, sessionHasContent } from "../../lib/session-title";
import { useSessionStore } from "../../stores/session";
import { sessionListFeed } from "../../stores/session-list";
import { useTabsStore } from "../../stores/tabs";
import { useUiStore } from "../../stores/ui";
import {
	Badge,
	Button,
	IconButton,
	InlineNotice,
	Kbd,
	Modal,
	SearchField,
	SkeletonRows,
	Spinner,
	Tooltip,
} from "../common";

type SessionScope = "local" | "global";

/** Delay before the main-process content grep is consulted for the current query. */
const CONTENT_SEARCH_DEBOUNCE_MS = 200;
/** Minimum query length for content augmentation (single characters match everything). */
const CONTENT_SEARCH_MIN_QUERY = 2;

export function SessionPickerDialog() {
	const t = useT();
	const open = useUiStore(state => state.sessionPickerOpen);
	const close = useUiStore(state => state.closeSessionPicker);
	const sessionId = useSessionStore(state => state.sessionId);

	const [query, setQuery] = useState("");
	const [sessions, setSessions] = useState<SessionInfo[]>([]);
	const [scope, setScope] = useState<SessionScope>("global");
	const [sortMode, setSortMode] = useState<SessionSortMode>("recent");
	// null = follow the scope default (paths shown in all-projects scope).
	const [showPath, setShowPath] = useState<boolean | null>(null);
	const [loading, setLoading] = useState(false);
	const [switching, setSwitching] = useState<string | null>(null);
	const [error, setError] = useState<InlineFailure | null>(null);
	const [activeIndex, setActiveIndex] = useState(0);
	/** Transcript-only hits from the main-process grep: path → excerpt of the matching text. */
	const [contentHits, setContentHits] = useState<ReadonlyMap<string, string | undefined>>(new Map());
	const [contentPending, setContentPending] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const listboxId = useId();
	// Per-scope listings cached for the dialog's lifetime so toggling is instant.
	const listsRef = useRef<{ local?: SessionInfo[]; global?: SessionInfo[] }>({});
	const searchGenerationRef = useRef(0);

	const effectiveShowPath = showPath ?? scope === "global";

	const [attempt, setAttempt] = useState(0);

	/* The retry button's bump is the only reason this effect re-runs; nothing inside
	   reads it. */
	// biome-ignore lint/correctness/useExhaustiveDependencies: retry re-reads by bump
	useEffect(() => {
		if (!open) return;
		setQuery("");
		setScope("global");
		setSortMode("recent");
		setShowPath(null);
		// The sidebar's list (or the last run's snapshot of it) fills the dialog at once; the read below replaces it.
		const known = sessionListFeed("global").store.getState().sessions.filter(sessionHasContent);
		setSessions(known);
		setLoading(known.length === 0);
		setError(null);
		setSwitching(null);
		setActiveIndex(0);
		setContentHits(new Map());
		setContentPending(false);
		searchGenerationRef.current++;
		listsRef.current = {};
		requestAnimationFrame(() => inputRef.current?.focus());
		let cancelled = false;
		void (async () => {
			try {
				// A header-only file (stock `new_session` writes one at once) is not a conversation: stock's
				// own picker drops it too (`filterSessionsForPicker`), and so does the sidebar.
				const global = (await window.omp.sessions.list("global")).filter(sessionHasContent);
				if (cancelled) return;
				listsRef.current.global = global;
				setSessions(global);
				setScope("global");
			} catch (cause) {
				if (!cancelled) setError(inlineFailure(cause, t("sessionPicker.loadFailed")));
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [attempt, open]);

	const switchScope = async (target: SessionScope) => {
		if (target === scope || loading) return;
		setLoading(true);
		setError(null);
		setActiveIndex(0);
		try {
			const list = listsRef.current[target] ?? (await window.omp.sessions.list(target)).filter(sessionHasContent);
			listsRef.current[target] = list;
			setSessions(list);
			setScope(target);
		} catch (cause) {
			setError(inlineFailure(cause, t("sessionPicker.loadFailed")));
		} finally {
			setLoading(false);
		}
	};

	// Debounced full-transcript content search (main-process grep over the
	// session files). Best-effort: failures simply yield no content matches.
	useEffect(() => {
		const q = query.trim();
		if (q.length < CONTENT_SEARCH_MIN_QUERY) {
			setContentHits(new Map());
			setContentPending(false);
			return;
		}
		const generation = ++searchGenerationRef.current;
		const timer = setTimeout(() => {
			setContentPending(true);
			window.omp.sessions
				.search(q, scope)
				.then(hits => {
					if (searchGenerationRef.current === generation)
						setContentHits(new Map(hits.map(hit => [hit.path, hit.snippet])));
				})
				.catch(() => {})
				.finally(() => {
					if (searchGenerationRef.current === generation) setContentPending(false);
				});
		}, CONTENT_SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [query, scope]);

	const { filtered, contentOnly } = useMemo(() => {
		const ranked = rankSessions(sessions, query, sortMode);
		const merged = mergeContentMatches(ranked, sessions, contentHits);
		const metaPaths = new Set(ranked.map(session => session.path));
		const only = new Set<string>();
		for (const session of merged) {
			if (!metaPaths.has(session.path)) only.add(session.path);
		}
		return { filtered: merged, contentOnly: only };
	}, [sessions, query, sortMode, contentHits]);
	const projectNameOf = useProjectNames(
		useMemo(() => (open ? sessions.map(session => session.cwd) : []), [open, sessions]),
	);

	// Clamp the highlight when the visible list shrinks (search, reload).
	useEffect(() => {
		setActiveIndex(index => Math.min(index, Math.max(0, filtered.length - 1)));
	}, [filtered.length]);

	useEffect(() => {
		listRef.current?.querySelector(`[data-option-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
	}, [activeIndex]);

	const select = async (session: SessionInfo) => {
		if (switching !== null) return;
		// Busy sessions route to the switch dialog (new window vs abort) — close
		// the picker first so it doesn't sit behind the modal.
		const { isStreaming, isCompacting } = useSessionStore.getState();
		if (isStreaming || isCompacting) {
			close();
			requestSessionSwitch(session);
			return;
		}
		setSwitching(session.path);
		try {
			// A gone folder cannot take an in-place switch (stock refuses another folder); a tab open says why and offers
			// Restore when disk care saved it.
			if (projectNameOf(session.cwd, session.title).gone) {
				const kind = session.kind === "chat" ? "chat" : "agent";
				if ((await useTabsStore.getState().openTab({ sessionPath: session.path, kind })) !== null) close();
			} else if (await switchSessionNow(session)) close();
		} finally {
			setSwitching(null);
		}
	};

	const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
		if (isImeKeyEvent(event)) return;
		switch (event.key) {
			case "ArrowDown":
				event.preventDefault();
				setActiveIndex(index => Math.min(index + 1, filtered.length - 1));
				break;
			case "ArrowUp":
				event.preventDefault();
				setActiveIndex(index => Math.max(index - 1, 0));
				break;
			case "Home":
				event.preventDefault();
				setActiveIndex(0);
				break;
			case "End":
				event.preventDefault();
				setActiveIndex(Math.max(0, filtered.length - 1));
				break;
			case "Enter": {
				event.preventDefault();
				const session = filtered[activeIndex];
				if (session) void select(session);
				break;
			}
		}
	};

	// role="listbox" only when option rows actually render (loading / error /
	// empty states are plain status blocks, not listbox children).
	const showOptions = !error && !loading && filtered.length > 0;

	return (
		<Modal
			ariaLabel={t("sessionPicker.searchLabel")}
			bodyClassName="p-0"
			chromeless
			onClose={close}
			open={open}
			placement="top"
			size="picker"
		>
			<div className="flex h-full flex-col">
				<div className="flex items-center gap-2.5 border-b border-(--sc-divider) p-4">
					<div className="min-w-0 flex-1">
						<SearchField
							aria-activedescendant={filtered.length > 0 ? `${listboxId}-option-${activeIndex}` : undefined}
							aria-controls={listboxId}
							controlSize="lg"
							label={t("sessionPicker.searchLabel")}
							onKeyDown={onKeyDown}
							onValueChange={setQuery}
							placeholder={t("sessionPicker.placeholder")}
							ref={inputRef}
							value={query}
						/>
					</div>
					<IconButton
						icon={scope === "local" ? <Folder /> : <Globe />}
						label={scope === "local" ? t("sessionPicker.scopeToGlobal") : t("sessionPicker.scopeToLocal")}
						onClick={() => void switchScope(scope === "local" ? "global" : "local")}
						pressed={scope === "global"}
					/>
					<IconButton
						icon={sortMode === "recent" ? <Clock /> : <ArrowDownAZ />}
						label={sortMode === "recent" ? t("sessionPicker.sortAlpha") : t("sessionPicker.sortRecent")}
						onClick={() => setSortMode(mode => (mode === "recent" ? "alpha" : "recent"))}
					/>
					<IconButton
						icon={<FolderTree />}
						label={effectiveShowPath ? t("sessionPicker.hidePaths") : t("sessionPicker.showPaths")}
						onClick={() => setShowPath(!effectiveShowPath)}
						pressed={effectiveShowPath}
					/>
					<Kbd shortcut="⎋" />
				</div>
				<div
					className="min-h-0 flex-1 overflow-y-auto p-1.5"
					id={listboxId}
					ref={listRef}
					role={showOptions ? "listbox" : undefined}
				>
					{error ? (
						<InlineNotice
							action={
								<Button
									icon={<RotateCw />}
									onClick={() => setAttempt(count => count + 1)}
									size="sm"
									variant="secondary"
								>
									{t("common.retry")}
								</Button>
							}
							className="px-3 py-6"
							detail={error.cause}
							live
							title={error.message}
							tone="danger"
						/>
					) : loading ? (
						<SkeletonRows className="py-3" label={t("sessionPicker.loading")} widths={[70, 52, 64, 46, 58]} />
					) : filtered.length === 0 && !contentPending ? (
						<div className="py-10 text-center text-sc-sm text-(--sc-text-muted)">
							{sessions.length === 0
								? scope === "local"
									? t("sessionPicker.emptyLocal")
									: t("sessionPicker.empty")
								: t("sessionPicker.noMatch", { query })}
						</div>
					) : (
						filtered.map((session, index) => {
							const snippet = contentOnly.has(session.path) ? contentHits.get(session.path) : undefined;
							const isCurrent = session.id === sessionId;
							const isActive = index === activeIndex;
							// A blank stored title falls back like the sidebar's, never to an empty row.
							const title = sessionDisplayTitle(session, t("sessionPicker.untitled"));
							return (
								<button
									aria-selected={isCurrent}
									className={`flex min-h-10 w-full items-center gap-2.5 rounded-(--sc-radius-md) px-2.5 py-2 text-left disabled:opacity-50 ${
										isActive ? "bg-(--sc-selected)" : "hover:bg-(--sc-hover)"
									}`}
									data-option-index={index}
									disabled={switching !== null}
									id={`${listboxId}-option-${index}`}
									key={session.path}
									onClick={() => void select(session)}
									onMouseEnter={() => setActiveIndex(index)}
									role="option"
									type="button"
								>
									<History aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
									{session.kind === "chat" && (
										<MessageCircle
											className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)"
											aria-label={t("tabs.kind.chat")}
										/>
									)}
									<span className="min-w-0 flex-1">
										<span
											className={`block truncate text-sc-md text-(--sc-text) ${isCurrent ? "font-semibold" : "font-medium"}`}
										>
											{title}
										</span>
										<span className="block truncate text-sc-xs text-(--sc-text-muted)">
											{effectiveShowPath && session.cwd
												? shortenPath(session.cwd)
												: projectNameOf(session.cwd, session.title).name}{" "}
											· {t("sessionPicker.messageCount", { count: session.messageCount })} ·{" "}
											{formatTimeAgo(session.modified)}
										</span>
										{snippet && (
											<span className="mt-0.5 block truncate text-sc-xs text-(--sc-text-secondary)">
												{snippet}
											</span>
										)}
									</span>
									{projectNameOf(session.cwd, session.title).gone && (
										<Tooltip content={t("sessionFolder.goneTip")}>
											<span className="shrink-0" data-session-folder-gone>
												<Badge variant="warning">{t("sessionFolder.gone")}</Badge>
											</span>
										</Tooltip>
									)}
									{contentOnly.has(session.path) && (
										<Badge className="shrink-0" variant="info">
											{t("sessionPicker.contentMatch")}
										</Badge>
									)}
									{switching === session.path && <Spinner size="sm" spin />}
									{isCurrent && (
										<Check aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-secondary)" />
									)}
								</button>
							);
						})
					)}
					{contentPending && !error && !loading && (
						<Spinner
							className="w-full justify-center py-3"
							label={t("sessionPicker.searchingContent")}
							size="sm"
						/>
					)}
				</div>
			</div>
		</Modal>
	);
}
