/**
 * Taking over a session the bot opened, and handing it back (`shared/bot-takeover.ts`). "Take over" on a Tasks row
 * brings the session's tab forward, stops its turn and opens its Terminal panel, in the session's own folder; the tab
 * then carries a bar saying the owner has it, with "Hand back", which tells the session what the owner ran there (main
 * keeps the lines, password prompts and tokens hidden) and starts its turn again. The same on a paired device viewing
 * a host's bot and on the phone page: main of the computer running the session does the rest.
 */
import { Hand } from "lucide-react";
import { useState } from "react";
import { translate, useT } from "../../lib/i18n";
import { useTabsStore } from "../../stores/tabs";
import { toast, toastError } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Button, InlineNotice } from "../common";
import type { OpenedChildRow } from "../layout/work-board/opened-children";

/** Take over the task's session: its tab first (the terminal is that tab's), then main stops the turn. */
export async function takeOverTask(row: OpenedChildRow, device: string | undefined): Promise<void> {
	const sessionPath = row.sessionPath;
	if (!sessionPath) return;
	try {
		const tabs = useTabsStore.getState();
		if (row.tabId) await tabs.applyAgentView({ tabId: row.tabId, how: "focus" });
		else
			await tabs.openTab({
				cwd: row.cwd,
				sessionPath,
				kind: "agent",
				...(row.deviceId ? { device: row.deviceId } : {}),
			});
		const { botDesk } = window.omp.sessions;
		const take = { action: "take" as const, sessionPath };
		await (device === undefined ? botDesk.takeover(take) : botDesk.takeover(take, device));
		useUiStore.getState().setPanelTab("terminal");
	} catch (error) {
		toastError({ title: translate("botTakeover.takeFailed"), error });
	}
}

/** Hand the session back: it hears what the owner ran and goes on. */
export async function handBackTask(sessionPath: string, device: string | undefined): Promise<void> {
	try {
		const { botDesk } = window.omp.sessions;
		const back = { action: "handBack" as const, sessionPath };
		const { lines } = await (device === undefined ? botDesk.takeover(back) : botDesk.takeover(back, device));
		toast({
			variant: "success",
			message: translate(lines ? "botTakeover.handedBackLines" : "botTakeover.handedBack", { count: lines ?? 0 }),
		});
	} catch (error) {
		toastError({ title: translate("botTakeover.handBackFailed"), error });
	}
}

/** Over a session the owner took over: who has it, and the way to give it back. */
export function BotTakeoverBar({ sessionPath, device }: { sessionPath: string; device?: string }) {
	const t = useT();
	const [busy, setBusy] = useState(false);
	return (
		<div className="omp-bot-column shrink-0 px-3" data-bot-takeover-bar="">
			<InlineNotice
				action={
					<Button
						disabled={busy}
						icon={<Hand />}
						onClick={() => {
							setBusy(true);
							void handBackTask(sessionPath, device).finally(() => setBusy(false));
						}}
						size="sm"
						variant="secondary"
					>
						{t("botTakeover.handBack")}
					</Button>
				}
				title={
					<span className="line-clamp-2" title={t("botTakeover.youHaveItHint")}>
						{t("botTakeover.youHaveIt")}
					</span>
				}
				tone="info"
			/>
		</div>
	);
}
