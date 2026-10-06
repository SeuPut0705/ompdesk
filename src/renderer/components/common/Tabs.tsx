/**
 * Tabs — switch between sibling views of ONE surface, with roving
 * arrow-key navigation (←/→, Home/End).
 *
 * - `underline` (default): section tabs at the top of a page, panel or
 *   dialog (Agents: Definitions · Live · PRs; inspector: Changes · Files · Logs).
 * - `segmented`: a compact mode switch inside a toolbar (Plan · Goal · Loop,
 *   This session · All sessions). 2–4 short options.
 * Tabs never navigate away and never trigger actions; destinations live in
 * the sidebar. Pass `ariaLabel`, and label the panels with the tab ids.
 */

import { type KeyboardEvent, useRef } from "react";
import { cx } from "../../lib/format";

export interface TabItem {
	id: string;
	label: string;
	/** Optional badge count or marker rendered after the label. */
	badge?: string | number;
	disabled?: boolean;
}

export type TabsVariant = "underline" | "segmented";

export interface TabsProps {
	tabs: TabItem[];
	activeId: string;
	onChange: (id: string) => void;
	variant?: TabsVariant;
	/** Compact reduces height and type size for panel headers. */
	compact?: boolean;
	className?: string;
	ariaLabel?: string;
}

export function Tabs({ tabs, activeId, onChange, variant = "underline", compact, className, ariaLabel }: TabsProps) {
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
		else next = (current - 1 + enabled.length) % enabled.length;
		onChange(enabled[next].id);
		requestAnimationFrame(() => {
			listRef.current?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(enabled[next].id)}"]`)?.focus();
		});
	};

	return (
		<div
			aria-label={ariaLabel}
			className={cx(
				segmented
					? "inline-flex items-center gap-0.5 rounded-(--sc-radius-md) bg-(--sc-surface-3) p-0.5"
					: "flex items-center gap-1 border-b border-(--sc-divider)",
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
						aria-selected={active}
						className={cx(
							"relative inline-flex shrink-0 items-center font-medium whitespace-nowrap transition-colors duration-(--sc-duration-fast) disabled:cursor-not-allowed disabled:opacity-50",
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
						onClick={() => onChange(tab.id)}
						role="tab"
						tabIndex={active ? 0 : -1}
						type="button"
					>
						{tab.label}
						{tab.badge !== undefined && (
							<span className="ml-1.5 rounded-(--sc-radius-full) bg-(--sc-surface-3) px-1.5 text-sc-2xs tabular-nums text-(--sc-text-muted)">
								{tab.badge}
							</span>
						)}
					</button>
				);
			})}
		</div>
	);
}
