/**
 * ⌘P quick open: the focused tab's workspace files (main's bounded `fs.list`
 * walk), ranked by file name as the user types; Enter or a click opens the
 * file in the side panel's Files viewer. A failed or truncated walk says so.
 * Follows the SessionPickerDialog overlay layout.
 */

import { FileText, RotateCw } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import type { FsTreeEntry } from "../../../shared/ipc-types";
import { type InlineFailure, inlineFailure } from "../../lib/error-detail";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { rankQuickOpen } from "../../lib/quick-open";
import { useTabsStore } from "../../stores/tabs";
import { useUiStore } from "../../stores/ui";
import { Button, InlineNotice, Kbd, Modal, OptionRow, SearchField, SkeletonRows } from "../common";

/** Directory depth and file cap of the walk (a large repo lists its first files). */
const LIST_DEPTH = 12;
const LIST_MAX_FILES = 5000;
/** Rows rendered at once; typing narrows the rest. */
const VISIBLE_ROWS = 60;

function collectFiles(entries: FsTreeEntry[], out: string[]): void {
	for (const entry of entries) {
		if (entry.kind === "file") out.push(entry.path);
		else if (entry.children) collectFiles(entry.children, out);
	}
}

type Listing =
	| { state: "loading" }
	| { state: "failed"; failure: InlineFailure }
	| { state: "ready"; paths: string[]; truncated: boolean }
	| { state: "no-folder" };

export function QuickOpenDialog() {
	const t = useT();
	const open = useUiStore(state => state.quickOpenOpen);
	const close = useUiStore(state => state.closeQuickOpen);
	const tab = useTabsStore(state => state.tabs.find(candidate => candidate.id === state.activeTabId));
	const tabId = tab?.id;
	const isChat = tab?.kind === "chat";
	const [query, setQuery] = useState("");
	const [listing, setListing] = useState<Listing>({ state: "loading" });
	const [activeIndex, setActiveIndex] = useState(0);
	const [attempt, setAttempt] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const listboxId = useId();

	// ⌘P always opens on an empty query (VS Code's default, `preserveInput` off).
	// The reset runs when the dialog closes, not when it opens: an opening reset
	// lands one commit late, so the reopened field first showed the last query and
	// a keystroke typed into it appended to that ("gamma" + "alpha"). The closing
	// panel animates out from the Modal's frozen snapshot, so nothing flickers.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the retry button's bump re-lists.
	useEffect(() => {
		if (!open) {
			setQuery("");
			setActiveIndex(0);
			return;
		}
		requestAnimationFrame(() => inputRef.current?.focus());
		if (isChat || !tabId) {
			setListing({ state: "no-folder" });
			return;
		}
		setListing({ state: "loading" });
		let cancelled = false;
		window.omp.fs
			.list(undefined, LIST_DEPTH, LIST_MAX_FILES, tabId)
			.then(result => {
				if (cancelled) return;
				if (!result.ok) {
					setListing({ state: "failed", failure: inlineFailure(result, t("quickOpen.failed")) });
					return;
				}
				const paths: string[] = [];
				collectFiles(result.entries, paths);
				setListing({ state: "ready", paths, truncated: result.truncated });
			})
			.catch(cause => {
				if (!cancelled) setListing({ state: "failed", failure: inlineFailure(cause, t("quickOpen.failed")) });
			});
		return () => {
			cancelled = true;
		};
	}, [open, tabId, isChat, attempt]);

	const matches = useMemo(
		() => (listing.state === "ready" ? rankQuickOpen(listing.paths, query, VISIBLE_ROWS) : []),
		[listing, query],
	);

	useEffect(() => {
		setActiveIndex(index => Math.min(index, Math.max(0, matches.length - 1)));
	}, [matches.length]);

	useEffect(() => {
		listRef.current?.querySelector(`[data-option-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
	}, [activeIndex]);

	const pick = (path: string) => {
		close();
		useUiStore.getState().openFilePreview(path);
	};

	const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
		if (isImeKeyEvent(event)) return;
		if (event.key === "ArrowDown") {
			event.preventDefault();
			setActiveIndex(index => Math.min(index + 1, matches.length - 1));
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			setActiveIndex(index => Math.max(index - 1, 0));
		} else if (event.key === "Enter") {
			event.preventDefault();
			const path = matches[activeIndex];
			if (path) pick(path);
		}
	};

	const showOptions = listing.state === "ready" && matches.length > 0;

	return (
		<Modal
			ariaLabel={t("quickOpen.title")}
			bodyClassName="p-0"
			chromeless
			onClose={close}
			open={open}
			placement="top"
			size="picker"
		>
			<div className="flex h-full flex-col" data-quick-open="">
				<div className="flex items-center gap-2.5 border-b border-(--sc-divider) p-4">
					<div className="min-w-0 flex-1">
						<SearchField
							aria-activedescendant={showOptions ? `${listboxId}-option-${activeIndex}` : undefined}
							aria-controls={listboxId}
							controlSize="lg"
							label={t("quickOpen.title")}
							onKeyDown={onKeyDown}
							onValueChange={setQuery}
							placeholder={t("quickOpen.placeholder")}
							ref={inputRef}
							value={query}
						/>
					</div>
					<Kbd shortcut="⎋" />
				</div>
				<div
					className="min-h-0 flex-1 overflow-y-auto p-1.5"
					id={listboxId}
					ref={listRef}
					role={showOptions ? "listbox" : undefined}
				>
					{listing.state === "failed" ? (
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
							detail={listing.failure.cause}
							live
							title={listing.failure.message}
							tone="danger"
						/>
					) : listing.state === "loading" ? (
						<SkeletonRows className="py-2" label={t("quickOpen.loading")} widths={[60, 44, 70, 52]} />
					) : listing.state === "no-folder" ? (
						<p className="py-10 text-center text-sc-sm text-(--sc-text-muted)">{t("quickOpen.noFolder")}</p>
					) : matches.length === 0 ? (
						<p className="py-10 text-center text-sc-sm text-(--sc-text-muted)">
							{listing.paths.length === 0 ? t("quickOpen.empty") : t("quickOpen.noMatch", { query })}
						</p>
					) : (
						matches.map((path, index) => {
							const slash = path.lastIndexOf("/");
							return (
								<OptionRow
									active={index === activeIndex}
									size="sm"
									data-option-index={index}
									data-path={path}
									id={`${listboxId}-option-${index}`}
									key={path}
									onClick={() => pick(path)}
									onMouseEnter={() => setActiveIndex(index)}
								>
									<FileText aria-hidden className="size-(--sc-icon-sm) shrink-0 text-(--sc-text-muted)" />
									<span className="min-w-0 shrink-0 truncate text-sc-md font-medium text-(--sc-text)">
										{path.slice(slash + 1)}
									</span>
									{slash > 0 && (
										<span className="min-w-0 flex-1 truncate text-sc-xs text-(--sc-text-muted)">
											{path.slice(0, slash)}
										</span>
									)}
								</OptionRow>
							);
						})
					)}
				</div>
				{listing.state === "ready" && listing.truncated && (
					<p className="border-t border-(--sc-divider) px-4 py-2 text-sc-xs text-(--sc-text-muted)">
						{t("quickOpen.truncated", { count: listing.paths.length })}
					</p>
				)}
			</div>
		</Modal>
	);
}
