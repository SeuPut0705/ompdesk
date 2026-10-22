/**
 * The composer's completion listbox (`/` commands, `@` files, `:` emoji): the rows of the open menu above the
 * field, the highlighted one `aria-selected`, the matched characters of a row marked, and under the rows the keys
 * that work and notes on rows that are not shown. The field keeps focus; a row is taken on mouse down, and the
 * pointer moves the highlight like the history search's (one highlight, never a hover beside a selection).
 */
import { memo, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { currentShellMode, useShellInput } from "../../../hooks/use-shell-mode";
import { useT } from "../../../lib/i18n";
import { Kbd, OptionRow } from "../../common";
import type { CompletionItem, CompletionMenu } from "./use-completion-menu";

/** The label with the spans the query matched set in the accent colour (the history search's `<mark>` look). */
function HighlightedLabel({ label, ranges }: { label: string; ranges: readonly [number, number][] | undefined }) {
	if (!ranges || ranges.length === 0) return <>{label}</>;
	const parts: Array<{ text: string; mark: boolean }> = [];
	let cursor = 0;
	for (const [start, end] of ranges) {
		if (start > cursor) parts.push({ text: label.slice(cursor, start), mark: false });
		if (end > start) parts.push({ text: label.slice(start, end), mark: true });
		cursor = Math.max(cursor, end);
	}
	if (cursor < label.length) parts.push({ text: label.slice(cursor), mark: false });
	return (
		<>
			{parts.map((part, index) =>
				part.mark ? (
					<mark className="bg-transparent font-semibold text-(--sc-accent)" key={index}>
						{part.text}
					</mark>
				) : (
					part.text
				),
			)}
		</>
	);
}

/**
 * The room above the composer for the menu (a web shell only): from the anchor's top up to the pane's top, less a 16 px
 * margin, re-measured when the pane, the window or the visual viewport (the soft keyboard) resizes. The menu's own
 * `60vh` ceiling reached past the header when the keyboard left 190 px. `null` keeps the CSS ceiling.
 */
function useMenuRoom(menuRef: RefObject<HTMLElement | null>): number | null {
	const [room, setRoom] = useState<number | null>(null);
	useLayoutEffect(() => {
		const menu = menuRef.current;
		const anchor = menu?.parentElement;
		if (!menu || !anchor || currentShellMode() === null) return;
		const pane = menu.closest<HTMLElement>(".omp-session-pane");
		const measure = () => {
			const floor = pane?.getBoundingClientRect().top ?? 0;
			setRoom(Math.max(0, Math.floor(anchor.getBoundingClientRect().top - floor - 16)));
		};
		measure();
		window.addEventListener("resize", measure);
		window.visualViewport?.addEventListener("resize", measure);
		const observer = typeof ResizeObserver === "function" && pane ? new ResizeObserver(measure) : null;
		if (pane) observer?.observe(pane);
		return () => {
			window.removeEventListener("resize", measure);
			window.visualViewport?.removeEventListener("resize", measure);
			observer?.disconnect();
		};
	}, [menuRef]);
	return room;
}

export const CompletionList = memo(function CompletionList({
	menu,
	menuId,
	onPick,
	onHover,
}: {
	menu: CompletionMenu;
	/** The listbox id; row `i` is `${menuId}-${i}` (the field's `aria-activedescendant`). */
	menuId: string;
	onPick: (item: CompletionItem) => void;
	/** The pointer rests on row `index`: it becomes the highlighted one. */
	onHover: (index: number) => void;
}) {
	const t = useT();
	const menuIndex = menu.index;
	// Home/End/PageDown/↓ can land on a row below the listbox's fold.
	useEffect(() => {
		document.getElementById(`${menuId}-${menuIndex}`)?.scrollIntoView?.({ block: "nearest" });
	}, [menuId, menuIndex]);
	const footer = menu.footer;
	/** Key hints are for a hardware keyboard: a touch screen (phone or tablet) shows the notes only. */
	const touch = useShellInput() === "touch";
	const ref = useRef<HTMLDivElement>(null);
	const room = useMenuRoom(ref);
	return (
		<div
			className="absolute bottom-full left-0 z-(--sc-z-popover) mb-2 flex max-h-[60vh] w-[min(440px,100%)] flex-col overflow-hidden rounded-(--sc-radius-lg) border border-(--sc-border-subtle) bg-(--sc-elevated) shadow-(--sc-shadow-md)"
			data-completion-menu={menu.source}
			ref={ref}
			style={room === null ? undefined : { maxHeight: room }}
		>
			<div
				aria-label={t("input.completion.label")}
				className="min-h-0 flex-1 overflow-y-auto p-1"
				id={menuId}
				role="listbox"
			>
				{menu.items.map((item, index) => (
					<OptionRow
						pointerMoves
						active={index === menu.index}
						// The name is the label; the description reads once, as the option's description.
						aria-label={item.label}
						aria-description={item.description ? item.description.replace(/\s+/g, " ").trim() : undefined}
						id={`${menuId}-${index}`}
						key={`${menu.source}:${item.label}`}
						size="sm"
						onMouseDown={event => {
							event.preventDefault();
							onPick(item);
						}}
						onMouseMove={() => {
							if (index !== menu.index) onHover(index);
						}}
						title={
							item.description ? `${item.label}\n${item.description.replace(/\s+/g, " ").trim()}` : undefined
						}
						className="items-baseline gap-3 rounded-(--sc-radius-sm)"
					>
						<span className="shrink-0 font-mono text-sc-md font-medium text-(--sc-text)">
							<HighlightedLabel label={item.label} ranges={item.highlights} />
						</span>
						{item.description && (
							<span className="min-w-0 truncate text-sc-sm text-(--sc-text-muted)">{item.description}</span>
						)}
						{item.hint && (
							<span className="ml-auto shrink-0 font-mono text-sc-xs text-(--sc-text-subtle)">{item.hint}</span>
						)}
					</OptionRow>
				))}
			</div>
			{footer && (!touch || footer.notes.length > 0) && (
				<div
					className="shrink-0 border-t border-(--sc-divider) px-3 py-1.5 text-sc-xs text-(--sc-text-muted)"
					data-menu-footer
				>
					{footer.notes.map(note => (
						<div className="truncate py-0.5" data-menu-note key={note} title={note}>
							{note}
						</div>
					))}
					{!touch && (
						<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
							{footer.hints.map(hint => (
								<span className="flex items-center gap-1.5" key={hint.keys}>
									{hint.keys.split(" ").map(key => (
										<Kbd key={key} shortcut={key} />
									))}
									{hint.label}
								</span>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
});

/**
 * The polite status that goes with the listbox: "N suggestions" while a menu is open, "No suggestions" once a
 * trigger found nothing and the menu closed. Always mounted (a live region announces what changes inside it).
 */
export function CompletionStatus({ count, empty }: { count: number; empty: boolean }) {
	const t = useT();
	return (
		<div aria-live="polite" className="sr-only" data-completion-status role="status">
			{count > 0 ? t("input.menu.count", { count }) : empty ? t("input.menu.none") : ""}
		</div>
	);
}
