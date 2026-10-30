import { PackageCheck, Pause, Play, Square } from "lucide-react";
import { useState } from "react";
import { useT } from "../../lib/i18n";
import { useAutopilotStore } from "../../stores/autopilot";
import { Button, ConfirmDialog, IconButton } from "../common";
import { useAutopilotActions } from "./use-autopilot-actions";

/**
 * A run's three controls in one row (the user's layout, 23 Oct 2026): Pause as a toggle (Resume while paused), Ship
 * then stop (the run lands its work and releases when a release is due, then ends; pressed again it cancels) and Stop
 * now. Stop now asks first while a push or a release is under way, since it may be half done. On the board the three
 * share the row in equal thirds, each its icon over its name, so the names fit a 264 px board in both languages;
 * `compact` draws icons alone (their names are the tooltip and the accessible name) for the dock's one-line row.
 */
export function AutopilotControls({ compact = false }: { compact?: boolean }) {
	const t = useT();
	const state = useAutopilotStore(s => s.status.state);
	const inFlight = useAutopilotStore(s => s.status.ship?.inFlight);
	const shipThenStop = useAutopilotStore(s => s.status.ship?.endAfterShip === true);
	const { pending, run } = useAutopilotActions();
	const [confirming, setConfirming] = useState(false);
	const stopping = state === "stopping";
	const finished = state === "ended";
	const paused = state === "paused";
	const busy = pending !== null;

	const pause = {
		label: paused ? t("autopilot.resume") : t("autopilot.pause"),
		title: paused ? t("autopilot.resumeTitle") : t("autopilot.pauseTitle"),
		icon: paused ? <Play aria-hidden /> : <Pause aria-hidden />,
		disabled: busy || (!paused && state !== "running" && state !== "waiting_quota"),
		loading: pending === "pause" || pending === "resume",
		onClick: () => void run({ action: paused ? "resume" : "pause" }),
	};
	const ship = {
		label: stopping ? t("autopilot.stopping") : t("autopilot.shipThenStop"),
		title: shipThenStop ? t("autopilot.shipThenStopArmed") : t("autopilot.shipThenStopTitle"),
		icon: <PackageCheck aria-hidden />,
		disabled: busy || stopping || finished,
		loading: pending === "stop_after_ship",
		onClick: () => void run({ action: "stop_after_ship", enabled: !shipThenStop }),
	};
	const abort = {
		label: t("autopilot.abort"),
		title: t("autopilot.abortTitle"),
		icon: <Square aria-hidden className="fill-current" />,
		disabled: busy || finished,
		loading: pending === "abort",
		onClick: () => (inFlight ? setConfirming(true) : void run({ action: "abort" })),
	};

	return (
		<>
			{compact ? (
				<>
					<IconButton
						data-autopilot-pause={paused ? undefined : ""}
						data-autopilot-resume={paused ? "" : undefined}
						disabled={pause.disabled}
						icon={pause.icon}
						label={pause.label}
						loading={pause.loading}
						onClick={pause.onClick}
						size="sm"
					/>
					<IconButton
						data-autopilot-ship-stop
						disabled={ship.disabled}
						icon={ship.icon}
						label={ship.label}
						loading={ship.loading}
						onClick={ship.onClick}
						pressed={shipThenStop}
						size="sm"
					/>
					<IconButton
						data-autopilot-abort
						disabled={abort.disabled}
						icon={abort.icon}
						label={abort.label}
						loading={abort.loading}
						onClick={abort.onClick}
						size="sm"
						variant="danger-soft"
					/>
				</>
			) : (
				<div className="flex min-w-0 flex-1 flex-wrap gap-1" data-autopilot-control-row>
					<Button
						className="h-auto! min-h-(--sc-control-lg) min-w-fit flex-1 px-2! py-1 text-sc-xs!"
						data-autopilot-pause={paused ? undefined : ""}
						data-autopilot-resume={paused ? "" : undefined}
						disabled={pause.disabled}
						icon={pause.icon}
						loading={pause.loading}
						onClick={pause.onClick}
						size="sm"
						title={pause.title}
						variant={paused ? "primary" : "secondary"}
					>
						<span className="max-w-full truncate">{pause.label}</span>
					</Button>
					<Button
						aria-pressed={shipThenStop}
						className="h-auto! min-h-(--sc-control-lg) min-w-fit flex-1 px-2! py-1 text-sc-xs!"
						data-autopilot-ship-stop
						disabled={ship.disabled}
						icon={ship.icon}
						loading={ship.loading}
						onClick={ship.onClick}
						size="sm"
						title={ship.title}
						variant={shipThenStop ? "primary" : "secondary"}
					>
						<span className="max-w-full truncate">{ship.label}</span>
					</Button>
					<Button
						className="h-auto! min-h-(--sc-control-lg) min-w-fit flex-1 px-2! py-1 text-sc-xs!"
						data-autopilot-abort
						disabled={abort.disabled}
						icon={abort.icon}
						loading={abort.loading}
						onClick={abort.onClick}
						size="sm"
						title={abort.title}
						variant="danger-soft"
					>
						<span className="max-w-full truncate">{abort.label}</span>
					</Button>
				</div>
			)}
			<ConfirmDialog
				confirmLabel={t("autopilot.abortConfirm.action")}
				message={t(inFlight?.kind === "release" ? "autopilot.abortConfirm.release" : "autopilot.abortConfirm.push")}
				onCancel={() => setConfirming(false)}
				onConfirm={() => {
					setConfirming(false);
					void run({ action: "abort" });
				}}
				open={confirming}
				title={t("autopilot.abortConfirm.title")}
				warning={t("autopilot.abortConfirm.warning")}
			/>
		</>
	);
}
