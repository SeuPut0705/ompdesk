/**
 * Tabs — switch between sibling views of ONE surface, with roving
 * arrow-key navigation (←/→, Home/End).
 *
 * - `underline` (default): section tabs at the top of a page, panel or
 *   dialog (Agents: Definitions · Live · PRs; inspector: Changes · Files · Logs).
 * - `segmented`: a compact mode switch inside a toolbar (Plan · Goal · Loop,
 *   This session · All sessions), or a row of steps (a question card's).
 * - `pills`: a strip of things open side by side (a panel's terminals, files, preview pages: `compact`), or a page's
 *   list of sections (`orientation="vertical"`); the chosen one wears the selected wash.
 * Tabs never navigate away and never trigger actions; destinations live in
 * the sidebar. Pass `ariaLabel`, and label the panels with the tab ids.
 *
 * Either strip scrolls sideways when its tabs do not fit (never wraps under itself) and keeps the chosen tab in view;
 * a long label is cut, and a tab's `tooltip` then says it whole. A tab may lead or trail with a small mark (`leading`,
 * `trailing`: a ✓ for an answered step, a file's icon, a spinner while a page loads, with its words in an `sr-only`
 * span so colour and shape are not the only cue). `onChange` says whether a click or a key moved the selection, so a
 * caller that moves focus into the new view on a click can leave it on the strip for the arrows.
 *
 * A tab that can be closed (`onClose`, `closeLabel` its accessible name) follows the closable tabs of the ARIA
 * practices: the tab list holds only tabs, so the ✕ beside each tab is the pointer's (out of the Tab order and hidden
 * from assistive tech), Delete closes the focused tab (`aria-keyshortcuts`, and focus moves to the tab that is then
 * chosen), and the chosen tab's close follows the list as one more control, drawn only while it has keyboard focus
 * (`data-tabs-close-selected`), for a touch screen reader that has no Delete key. `keyshortcuts` names a tab's other
 * keys; `onDoubleClick` acts on a tab (keeps a file's preview tab open); `className` sizes or styles one tab's box.
 *
 * `orientation="vertical"` stacks the strip (↑/↓ move, ←/→ too) and turns it into one row that scrolls sideways on a
 * phone, where a column of sections would push the content off the first screen.
 */

import { X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useRef } from "react";
import { cx } from "../../lib/format";
import { IconButton } from "./IconButton";

type DataAttributes = { [key: `data-${string}`]: string | number | boolean | undefined };

export type TabItem = {
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
	/** Keys this tab answers to besides the strip's own (`aria-keyshortcuts`); a closable tab adds Delete itself. */
	keyshortcuts?: string;
	onDoubleClick?: () => void;
	/** Classes on the tab's box: a width limit, a preview tab's italic. */
	className?: string;
} & (
	| { onClose?: undefined; closeLabel?: never }
	| {
			/** Closes this tab: its ✕, or Delete while it has focus. */
			onClose: () => void;
			/** The close action's accessible name and tooltip ("Close notes.md"). */
			closeLabel: string;
	  }
);

export type TabsVariant = "underline" | "segmented" | "pills";
export type TabsOrientation = "horizontal" | "vertical";

/** What moved the selection: a click (or Enter/Space on a tab), or an arrow, Home or End. */
export type TabChangeVia = "click" | "key";

export interface TabsProps extends DataAttributes {
	tabs: TabItem[];
	activeId: string;
	onChange: (id: string, via: TabChangeVia) => void;
	variant?: TabsVariant;
	/** Compact reduces height and type size for panel headers. */
	compact?: boolean;
	orientation?: TabsOrientation;
	className?: string;
	ariaLabel?: string;
}

const NEXT_KEYS: Record<TabsOrientation, string[]> = {
	horizontal: ["ArrowRight"],
	vertical: ["ArrowDown", "ArrowRight"],
};
const PREVIOUS_KEYS: Record<TabsOrientation, string[]> = {
	horizontal: ["ArrowLeft"],
	vertical: ["ArrowUp", "ArrowLeft"],
};

/** The box a tab is drawn in: its height, shape and the chosen state. */
function tabBox(variant: TabsVariant, active: boolean, compact: boolean | undefined): string {
	if (variant === "segmented") {
		return cx(
			"omp-pressable h-(--sc-hit-min) rounded-(--sc-radius-sm)",
			active
				? "bg-(--sc-elevated) text-(--sc-text) shadow-(--sc-shadow-sm)"
				: "text-(--sc-text-muted) hover:text-(--sc-text)",
		);
	}
	if (variant === "pills") {
		return cx(
			"transition-colors duration-(--sc-duration-fast) ease-(--sc-ease-standard) motion-reduce:transition-none",
			compact ? "h-(--sc-control-sm) rounded-(--sc-radius-sm)" : "h-(--sc-control-md) rounded-(--sc-radius-md)",
			active
				? "bg-(--sc-selected) text-(--sc-text)"
				: "text-(--sc-text-muted) hover:bg-(--sc-hover) hover:text-(--sc-text) active:bg-(--sc-pressed)",
		);
	}
	return cx(
		"-mb-px border-b-2 transition-colors duration-(--sc-duration-fast)",
		compact ? "h-8" : "h-9",
		active
			? "border-(--sc-accent) text-(--sc-text)"
			: "border-transparent text-(--sc-text-muted) hover:text-(--sc-text)",
	);
}

/** Where the label sits inside the box: type size, padding and, where the strip clips, an inset focus ring. */
function tabText(variant: TabsVariant, compact: boolean | undefined): string {
	return cx(
		"inline-flex min-w-0 max-w-full items-center gap-1 whitespace-nowrap disabled:cursor-not-allowed disabled:opacity-50",
		variant !== "pills" && "font-medium",
		// The track and a scrolling strip clip what sticks out of them, so the focus ring is drawn inside the tab.
		variant !== "underline" && "focus-visible:outline-offset-[calc(-1*var(--sc-focus-width))]",
		compact && variant === "pills" ? "text-sc-xs" : compact ? "text-sc-sm" : "text-sc-md",
		variant === "segmented" ? "px-2.5" : variant === "pills" && !compact ? "px-3" : "px-2",
	);
}

export function Tabs({
	tabs,
	activeId,
	onChange,
	variant = "underline",
	compact,
	orientation = "horizontal",
	className,
	ariaLabel,
	...data
}: TabsProps) {
	const listRef = useRef<HTMLDivElement>(null);
	const segmented = variant === "segmented";
	const vertical = orientation === "vertical";

	/** The tab Delete closed: once it has left the strip, focus goes to the tab chosen in its place. */
	const closedRef = useRef<string | null>(null);
	useEffect(() => {
		const closed = closedRef.current;
		if (closed === null || tabs.some(tab => tab.id === closed)) return;
		closedRef.current = null;
		const list = listRef.current;
		(
			list?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ??
			list?.querySelector<HTMLElement>('[role="tab"]')
		)?.focus();
	});

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Delete") {
			const focused = (event.target as HTMLElement).closest?.("[role=tab]")?.getAttribute("data-tab-id");
			const tab = tabs.find(item => item.id === (focused ?? activeId));
			if (!tab?.onClose || tab.disabled) return;
			event.preventDefault();
			closedRef.current = tab.id;
			tab.onClose();
			return;
		}
		const forward = NEXT_KEYS[orientation].includes(event.key);
		const back = PREVIOUS_KEYS[orientation].includes(event.key);
		if (!forward && !back && event.key !== "Home" && event.key !== "End") return;
		const enabled = tabs.filter(tab => !tab.disabled);
		if (enabled.length === 0) return;
		event.preventDefault();
		const current = enabled.findIndex(tab => tab.id === activeId);
		let next: number;
		if (event.key === "Home") next = 0;
		else if (event.key === "End") next = enabled.length - 1;
		else if (forward) next = (current + 1) % enabled.length;
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
	const selected = tabs.find(tab => tab.id === activeId);
	return (
		<>
			<div
				{...data}
				aria-label={ariaLabel}
				aria-orientation={vertical ? "vertical" : undefined}
				data-segmented={segmented || undefined}
				className={cx(
					"max-w-full [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
					vertical
						? "flex flex-col items-stretch gap-0.5 [html[data-shell=phone]_&]:flex-row [html[data-shell=phone]_&]:items-center [html[data-shell=phone]_&]:gap-1 [html[data-shell=phone]_&]:overflow-x-auto [html[data-shell=phone]_&]:py-[5px]"
						: "items-center overflow-x-auto overflow-y-hidden",
					!vertical &&
						(segmented
							? "inline-flex gap-0.5 rounded-(--sc-radius-md) bg-(--sc-surface-3) p-0.5"
							: variant === "pills"
								? "flex gap-1"
								: "flex gap-1 border-b border-(--sc-divider)"),
					className,
				)}
				onKeyDown={onKeyDown}
				ref={listRef}
				role="tablist"
			>
				{tabs.map(tab => {
					const active = tab.id === activeId;
					const box = cx(
						"relative max-w-full shrink-0",
						tabBox(variant, active, compact),
						vertical && "w-full [html[data-shell=phone]_&]:w-auto",
						tab.className,
					);
					const keys = [tab.keyshortcuts, tab.onClose && "Delete"].filter(Boolean).join(" ");
					const button = (
						<button
							{...tab.attrs}
							aria-keyshortcuts={keys || undefined}
							aria-selected={active}
							className={cx(
								tabText(variant, compact),
								vertical && "justify-start text-left",
								tab.onClose ? "h-full min-w-0 flex-1" : box,
							)}
							data-tab-id={tab.id}
							disabled={tab.disabled}
							key={tab.onClose ? undefined : tab.id}
							onClick={() => onChange(tab.id, "click")}
							onDoubleClick={tab.onDoubleClick}
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
					if (!tab.onClose) return button;
					return (
						<div className={cx("inline-flex items-center pr-0.5", box)} key={tab.id} role="presentation">
							{button}
							<IconButton
								aria-hidden
								disabled={tab.disabled}
								icon={<X />}
								label={tab.closeLabel}
								onClick={tab.onClose}
								size="sm"
								tabIndex={-1}
							/>
						</div>
					);
				})}
			</div>
			{selected?.onClose && !selected.disabled && (
				<IconButton
					className="sr-only focus-visible:not-sr-only"
					data-tabs-close-selected
					icon={<X />}
					label={selected.closeLabel}
					onClick={selected.onClose}
					size="sm"
				/>
			)}
		</>
	);
}
