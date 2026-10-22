import { AUTOPILOT_AREAS, type AutopilotArea } from "../../../../resources/gui-bridge/modes/autopilot-contracts";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { AreaIcon } from "./AreaIcon";

/** Focus areas as toggles: an empty set means every area. Shared by the start sheet and the work board. */
export function FocusChips({
	focus,
	onToggle,
	disabled,
	compact,
}: {
	focus: readonly AutopilotArea[];
	onToggle: (area: AutopilotArea) => void;
	disabled?: boolean;
	/** Tighter chips for the Mode popover, where the seven areas wrap within two rows. */
	compact?: boolean;
}) {
	const t = useT();
	return (
		<div
			className={cx("flex flex-wrap", compact ? "gap-1" : "gap-1.5")}
			data-autopilot-focus
			role="group"
			aria-label={t("autopilot.focus.label")}
		>
			{AUTOPILOT_AREAS.map(area => {
				const on = focus.includes(area);
				return (
					<button
						aria-pressed={on}
						className={cx(
							"inline-flex h-6 items-center rounded-full border text-sc-xs transition-colors disabled:opacity-50",
							compact ? "gap-1 px-1.5" : "gap-1 px-2",
							on
								? "border-(--sc-accent) bg-(--sc-accent-soft) text-(--sc-accent-on-soft)"
								: "border-(--sc-border) text-(--sc-text-secondary) hover:bg-(--sc-surface-2)",
						)}
						data-focus-area={area}
						disabled={disabled}
						key={area}
						onClick={() => onToggle(area)}
						type="button"
					>
						<AreaIcon area={area} />
						{t(`autopilot.area.${area}`)}
					</button>
				);
			})}
		</div>
	);
}
