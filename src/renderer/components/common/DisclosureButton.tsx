/**
 * DisclosureButton — the header that opens and folds the content under it (a diff file, a context entry, an
 * Advanced group, a list section): a chevron that turns as it opens, and the caller's label and figures. It owns
 * `aria-expanded`, the chevron (decorative, `.omp-disclosure-chevron` for the shared turn), the full-width row and
 * the focus ring; the caller sizes, colours and fills the row. A settings section's own disclosure is
 * `SettingsAdvanced`; a section of a page that persists its fold says so through `open` and `onToggle`.
 *
 * `chevron` places it: `start` (default) before the label, `end` after everything (a card's header whose row ends in
 * its fold mark: a dock card, a skill's header, the usage block), `none` where the row cannot open now (a cleared
 * list: pass `disabled` too). It is the same chevron everywhere, pointing right and turning down as it opens.
 */

import { ChevronRight } from "lucide-react";
import type { ComponentProps } from "react";
import { cx } from "../../lib/format";

export type DisclosureChevron = "start" | "end" | "none";

export interface DisclosureButtonProps extends Omit<ComponentProps<"button">, "type" | "onClick"> {
	open: boolean;
	onToggle: () => void;
	/** Where the chevron sits; `none` draws none. */
	chevron?: DisclosureChevron;
	/** The chevron's own classes (size and colour); `size-(--sc-icon-sm)` and muted by default. */
	chevronClassName?: string;
	/** As wide as its label (a toggle inside text: thinking, a summary's details) instead of the whole row. */
	inline?: boolean;
}

export function DisclosureButton({
	open,
	onToggle,
	chevron = "start",
	chevronClassName,
	inline,
	className,
	children,
	...rest
}: DisclosureButtonProps) {
	const mark =
		chevron === "none" ? null : (
			<ChevronRight
				aria-hidden
				className={cx(
					"omp-disclosure-chevron shrink-0",
					chevronClassName ?? "size-(--sc-icon-sm) text-(--sc-text-muted)",
				)}
				// `.omp-disclosure-chevron` eases both `transform` and `rotate` (styles/chevron-motion.test.ts).
				style={open ? { transform: "rotate(90deg)" } : undefined}
			/>
		);
	return (
		<button
			{...rest}
			aria-expanded={open}
			className={cx(
				"flex items-center gap-2 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--sc-focus-ring)",
				inline ? "w-fit max-w-full" : "w-full",
				className,
			)}
			onClick={onToggle}
			type="button"
		>
			{chevron === "start" && mark}
			{children}
			{chevron === "end" && mark}
		</button>
	);
}
