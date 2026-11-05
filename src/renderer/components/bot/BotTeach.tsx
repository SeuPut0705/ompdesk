/**
 * Showing the bot a workflow (`main/agent-control/bot-teach.ts`): Record starts the owner's demonstration, Stop hands
 * the bot what they did so it writes a skill from it, Cancel drops it. Whether a recording runs, and since when, is
 * the desk main sends (`BotDeskState.teaching`), for this computer's bot or a paired host's (`device`): the actions
 * go to that bot's computer, and the control follows the desk, so a recording started on another window or device
 * shows here too. Failures toast; Stop of a recording with nothing in it says so and sends nothing.
 */
import { CircleDot } from "lucide-react";
import { useState } from "react";
import type { BotTeachRequest } from "../../../shared/bot-teach";
import { formatElapsed } from "../../lib/format";
import { translate, useT } from "../../lib/i18n";
import { useNowTick } from "../../lib/now-tick";
import { useBotDesk, useBotDeskStore } from "../../stores/bot-desk";
import { toast, toastError } from "../../stores/toast";
import { Badge, Button } from "../common";

const FAILED: Record<BotTeachRequest["action"], string> = {
	start: "botTeach.startFailed",
	stop: "botTeach.stopFailed",
	cancel: "botTeach.cancelFailed",
};

async function send(action: BotTeachRequest["action"], device: string | undefined): Promise<void> {
	const payload = { action };
	const botDesk = window.omp.sessions.botDesk;
	try {
		const result = await (device === undefined ? botDesk.teach(payload) : botDesk.teach(payload, device));
		if (action === "stop")
			toast({
				variant: result.delivered ? "success" : "info",
				message: translate(result.delivered ? "botTeach.handedOver" : "botTeach.empty"),
			});
	} catch (error) {
		toastError({ title: translate(FAILED[action]), error });
	}
	// A host's push can miss this page (a paired web page hears none), so its desk is read again.
	if (device !== undefined) void useBotDeskStore.getState().refresh(device);
}

function useTeachAction(device: string | undefined) {
	const [pending, setPending] = useState(false);
	const act = async (action: BotTeachRequest["action"]) => {
		setPending(true);
		await send(action, device);
		setPending(false);
	};
	return { pending, act };
}

/**
 * Record, while no recording runs: a one-line row of the bot's Routines with its label, drawn as the board's "+N more"
 * rows are, not a full-size button of its own.
 */
export function BotTeachRecord({ device }: { device?: string }) {
	const t = useT();
	const { pending, act } = useTeachAction(device);
	return (
		// controls-ok: the omp-work-board-more class draws the whole row
		<button
			className="omp-work-board-more gap-1.5 disabled:opacity-50"
			data-bot-teach-record=""
			disabled={pending}
			onClick={() => void act("start")}
			title={t("botTeach.hint")}
			type="button"
		>
			<CircleDot aria-hidden className="size-3.5 shrink-0" />
			{t("botTeach.record")}
		</button>
	);
}

/** A recording under way: how long it has run, Stop and Cancel; a row of the Routines section. */
export function BotTeachRecording({ device }: { device?: string }) {
	const t = useT();
	const teaching = useBotDesk(device).desk.teaching ?? null;
	const now = useNowTick(teaching !== null);
	const { pending, act } = useTeachAction(device);
	if (!teaching) return null;
	const elapsed = formatElapsed(Math.max(1000, now - Date.parse(teaching.since)));
	return (
		<div className="flex flex-wrap items-center gap-2" data-bot-teach="recording">
			<Badge dot pulse variant="error">
				<span data-bot-teach-elapsed>{t("botTeach.recording", { time: elapsed })}</span>
			</Badge>
			<Button data-bot-teach-stop disabled={pending} onClick={() => void act("stop")} size="sm" variant="primary">
				{t("botTeach.stop")}
			</Button>
			<Button data-bot-teach-cancel disabled={pending} onClick={() => void act("cancel")} size="sm" variant="ghost">
				{t("botTeach.cancel")}
			</Button>
		</div>
	);
}
