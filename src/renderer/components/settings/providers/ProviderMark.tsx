/**
 * A provider's brand symbol, drawn from the vendored monochrome SVGs in the text color (color is
 * kept for state marks). A provider with no symbol gets the neutral glyph: its first letter in a
 * hairline square, the same footprint. Decorative: the provider's name always sits beside it.
 */

import { cx } from "../../../lib/format";
import { markArt, providerBrand } from "./provider-marks";

export function ProviderMark({
	provider,
	neutral = false,
	className,
}: {
	provider: { id: string; name: string };
	/** Always the first-letter glyph: a custom endpoint is the user's own, whatever id it borrows. */
	neutral?: boolean;
	className?: string;
}) {
	const { mark } = providerBrand(provider);
	if (neutral || mark === null) {
		return (
			<span
				aria-hidden
				className={cx(
					"flex size-5 shrink-0 items-center justify-center rounded-(--sc-radius-sm) border border-(--sc-border-subtle) text-sc-2xs leading-none font-medium text-(--sc-text-muted) uppercase select-none",
					className,
				)}
				data-provider-mark="fallback"
			>
				{Array.from(provider.name.trim())[0] ?? "?"}
			</span>
		);
	}
	const art = markArt(mark);
	return (
		<span
			aria-hidden
			className={cx("flex size-5 shrink-0 items-center justify-center text-(--sc-text-secondary)", className)}
			data-provider-mark={mark}
		>
			<svg
				className="size-4"
				fill="currentColor"
				fillRule={art.evenOdd ? "evenodd" : undefined}
				viewBox={art.viewBox}
			>
				{art.paths.map(d => (
					<path d={d} key={d} />
				))}
			</svg>
		</span>
	);
}
