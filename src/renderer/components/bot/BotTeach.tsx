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

export function BotTeachControl({ device }: { device?: string }) {
	const t = useT();
	const teaching = useBotDesk(device).desk.teaching ?? null;
	const now = useNowTick(teaching !== null);
	const [pending, setPending] = useState(false);
	const act = async (action: BotTeachRequest["action"]) => {
		setPending(true);
		await send(action, device);
		setPending(false);
	};
	if (!teaching)
		return (
			<div className="flex items-center gap-2" data-bot-teach="">
				<Button
					data-bot-teach-record
					disabled={pending}
					icon={<CircleDot />}
					onClick={() => void act("start")}
					size="sm"
					title={t("botTeach.hint")}
					variant="secondary"
				>
					{t("botTeach.record")}
				</Button>
			</div>
		);
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
