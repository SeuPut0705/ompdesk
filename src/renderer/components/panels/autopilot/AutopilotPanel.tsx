import { Rocket } from "lucide-react";
import { useMemo } from "react";
import { useT } from "../../../lib/i18n";
import { useAutopilotStore } from "../../../stores/autopilot";
import { useUiStore } from "../../../stores/ui";
import { Button, EmptyState } from "../../common";
import { AreaMix } from "./AreaMix";
import { AutopilotBacklog } from "./AutopilotBacklog";
import { AutopilotControls } from "./AutopilotControls";
import { AutopilotHeader } from "./AutopilotHeader";
import { AutopilotNow } from "./AutopilotNow";
import { AutopilotTimeline } from "./AutopilotTimeline";
import { overnightSummary } from "./autopilot-view";
import { OvernightCard, useAwaySince } from "./OvernightCard";
import { ShipBox } from "./ShipBox";

/**
 * The Autopilot screen (side panel view `autopilot`): the run's state, what it is doing, the area mix and focus, the
 * pinned backlog, the cycle timeline and shipping, with the controls at the foot. It derives nothing of its own: the
 * whole run is the store's `AutopilotStatus` (`get_autopilot` / `autopilot_update`).
 */
export function AutopilotPanel() {
	const t = useT();
	const active = useAutopilotStore(s => s.status.active);
	const cycles = useAutopilotStore(s => s.status.cycles);
	const ship = useAutopilotStore(s => s.status.ship);
	const [awaySince, dismissAway] = useAwaySince();
	const away = useMemo(
		() =>
			awaySince === null ? null : overnightSummary({ cycles: cycles ?? [], since: awaySince, ship: ship?.queue }),
		[awaySince, cycles, ship?.queue],
	);
	if (!active) {
		return (
			<EmptyState
				actions={
					<Button onClick={() => useUiStore.getState().openModes("autopilot")} size="sm" variant="secondary">
						{t("autopilot.empty.open")}
					</Button>
				}
				description={t("autopilot.empty.description")}
				icon={<Rocket aria-hidden />}
				size="sm"
				title={t("autopilot.empty.title")}
			/>
		);
	}
	const showAway = away !== null && (away.cycles > 0 || away.pushes > 0 || away.failedShips > 0);
	return (
		<div className="flex min-h-0 flex-1 flex-col" data-autopilot-panel>
			<div className="min-h-0 flex-1 overflow-y-auto">
				{showAway && <OvernightCard onDismiss={dismissAway} summary={away} />}
				<AutopilotHeader />
				<AutopilotNow />
				<AreaMix />
				<AutopilotBacklog />
				<AutopilotTimeline />
				<ShipBox />
			</div>
			<AutopilotControls />
		</div>
	);
}
