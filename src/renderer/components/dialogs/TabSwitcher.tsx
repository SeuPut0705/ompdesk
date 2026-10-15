/**
 * ⌃⇥ tab switcher: while ⌃ is held, the open tabs most recent first, with the
 * previous one picked (⌃⇧⇥ picks the oldest). Each further ⇥ (⇧⇥ back, or the
 * arrows) moves the pick; releasing ⌃ or Enter switches to it, Esc leaves the
 * focus where it was. A quick ⌃⇥ tap therefore flips between the last two tabs.
 */

import { useEffect, useId, useState } from "react";
import { create } from "zustand";
import { useT } from "../../lib/i18n";
import { useTabHistoryStore } from "../../lib/tab-history";
import { tabChipLabel, useTabsStore } from "../../stores/tabs";
import { useUiStore } from "../../stores/ui";
import { Modal } from "../common";

/** Which way the opening press moved: ⌃⇥ (1) or ⌃⇧⇥ (-1). */
export const useTabSwitcherStore = create<{ step: 1 | -1 }>()(() => ({ step: 1 }));

export function TabSwitcher() {
	const t = useT();
	const open = useUiStore(state => state.tabSwitcherOpen);
	const tabs = useTabsStore(state => state.tabs);
	const mru = useTabHistoryStore(state => state.mru);
	const ordered = mru.flatMap(id => tabs.find(tab => tab.id === id) ?? []);
	const [index, setIndex] = useState(0);
	const listId = useId();

	// biome-ignore lint/correctness/useExhaustiveDependencies: the pick starts once per opening.
	useEffect(() => {
		if (!open) return;
		const step = useTabSwitcherStore.getState().step;
		setIndex(step > 0 ? Math.min(1, ordered.length - 1) : ordered.length - 1);
	}, [open]);

	useEffect(() => {
		const close = () => useUiStore.setState({ tabSwitcherOpen: false });
		const commit = () => {
			if (!useUiStore.getState().tabSwitcherOpen) return;
			const target = document.querySelector<HTMLElement>(`#${CSS.escape(listId)} [aria-selected="true"]`);
			close();
			const tabId = target?.dataset.tabId;
			if (tabId && tabId !== useTabsStore.getState().activeTabId) void useTabsStore.getState().switchTab(tabId);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (!useUiStore.getState().tabSwitcherOpen) return;
			const count = Number(document.getElementById(listId)?.dataset.count ?? 0);
			if (count === 0) return;
			const move = (delta: number) => {
				event.preventDefault();
				event.stopPropagation();
				setIndex(current => (current + delta + count) % count);
			};
			if (event.key === "Tab") move(event.shiftKey ? -1 : 1);
			else if (event.key === "ArrowDown") move(1);
			else if (event.key === "ArrowUp") move(-1);
			else if (event.key === "Enter") {
				event.preventDefault();
				commit();
			}
		};
		// Installed for the window's life: a quick tap can release ⌃ before the overlay paints.
		const onKeyUp = (event: KeyboardEvent) => {
			if (event.key === "Control") commit();
		};
		window.addEventListener("keydown", onKeyDown, true);
		window.addEventListener("keyup", onKeyUp, true);
		return () => {
			window.removeEventListener("keydown", onKeyDown, true);
			window.removeEventListener("keyup", onKeyUp, true);
		};
	}, [listId]);

	return (
		<Modal
			ariaLabel={t("tabSwitcher.title")}
			bodyClassName="p-1.5"
			chromeless
			onClose={() => useUiStore.setState({ tabSwitcherOpen: false })}
			open={open}
			placement="top"
			size="sm"
		>
			<div aria-label={t("tabSwitcher.title")} data-count={ordered.length} id={listId} role="listbox">
				{ordered.map((tab, position) => (
					<button
						aria-selected={position === index}
						className={`flex min-h-9 w-full items-center gap-2.5 rounded-(--sc-radius-md) px-2.5 py-1.5 text-left ${
							position === index ? "bg-(--sc-selected)" : "hover:bg-(--sc-hover)"
						}`}
						data-tab-id={tab.id}
						key={tab.id}
						onClick={() => {
							useUiStore.setState({ tabSwitcherOpen: false });
							void useTabsStore.getState().switchTab(tab.id);
						}}
						onMouseEnter={() => setIndex(position)}
						role="option"
						type="button"
					>
						<span className="min-w-0 flex-1 truncate text-sc-md text-(--sc-text)">{tabChipLabel(tab, tabs)}</span>
						{tab.id === useTabsStore.getState().activeTabId && (
							<span className="shrink-0 text-sc-xs text-(--sc-text-muted)">{t("tabSwitcher.current")}</span>
						)}
					</button>
				))}
			</div>
		</Modal>
	);
}
