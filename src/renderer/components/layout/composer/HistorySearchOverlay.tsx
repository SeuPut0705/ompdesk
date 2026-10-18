import { History } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { cx, escapeRegExp, formatTimeAgo, shortenPath } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { isImeKeyEvent } from "../../../lib/ime";
import { chordFromEvent } from "../../../lib/keymap";
import { useTabRpc } from "../../../lib/tab-rpc";
import type { InputHistoryEntry } from "../../../stores/input-history";
import { useInputHistoryStore } from "../../../stores/input-history";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { useTabsStore } from "../../../stores/tabs";
import { toastError } from "../../../stores/toast";
import { Kbd, Spinner, Tabs } from "../../common";
import { listboxTarget } from "./listbox-nav";

/**
 * Ctrl+R history search overlay (GUI counterpart of the TUI
 * HistorySearchComponent): token-AND fuzzy filter over sent prompts,
 * ↑↓ navigate, Enter inserts into the composer, Esc closes.
 */

const MAX_RESULTS = 50;

interface HistorySearchOverlayProps {
	cwd: string;
	onSelect: (prompt: string) => void;
	onClose: () => void;
}

/** Wrap fuzzy-match tokens in <mark>, mirroring the TUI's token highlighting. */
function HighlightedPrompt({ text, tokens }: { text: string; tokens: string[] }) {
	if (tokens.length === 0) return <>{text}</>;
	const pattern = new RegExp(`(${tokens.map(escapeRegExp).join("|")})`, "gi");
	const parts = text.split(pattern);
	return (
		<>
			{parts.map((part, index) =>
				index % 2 === 1 ? (
					<mark key={index} className="bg-transparent font-medium text-(--sc-accent)">
						{part}
					</mark>
				) : (
					part
				),
			)}
		</>
	);
}

export function HistorySearchOverlay({ cwd, onSelect, onClose }: HistorySearchOverlayProps) {
	const t = useT();
	const entries = useInputHistoryStore(s => s.entries);
	const rpc = useTabRpc();
	const tabId = useRuntimeTabId();
	const device = useTabsStore(state => state.tabs.find(tab => tab.id === (tabId ?? state.activeTabId))?.device);
	const [results, setResults] = useState<InputHistoryEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [query, setQuery] = useState("");
	const [allWorkspaces, setAllWorkspaces] = useState(false);
	const [index, setIndex] = useState(0);
	const overlayRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const listId = useId();

	const tokens = useMemo(() => query.toLowerCase().split(/\s+/).filter(Boolean), [query]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a submission in another pane refreshes stock search results.
	useEffect(() => {
		let current = true;
		setLoading(true);
		void useInputHistoryStore
			.getState()
			.search(query, MAX_RESULTS, allWorkspaces ? undefined : cwd, rpc, device)
			.then(rows => {
				if (current) setResults(rows);
			})
			.catch(error => {
				if (current) {
					setResults([]);
					toastError({ title: t("palette.failed"), error });
				}
			})
			.finally(() => {
				if (current) setLoading(false);
			});
		return () => {
			current = false;
		};
	}, [entries, query, allWorkspaces, cwd, rpc, device, t]);
	const selected = Math.min(index, Math.max(0, results.length - 1));

	useEffect(() => {
		listRef.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
	}, [selected]);

	// This surface lives above the composer rather than inside Modal. Give it the
	// same dismissal guarantees: outside click closes it, and Escape is consumed
	// during capture so the app-level Escape handler cannot abort a running turn.
	useEffect(() => {
		const onPointerDown = (event: PointerEvent) => {
			if (overlayRef.current?.contains(event.target as Node)) return;
			onClose();
		};
		const onKeyDown = (event: globalThis.KeyboardEvent) => {
			if (isImeKeyEvent(event) || event.key !== "Escape") return;
			event.preventDefault();
			event.stopImmediatePropagation();
			onClose();
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown, true);
		};
	}, [onClose]);

	const pick = (entry: InputHistoryEntry | undefined) => {
		if (entry) onSelect(entry.prompt);
	};

	const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (isImeKeyEvent(event)) return;
		if (event.key === "Enter") {
			event.preventDefault();
			pick(results[selected]);
			return;
		}
		// ⌃R toggles the overlay from its own field too, as it does from the composer's.
		if (event.key === "Escape" || chordFromEvent(event) === "⌃R") {
			event.preventDefault();
			onClose();
			return;
		}
		// ↑/↓ (wrapping), Home/End and PageUp/PageDown: the completion menu's keys (listbox-nav.ts).
		const target = listboxTarget(event.key, selected, results.length);
		if (target !== null) {
			event.preventDefault();
			setIndex(target);
		}
	};

	return (
		<div
			ref={overlayRef}
			className="omp-pop-in absolute right-0 bottom-full left-0 z-(--sc-z-popover) mb-2 overflow-hidden rounded-(--sc-radius-lg) border border-(--sc-border-subtle) bg-(--sc-elevated) shadow-(--sc-shadow-md)"
			role="dialog"
			aria-label={t("input.history.title")}
			aria-modal="false"
		>
			<div className="flex items-center gap-2 border-b border-(--sc-divider) px-3 py-2">
				<History aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
				<input
					ref={inputRef}
					autoFocus
					aria-activedescendant={results.length > 0 ? `${listId}-option-${selected}` : undefined}
					aria-controls={listId}
					role="combobox"
					aria-expanded
					aria-autocomplete="list"
					aria-label={t("input.history.placeholder")}
					onKeyDown={handleKeyDown}
					value={query}
					onChange={event => {
						setQuery(event.target.value);
						setIndex(0);
					}}
					placeholder={t("input.history.placeholder")}
					className="min-w-0 flex-1 bg-transparent text-sc-md text-(--sc-text) outline-none placeholder:text-(--sc-text-subtle) focus-visible:outline-none"
				/>
				<Tabs
					activeId={allWorkspaces ? "all" : "workspace"}
					ariaLabel={t("input.history.scope")}
					compact
					onChange={id => {
						setAllWorkspaces(id === "all");
						setIndex(0);
					}}
					tabs={[
						{ id: "workspace", label: t("input.history.workspace") },
						{ id: "all", label: t("input.history.all") },
					]}
					variant="segmented"
				/>
			</div>
			<div
				className="truncate border-b border-(--sc-divider) px-3 py-1.5 text-sc-xs text-(--sc-text-muted)"
				title={shortenPath(cwd)}
			>
				{allWorkspaces ? t("input.history.includesLegacy") : shortenPath(cwd)}
			</div>

			<div
				id={listId}
				ref={listRef}
				className="max-h-64 overflow-y-auto p-1"
				role="listbox"
				aria-label={t("input.history.title")}
				aria-busy={loading}
			>
				{results.length === 0 ? (
					loading ? (
						<Spinner className="px-3 py-2.5" label={t("common.loading")} size="sm" />
					) : (
						<div className="px-3 py-2.5 text-sc-sm text-(--sc-text-muted)">
							{tokens.length > 0 ? t("input.history.empty") : t("input.history.none")}
						</div>
					)
				) : (
					results.map((entry, rowIndex) => (
						<button
							key={`${entry.ts}-${rowIndex}`}
							type="button"
							id={`${listId}-option-${rowIndex}`}
							role="option"
							aria-selected={rowIndex === selected}
							data-index={rowIndex}
							onMouseDown={event => event.preventDefault()}
							onClick={() => pick(entry)}
							onMouseEnter={() => setIndex(rowIndex)}
							title={entry.cwd ? shortenPath(entry.cwd) : t("input.history.legacy")}
							className={cx(
								"flex w-full items-baseline gap-3 rounded-(--sc-radius-sm) px-2.5 py-1.5 text-left",
								rowIndex === selected ? "bg-(--sc-selected)" : "",
							)}
						>
							<span
								className={cx(
									"min-w-0 flex-1 truncate text-sc-md",
									rowIndex === selected ? "text-(--sc-text)" : "text-(--sc-text-secondary)",
								)}
							>
								<HighlightedPrompt text={entry.prompt.replace(/\s+/g, " ").trim()} tokens={tokens} />
								{allWorkspaces && (
									<span className="block truncate font-mono text-sc-xs text-(--sc-text-muted)">
										{entry.cwd ? shortenPath(entry.cwd) : t("input.history.legacy")}
									</span>
								)}
							</span>
							{entry.ts > 0 && (
								<span className="shrink-0 text-sc-xs tabular-nums text-(--sc-text-muted)">
									{formatTimeAgo(new Date(entry.ts).toISOString())}
								</span>
							)}
						</button>
					))
				)}
			</div>

			<div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-(--sc-divider) px-3 py-1.5 text-sc-xs text-(--sc-text-muted)">
				<span className="flex items-center gap-1.5">
					<Kbd shortcut="↑" />
					<Kbd shortcut="↓" />
					{t("palette.hintMove")}
				</span>
				<span className="flex items-center gap-1.5">
					<Kbd shortcut="↵" />
					{t("input.history.hintInsert")}
				</span>
				<span className="ml-auto flex items-center gap-1.5">
					<Kbd shortcut="⎋" />
					{t("palette.hintClose")}
				</span>
			</div>
		</div>
	);
}
