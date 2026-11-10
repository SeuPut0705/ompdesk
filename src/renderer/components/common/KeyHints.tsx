/**
 * KeyHints — the footer row of keys a picker answers to ("↑ ↓ move · ↵ open · ⎋ close"): each hint is its keys as
 * `Kbd` chips and one word for what they do, in the order the picker gives them, across the foot of its list. Every
 * picker (`Modal size="picker"`: the command palette, quick open, the model picker, the history search, the theme
 * picker) draws its keys with this row, the same way, or not at all. `children` ends the row with an action that is
 * no key (the model picker's Manage providers). Keys mean nothing under a finger: on a touch screen the hints are left
 * out and the row shows only its `children`, or nothing.
 */

import type { ReactNode } from "react";
import { useShellInput } from "../../hooks/use-shell-mode";
import { cx } from "../../lib/format";
import { Kbd } from "./Kbd";

type DataAttributes = { [key: `data-${string}`]: string | number | boolean | undefined };

export interface KeyHint {
	/** macOS-spelled keys, one `Kbd` each ("↑", "↓"; "⌘↵"). */
	keys: string[];
	/** What they do, one word or two ("move", "open"). */
	label: string;
}

export interface KeyHintsProps extends DataAttributes {
	hints: KeyHint[];
	/** At the row's end; stays on a touch screen. */
	children?: ReactNode;
	className?: string;
}

export function KeyHints({ hints, children, className, ...data }: KeyHintsProps) {
	const touch = useShellInput() === "touch";
	if (touch && !children) return null;
	return (
		<div
			{...data}
			className={cx(
				"flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-(--sc-divider) px-3 py-1.5 text-sc-xs text-(--sc-text-muted)",
				className,
			)}
		>
			{!touch &&
				hints.map(hint => (
					<span className="flex shrink-0 items-center gap-1.5" data-key-hint key={hint.label}>
						{hint.keys.map(key => (
							<Kbd key={key} shortcut={key} />
						))}
						{hint.label}
					</span>
				))}
			{children && <span className="ml-auto flex shrink-0 items-center">{children}</span>}
		</div>
	);
}
