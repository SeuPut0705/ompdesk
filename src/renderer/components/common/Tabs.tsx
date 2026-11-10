/**
 * Tabs — switch between sibling views of ONE surface, with roving
 * arrow-key navigation (←/→, Home/End).
 *
 * - `underline` (default): section tabs at the top of a page, panel or
 *   dialog (Agents: Definitions · Live · PRs; inspector: Changes · Files · Logs).
 * - `segmented`: a compact mode switch inside a toolbar (Plan · Goal · Loop,
 *   This session · All sessions), or a row of steps (a question card's).
 * Tabs never navigate away and never trigger actions; destinations live in
 * the sidebar. Pass `ariaLabel`, and label the panels with the tab ids.
 *
 * Either strip scrolls sideways when its tabs do not fit (never wraps under itself) and keeps the chosen tab in view;
 * a long label is cut, and a tab's `tooltip` then says it whole. A tab may lead or trail with a small mark (`leading`,
 * `trailing`: a ✓ for an answered step, with its words in an `sr-only` span so colour and shape are not the only cue).
 * `onChange` says whether a click or a key moved the selection, so a caller that moves focus into the new view on a
 * click can leave it on the strip for the arrows.
 */

import { type KeyboardEvent, type ReactNode, useEffect, useRef } from "react";
import { cx } from "../../lib/format";

type DataAttributes = { [key: `data-${string}`]: string | number | boolean | undefined };

export interface TabItem {
	id: string;
	label: string;
	/** Optional badge count or marker rendered after the label. */
	badge?: string | number;
	disabled?: boolean;
	/** Hover text (the tab's `title`): the whole of a label the strip cuts, or what the tab stands for. */
	tooltip?: string;
	/** A mark before the label (decorative: `aria-hidden`, its meaning said in words beside it). */
	leading?: ReactNode;
	/** After the label and badge: a mark, or an `sr-only` word that completes the tab's name. */
	trailing?: ReactNode;
	/** `data-*` hooks on the tab (`data-ask-step`) for styles, tests and callers. */
	attrs?: DataAttributes;
}

export type TabsVariant = "underline" | "segmented";

/** What moved the selection: a click (or Enter/Space on a tab), or an arrow, Home or End. */
export type TabChangeVia = "click" | "key";

export interface TabsProps extends DataAttributes {
	tabs: TabItem[];
	activeId: string;
	onChange: (id: string, via: TabChangeVia) => void;
	variant?: TabsVariant;
	/** Compact reduces height and type size for panel headers. */
	compact?: boolean;
	className?: string;
	ariaLabel?: string;
}

export function Tabs({
	tabs,
	activeId,
	onChange,
	variant = "underline",
	compact,
	className,
	ariaLabel,
	...data
}: TabsProps) {
	const listRef = useRef<HTMLDivElement>(null);
	const segmented = variant === "segmented";

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") {
			return;
		}
		const enabled = tabs.filter(tab => !tab.disabled);
		if (enabled.length === 0) return;
		event.preventDefault();
		const current = enabled.findIndex(tab => tab.id === activeId);
		let next: number;
		if (event.key === "Home") next = 0;
		else if (event.key === "End") next = enabled.length - 1;
		else if (event.key === "ArrowRight") next = (current + 1) % enabled.length;
		else next = current < 0 ? enabled.length - 1 : (current - 1 + enabled.length) % enabled.length;
		onChange(enabled[next].id, "key");
		requestAnimationFrame(() => {
			listRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(enabled[next].id)}"]`)?.focus();
		});
	};

	// The chosen tab stays in view when the row scrolls.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-runs when the chosen tab changes.
	useEffect(() => {
		const list = listRef.current;
		const tab = list?.querySelector<HTMLElement>('[aria-selected="true"]');
		if (!list || !tab || list.scrollWidth <= list.clientWidth) return;
		const box = list.getBoundingClientRect();
		const at = tab.getBoundingClientRect();
		if (at.left < box.left) list.scrollLeft -= box.left - at.left;
		else if (at.right > box.right) list.scrollLeft += at.right - box.right;
	}, [activeId]);

	// With no tab selected (a strip that only opens forms) the first enabled tab is the one Tab stop.
	const anySelected = tabs.some(tab => tab.id === activeId);
	const rovingStop = tabs.find(tab => !tab.disabled);
	return (
		<div
			{...data}
			aria-label={ariaLabel}
			data-segmented={segmented || undefined}
			className={cx(
				"max-w-full items-center overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
				segmented
					? "inline-flex gap-0.5 rounded-(--sc-radius-md) bg-(--sc-surface-3) p-0.5"
					: "flex gap-1 border-b border-(--sc-divider)",
				className,
			)}
			onKeyDown={onKeyDown}
			ref={listRef}
			role="tablist"
		>
			{tabs.map(tab => {
				const active = tab.id === activeId;
				return (
					<button
						{...tab.attrs}
						aria-selected={active}
						className={cx(
							"relative inline-flex max-w-full shrink-0 items-center gap-1 font-medium whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50",
							// The track clips what sticks out of it, so a segment's focus ring is drawn inside the segment.
							segmented
								? "omp-pressable focus-visible:outline-offset-[calc(-1*var(--sc-focus-width))]"
								: "transition-colors duration-(--sc-duration-fast)",
							compact ? "text-sc-sm" : "text-sc-md",
							segmented
								? cx(
										"h-(--sc-hit-min) rounded-(--sc-radius-sm) px-2.5",
										active
											? "bg-(--sc-elevated) text-(--sc-text) shadow-(--sc-shadow-sm)"
											: "text-(--sc-text-muted) hover:text-(--sc-text)",
									)
								: cx(
										"-mb-px border-b-2 px-2",
										compact ? "h-8" : "h-9",
										active
											? "border-(--sc-accent) text-(--sc-text)"
											: "border-transparent text-(--sc-text-muted) hover:text-(--sc-text)",
									),
						)}
						data-tab-id={tab.id}
						disabled={tab.disabled}
						key={tab.id}
						onClick={() => onChange(tab.id, "click")}
						role="tab"
						tabIndex={active || (tab === rovingStop && !anySelected) ? 0 : -1}
						title={tab.tooltip}
						type="button"
					>
						{tab.leading !== undefined && <span className="inline-flex shrink-0">{tab.leading}</span>}
						<span className="min-w-0 truncate">{tab.label}</span>
						{tab.badge !== undefined && (
							<span className="ml-0.5 rounded-(--sc-radius-full) bg-(--sc-surface-3) px-1.5 text-sc-2xs tabular-nums text-(--sc-text-muted)">
								{tab.badge}
							</span>
						)}
						{tab.trailing}
					</button>
				);
			})}
		</div>
	);
}
