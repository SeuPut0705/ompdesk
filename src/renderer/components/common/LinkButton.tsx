/**
 * LinkButton — an action that reads as a link inside text: a provider named in a sentence, "Add a note" under an
 * answer, a commit hash in a row. It takes the surrounding font size and line, underlines on hover, and draws the one
 * focus ring. `accent` (default) for a link-like action, `muted` for a quiet secondary one. Opening a web address
 * goes through it too (lib/open-external.ts in `onClick`). An action that stands on its own is a `Button`.
 */

import type { ComponentProps } from "react";
import { cx } from "../../lib/format";

export interface LinkButtonProps extends ComponentProps<"button"> {
	tone?: "accent" | "muted";
}

const TONE = {
	accent: "text-(--sc-accent)",
	muted: "text-(--sc-text-muted) hover:text-(--sc-text)",
} as const;

export function LinkButton({ tone = "accent", className, type, ...rest }: LinkButtonProps) {
	return (
		<button
			{...rest}
			className={cx(
				"inline cursor-pointer rounded-(--sc-radius-sm) text-left underline-offset-2 hover:underline focus-visible:outline-(length:--sc-focus-width) focus-visible:outline-(--sc-focus-ring) disabled:cursor-not-allowed disabled:opacity-50",
				TONE[tone],
				className,
			)}
			type={type ?? "button"}
		/>
	);
}
