import { AUTOPILOT_AREAS, type AutopilotArea } from "../../../../resources/gui-bridge/modes/autopilot-contracts";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { Chip } from "../common";
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
	/** Tighter rows for the Mode popover, where the seven areas wrap within two rows. */
	compact?: boolean;
}) {
	const t = useT();
	return (
		<div
			aria-label={t("autopilot.focus.label")}
			className={cx("flex flex-wrap", compact ? "gap-1" : "gap-1.5")}
			data-focus-chips
			role="group"
		>
			{AUTOPILOT_AREAS.map(area => (
				<Chip
					data-focus-area={area}
					disabled={disabled}
					icon={<AreaIcon area={area} />}
					key={area}
					onPressedChange={() => onToggle(area)}
					pressed={focus.includes(area)}
				>
					{t(`autopilot.area.${area}`)}
				</Chip>
			))}
		</div>
	);
}
