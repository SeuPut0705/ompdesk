/**
 * DisclosureButton — the header that opens and folds the content under it (a diff file, a context entry, an
 * Advanced group, a list section): a chevron that turns as it opens, then the caller's label and figures. It owns
 * `aria-expanded`, the chevron (decorative, `.omp-disclosure-chevron` for the shared turn), the full-width row and
 * the focus ring; the caller sizes, colours and fills the row. A settings section's own disclosure is
 * `SettingsAdvanced`; a section of a page that persists its fold says so through `open` and `onToggle`.
 */

import { ChevronRight } from "lucide-react";
import type { ComponentProps } from "react";
import { cx } from "../../lib/format";

export interface DisclosureButtonProps extends Omit<ComponentProps<"button">, "type" | "onClick"> {
	open: boolean;
	onToggle: () => void;
	/** The chevron's own classes (size and colour); `size-(--sc-icon-sm)` and muted by default. */
	chevronClassName?: string;
}

export function DisclosureButton({
	open,
	onToggle,
	chevronClassName,
	className,
	children,
	...rest
}: DisclosureButtonProps) {
	return (
		<button
			{...rest}
			aria-expanded={open}
			className={cx(
				"flex w-full items-center gap-2 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--sc-focus-ring)",
				className,
			)}
			onClick={onToggle}
			type="button"
		>
			<ChevronRight
				aria-hidden
				className={cx(
					"omp-disclosure-chevron shrink-0",
					chevronClassName ?? "size-(--sc-icon-sm) text-(--sc-text-muted)",
				)}
				// `transform`, which `.omp-disclosure-chevron` eases (Tailwind's `rotate-*` sets `rotate` instead).
				style={open ? { transform: "rotate(90deg)" } : undefined}
			/>
			{children}
		</button>
	);
}
