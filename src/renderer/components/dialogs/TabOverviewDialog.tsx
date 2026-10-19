/**
 * ⇧⌘A tab overview: every open tab in this window with a search field.
 * "Recent" lists them most recently focused first; "Order" lists the strip
 * order ⌘1…⌘9 follow, where a row drags (or moves with its arrow buttons) to
 * a new position. Enter or a click focuses the tab; × closes it (a running or
 * worktree tab confirms through the usual close path).
 */

import { ArrowDown, ArrowUp, X } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { performTabClose } from "../../lib/tab-close";
import { useTabHistoryStore } from "../../lib/tab-history";
import { tabSignalPresentation } from "../../lib/tab-signal";
import { type SessionTab, tabChipLabel, useTabsStore } from "../../stores/tabs";
import { useUiStore } from "../../stores/ui";
import { IconButton, Kbd, Modal, SearchField, Tabs } from "../common";

type Sort = "recent" | "order";

export function TabOverviewDialog() {
	const t = useT();
	const open = useUiStore(state => state.tabOverviewOpen);
	const tabs = useTabsStore(state => state.tabs);
	const activeTabId = useTabsStore(state => state.activeTabId);
	const mru = useTabHistoryStore(state => state.mru);
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<Sort>("recent");
	const [activeIndex, setActiveIndex] = useState(0);
	const [dragging, setDragging] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const listboxId = useId();
	const close = () => useUiStore.setState({ tabOverviewOpen: false });

	// Like ⌘P: every opening starts empty, reset on close so the first frame is clean.
	useEffect(() => {
		if (!open) {
			setQuery("");
			setActiveIndex(0);
			return;
		}
		requestAnimationFrame(() => inputRef.current?.focus());
	}, [open]);

	const labelOf = (tab: SessionTab) => tabChipLabel(tab, tabs);
	const rows = useMemo(() => {
		const base = sort === "recent" ? mru.flatMap(id => tabs.find(tab => tab.id === id) ?? []) : tabs;
		// A tab opened before the history saw it still lists (at the end).
		const listed = [...base, ...tabs.filter(tab => !base.includes(tab))];
		const needle = query.trim().toLowerCase();
		if (!needle) return listed;
		return listed.filter(tab => `${tabChipLabel(tab, tabs)} ${tab.cwd}`.toLowerCase().includes(needle));
	}, [sort, mru, tabs, query]);
	const reorderable = sort === "order" && query.trim() === "";

	useEffect(() => {
		setActiveIndex(index => Math.min(index, Math.max(0, rows.length - 1)));
	}, [rows.length]);

	const pick = (tabId: string) => {
		close();
		if (tabId !== useTabsStore.getState().activeTabId) void useTabsStore.getState().switchTab(tabId);
	};

	const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
		if (isImeKeyEvent(event)) return;
		if (event.key === "ArrowDown") {
			event.preventDefault();
			setActiveIndex(index => Math.min(index + 1, rows.length - 1));
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			setActiveIndex(index => Math.max(index - 1, 0));
		} else if (event.key === "Enter") {
			event.preventDefault();
			const tab = rows[activeIndex];
			if (tab) pick(tab.id);
		}
	};

	const move = (tab: SessionTab, delta: number) => {
		const from = tabs.indexOf(tab);
		void useTabsStore.getState().moveTab(tab.id, from + delta);
	};

	return (
		<Modal
			ariaLabel={t("tabOverview.title")}
			bodyClassName="p-0"
			chromeless
			onClose={close}
			open={open}
			placement="top"
			size="picker"
		>
			<div className="flex h-full flex-col" data-tab-overview="">
				<div className="flex items-center gap-2.5 border-b border-(--sc-divider) p-4">
					<div className="min-w-0 flex-1">
						<SearchField
							aria-activedescendant={rows.length > 0 ? `${listboxId}-option-${activeIndex}` : undefined}
							aria-controls={listboxId}
							controlSize="lg"
							label={t("tabOverview.search")}
							onKeyDown={onKeyDown}
							onValueChange={setQuery}
							placeholder={t("tabOverview.search")}
							ref={inputRef}
							value={query}
						/>
					</div>
					<Kbd shortcut="⎋" />
				</div>
				<div className="flex items-center justify-between gap-3 px-4 pt-3">
					<span className="text-sc-xs text-(--sc-text-muted)">
						{sort === "order" ? t("tabOverview.orderHint") : null}
					</span>
					<Tabs
						activeId={sort}
						ariaLabel={t("tabOverview.sort")}
						compact
						onChange={id => setSort(id === "order" ? "order" : "recent")}
						tabs={[
							{ id: "recent", label: t("tabOverview.recent") },
							{ id: "order", label: t("tabOverview.order") },
						]}
						variant="segmented"
					/>
				</div>
				<div
					aria-label={t("tabOverview.title")}
					className="min-h-0 flex-1 overflow-y-auto p-1.5"
					id={listboxId}
					role={rows.length > 0 ? "listbox" : undefined}
				>
					{rows.length === 0 ? (
						<p className="py-10 text-center text-sc-sm text-(--sc-text-muted)">
							{t("tabOverview.noMatch", { query })}
						</p>
					) : (
						rows.map((tab, index) => {
							const position = tabs.indexOf(tab);
							return (
								<div
									aria-selected={index === activeIndex}
									className={`group flex min-h-10 items-center gap-2.5 rounded-(--sc-radius-md) px-2.5 py-1 ${
										index === activeIndex ? "bg-(--sc-selected)" : "hover:bg-(--sc-hover)"
									} ${dragging === tab.id ? "opacity-50" : ""}`}
									data-tab-id={tab.id}
									draggable={reorderable}
									id={`${listboxId}-option-${index}`}
									key={tab.id}
									onClick={() => pick(tab.id)}
									onDragEnd={() => setDragging(null)}
									onDragOver={event => {
										if (!reorderable || !dragging) return;
										event.preventDefault();
										event.dataTransfer.dropEffect = "move";
									}}
									onDragStart={event => {
										event.dataTransfer.effectAllowed = "move";
										event.dataTransfer.setData("text/plain", tab.id);
										setDragging(tab.id);
									}}
									onDrop={event => {
										event.preventDefault();
										if (dragging && dragging !== tab.id)
											void useTabsStore.getState().moveTab(dragging, position);
										setDragging(null);
									}}
									onKeyDown={event => {
										if (isImeKeyEvent(event)) return;
										if (event.key === "Enter") pick(tab.id);
									}}
									onMouseEnter={() => setActiveIndex(index)}
									role="option"
									tabIndex={-1}
								>
									<span className="w-6 shrink-0 text-right text-sc-xs text-(--sc-text-muted) tabular-nums">
										{position < 9 ? position + 1 : ""}
									</span>
									<span className="min-w-0 flex-1">
										<span className="block truncate text-sc-md font-medium text-(--sc-text)">
											{labelOf(tab)}
										</span>
										<span className="block truncate text-sc-xs text-(--sc-text-muted)">{tab.cwd}</span>
									</span>
									{tab.id === activeTabId && (
										<span className="shrink-0 text-sc-xs text-(--sc-text-muted)">
											{t("tabSwitcher.current")}
										</span>
									)}
									{reorderable && (
										<>
											<IconButton
												disabled={position === 0}
												icon={<ArrowUp />}
												label={t("tabOverview.moveUp")}
												onClick={event => {
													event.stopPropagation();
													move(tab, -1);
												}}
												size="sm"
											/>
											<IconButton
												disabled={position === tabs.length - 1}
												icon={<ArrowDown />}
												label={t("tabOverview.moveDown")}
												onClick={event => {
													event.stopPropagation();
													move(tab, 1);
												}}
												size="sm"
											/>
										</>
									)}
									<IconButton
										// A running tab dies with its close: the overview never closes one silently.
										disabled={tabs.length < 2 || tabSignalPresentation(tab, false).running}
										icon={<X />}
										label={t("tabOverview.close", { title: labelOf(tab) })}
										onClick={event => {
											event.stopPropagation();
											performTabClose(tab);
										}}
										size="sm"
									/>
								</div>
							);
						})
					)}
				</div>
			</div>
		</Modal>
	);
}
