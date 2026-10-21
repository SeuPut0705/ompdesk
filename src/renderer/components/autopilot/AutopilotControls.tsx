import { Pause, Play, Square } from "lucide-react";
import { useState } from "react";
import { useT } from "../../lib/i18n";
import { useAutopilotStore } from "../../stores/autopilot";
import { Button, ConfirmDialog } from "../common";
import { useAutopilotActions } from "./use-autopilot-actions";

/**
 * End (after the cycle in progress) and abort (now): the two ways to stop a run. Abort asks first while a push or a
 * release is under way, since it may be half done. Shared by the work board, the dock row and the Mode tab.
 */
export function AutopilotStopButtons({ size = "sm" }: { size?: "sm" | "md" }) {
	const t = useT();
	const state = useAutopilotStore(s => s.status.state);
	const inFlight = useAutopilotStore(s => s.status.ship?.inFlight);
	const { pending, run } = useAutopilotActions();
	const [confirming, setConfirming] = useState(false);
	const stopping = state === "stopping";
	const finished = state === "ended";
	return (
		<>
			<Button
				data-autopilot-stop
				disabled={stopping || finished || pending !== null}
				loading={pending === "stop"}
				onClick={() => void run({ action: "stop" })}
				size={size}
				title={t("autopilot.stopTitle")}
				variant="secondary"
			>
				{stopping ? t("autopilot.stopping") : t("autopilot.stop")}
			</Button>
			<Button
				data-autopilot-abort
				disabled={finished || pending !== null}
				icon={<Square aria-hidden className="fill-current" />}
				loading={pending === "abort"}
				onClick={() => (inFlight ? setConfirming(true) : void run({ action: "abort" }))}
				size={size}
				title={t("autopilot.abortTitle")}
				variant="danger"
			>
				{t("autopilot.abort")}
			</Button>
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

/** Pause or resume the run (the Goal stays; the cycle in progress finishes first). */
export function AutopilotPauseButton({ size = "sm" }: { size?: "sm" | "md" }) {
	const t = useT();
	const state = useAutopilotStore(s => s.status.state);
	const { pending, run } = useAutopilotActions();
	if (state === "paused") {
		return (
			<Button
				data-autopilot-resume
				icon={<Play aria-hidden />}
				loading={pending === "resume"}
				onClick={() => void run({ action: "resume" })}
				size={size}
				variant="primary"
			>
				{t("autopilot.resume")}
			</Button>
		);
	}
	return (
		<Button
			data-autopilot-pause
			disabled={state !== "running" && state !== "waiting_quota"}
			icon={<Pause aria-hidden />}
			loading={pending === "pause"}
			onClick={() => void run({ action: "pause" })}
			size={size}
			title={t("autopilot.pauseTitle")}
			variant="secondary"
		>
			{t("autopilot.pause")}
		</Button>
	);
}
