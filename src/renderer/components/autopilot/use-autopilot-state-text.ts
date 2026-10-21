import { useT } from "../../lib/i18n";
import { useAutopilotStore } from "../../stores/autopilot";
import { autopilotChip } from "./autopilot-view";

/**
 * The one-line state the work board, the strip, the composer chip and the dock share ("Cycle 7 · Performance",
 * "Ending…", "Paused: …"); null for a session that is no live run. Its own module: the phone's first screen reads it
 * (the strip, the chip) while the run's board sections load on demand.
 */
export function useAutopilotStateText(): string | null {
	const t = useT();
	const status = useAutopilotStore(s => s.status);
	const chip = autopilotChip(status);
	if (!chip) return null;
	switch (chip.kind) {
		case "stopping":
			return t("autopilot.stopping");
		case "paused":
			return chip.reason ? t(`autopilot.reason.${chip.reason}`) : t("autopilot.state.paused");
		case "quota":
			return chip.until === undefined
				? t("autopilot.state.waiting_quota")
				: t("autopilot.chip.quotaUntil", {
						time: new Date(chip.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
					});
		default:
			return chip.cycle > 0
				? chip.area
					? t("autopilot.cycleArea", { n: chip.cycle, area: t(`autopilot.area.${chip.area}`) })
					: t("autopilot.cycleN", { n: chip.cycle })
				: t("autopilot.state.running");
	}
}
