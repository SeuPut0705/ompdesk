/**
 * The info glyph behind which a row's longer description lives, and the length rule that decides what reads inline.
 * Shared by the Settings rows (`SettingsRow`, `SettingsSwitchRow`), `SwitchField` and the Mode popover rows, so one
 * description is shown the same way everywhere: a short clause inline, anything longer behind an (i) tooltip.
 */

import { Info } from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { Tooltip } from "./Tooltip";

/** A string description up to this long reads inline next to the label; longer ones sit behind an info tooltip. */
export const INLINE_DESCRIPTION_MAX = 56;

/**
 * A description split by length: `inline` text is a short muted line, `tip` text lives behind
 * `SettingInfo` (and stays in the DOM as screen-reader text), `note` is any other node, kept visible.
 * `forceTip` sends every string to the tooltip, for a surface too narrow to read even a short clause inline.
 */
export function splitDescription(
	description: ReactNode,
	forceTip = false,
): { inline?: string; tip?: string; note?: ReactNode } {
	if (description === undefined || description === null || description === false) return {};
	if (typeof description !== "string") return { note: description };
	return description.length <= INLINE_DESCRIPTION_MAX && !forceTip ? { inline: description } : { tip: description };
}

/** The info glyph that shows a long description on hover and keyboard focus; the text stays in the DOM for screen readers. */
export function SettingInfo({ text }: { text: string }) {
	const t = useT();
	return (
		<>
			<Tooltip content={text} describe={false}>
				<button
					aria-label={t("settings.rowInfo")}
					className="inline-flex size-(--sc-icon-md) shrink-0 items-center justify-center rounded-(--sc-radius-sm) text-(--sc-text-muted) hover:text-(--sc-text) focus-visible:outline-(length:--sc-focus-width) focus-visible:outline-(--sc-focus-ring)"
					data-setting-info
					type="button"
				>
					<Info aria-hidden className="size-(--sc-icon-sm)" />
				</button>
			</Tooltip>
			<span className="sr-only">{text}</span>
		</>
	);
}
