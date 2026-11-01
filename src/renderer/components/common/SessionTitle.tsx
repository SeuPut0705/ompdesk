/**
 * SessionTitle — a session's name on one line. When the person renamed the session and the automatic title still
 * differs, both show: `<name> · <automatic title>`, the name first at the surface's own weight, the automatic one in the
 * muted text colour. The automatic title gives way first: the name keeps the line (`max-w-full`, truncating only
 * when it alone is wider than the line), the automatic part takes what is left and ends in an ellipsis. Without an
 * automatic part the name stands alone, so a session nobody renamed looks as before.
 *
 * `parts` come from `lib/session-title.ts` (`sessionDisplayParts`, `sessionTitleParts`, `tabChipParts`). `live` (a
 * working cue, or null for none) puts the surface's `LiveText` shimmer on the name; leave it out where the title does
 * not shimmer. `swapScope` (a session's id) eases the name in when it changes (`SwapText`). `min-w-0`: give it a
 * flexible parent. The whole line's tooltip (`title`, unless `noTooltip`) is the combined string; a surface that
 * names itself for screen readers uses `combinedTitle(parts)` as well.
 */

import { cx } from "../../lib/format";
import { combinedTitle, type TitleParts } from "../../lib/session-title";
import { type LiveState, LiveText } from "./LiveShimmer";
import { SwapText } from "./SwapText";

export interface SessionTitleProps {
	parts: TitleParts;
	/** The working cue on the name (`LiveText`); undefined draws plain text. */
	live?: LiveState | null;
	/** Eases the name in when it changes within this scope; for the title bar. */
	swapScope?: string;
	/** The surface has a tooltip of its own: skip the native `title`. */
	noTooltip?: boolean;
	/** Classes of the name (weight, colour); the automatic part is always muted. */
	titleClassName?: string;
	className?: string;
}

export function SessionTitle({ parts, live, swapScope, noTooltip, titleClassName, className }: SessionTitleProps) {
	const combined = combinedTitle(parts);
	const name = swapScope === undefined ? parts.title : <SwapText scope={swapScope}>{parts.title}</SwapText>;
	return (
		<span
			className={cx("flex min-w-0 items-baseline whitespace-nowrap", className)}
			data-session-title
			title={noTooltip ? undefined : combined}
		>
			<span className={cx("max-w-full shrink-0 truncate", titleClassName)} data-title-name>
				{live === undefined ? (
					name
				) : (
					<LiveText state={live} text={parts.title}>
						{name}
					</LiveText>
				)}
			</span>
			{parts.auto && (
				<span className="flex min-w-0 items-baseline gap-1 overflow-hidden pl-1 font-normal text-(--sc-text-muted)">
					<span className="shrink-0">·</span>
					<span className="min-w-0 truncate text-(--sc-text-muted)" data-title-auto>
						{parts.auto}
					</span>
				</span>
			)}
		</span>
	);
}
