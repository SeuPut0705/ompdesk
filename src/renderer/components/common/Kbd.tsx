/**
 * Kbd — the one way to show a keyboard shortcut.
 *
 * Pass the macOS spelling ("⌘K", "⇧⌘T", "⌘K / ⌃K"); formatShortcut renders
 * it for the running platform ("Ctrl+K" on Windows). One chip per
 * alternative. Never bake shortcuts into labels ("Agents (⌥A)"): put a Kbd
 * right-aligned in the row, or pass `shortcut` to Tooltip / IconButton.
 */

import { cx } from "../../lib/format";
import { formatShortcut } from "../../lib/keymap";

export interface KbdProps {
	/** macOS-spelled shortcut label; alternatives separated by " / ". */
	shortcut: string;
	className?: string;
}

export function Kbd({ shortcut, className }: KbdProps) {
	const alternatives = formatShortcut(shortcut).split(" / ");
	return (
		<span className={cx("inline-flex shrink-0 items-center gap-1", className)}>
			{alternatives.map(chord => (
				<kbd
					className="inline-flex h-5 min-w-5 items-center justify-center rounded-(--sc-radius-xs) border border-(--sc-border-subtle) bg-(--sc-surface-2) px-1.5 font-(family-name:--sc-font-sans) text-sc-xs leading-none font-medium whitespace-nowrap text-(--sc-text-muted)"
					key={chord}
				>
					{chord}
				</kbd>
			))}
		</span>
	);
}
