/**
 * The composer's completion listbox (`/` commands, `@` files, `:` emoji): the rows of the open menu above the
 * field, the highlighted one `aria-selected`. The field keeps focus; a row is taken on mouse down.
 */
import { memo, useEffect } from "react";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import type { CompletionItem, CompletionMenu } from "./use-completion-menu";

export const CompletionList = memo(function CompletionList({
	menu,
	menuId,
	onPick,
}: {
	menu: CompletionMenu;
	/** The listbox id; row `i` is `${menuId}-${i}` (the field's `aria-activedescendant`). */
	menuId: string;
	onPick: (item: CompletionItem) => void;
}) {
	const t = useT();
	const menuIndex = menu.index;
	// Home/End/PageDown/↓ can land on a row below the listbox's fold.
	useEffect(() => {
		document.getElementById(`${menuId}-${menuIndex}`)?.scrollIntoView?.({ block: "nearest" });
	}, [menuId, menuIndex]);
	return (
		<div
			aria-label={t("input.completion.label")}
			className="absolute bottom-full left-0 z-(--sc-z-popover) mb-2 max-h-[60vh] w-[min(440px,100%)] overflow-y-auto rounded-(--sc-radius-lg) border border-(--sc-border-subtle) bg-(--sc-elevated) p-1 shadow-(--sc-shadow-md)"
			id={menuId}
			role="listbox"
		>
			{menu.items.map((item, index) => (
				<button
					aria-selected={index === menu.index}
					id={`${menuId}-${index}`}
					key={`${menu.source}:${item.label}`}
					type="button"
					role="option"
					onMouseDown={event => {
						event.preventDefault();
						onPick(item);
					}}
					title={item.description ? `${item.label}\n${item.description.replace(/\s+/g, " ").trim()}` : undefined}
					className={cx(
						"flex min-h-(--sc-control-md) w-full items-baseline gap-3 rounded-(--sc-radius-sm) px-2.5 py-1.5 text-left",
						index === menu.index ? "bg-(--sc-selected)" : "hover:bg-(--sc-hover)",
					)}
				>
					<span className="shrink-0 font-mono text-sc-md font-medium text-(--sc-text)">{item.label}</span>
					{item.description && (
						<span className="min-w-0 truncate text-sc-sm text-(--sc-text-muted)">{item.description}</span>
					)}
					{item.hint && (
						<span className="ml-auto shrink-0 font-mono text-sc-xs text-(--sc-text-subtle)">{item.hint}</span>
					)}
				</button>
			))}
		</div>
	);
});
