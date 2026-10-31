/**
 * The bot's bar, on top of its pane while the conversation runs below it: the bot's mark and name, its state, its next
 * self-wake and the computer it runs on, in one line. The name truncates first, then the computer.
 */
import { Bot } from "lucide-react";
import { formatClock } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { botDisplayName } from "../../lib/session-title";
import { useBotDesk } from "../../stores/bot-desk";
import { useRemoteStore } from "../../stores/remote";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { Badge, type BadgeVariant } from "../common";
import { BOT_BAR_FRAME } from "./bot-bar-frame";
import { type BotState, botState, botStateKey, nextWake, tabBotFacts } from "./bot-status";

const STATE_BADGE: Record<BotState, { variant: BadgeVariant; live: boolean }> = {
	idle: { variant: "muted", live: false },
	working: { variant: "info", live: true },
	waiting: { variant: "warning", live: false },
	asleep: { variant: "muted", live: false },
};

export function BotBar({ tabId, device }: { tabId: string; device?: string }) {
	const t = useT();
	const tab = useTabsStore(state => state.tabs.find(entry => entry.id === tabId));
	const { wakes } = useBotDesk(device).desk;
	// This computer's name, or the paired host the bot runs on.
	const computer = useRemoteStore(state =>
		device === undefined
			? state.state?.host.name
			: (state.state?.hosts.find(host => host.deviceId === device)?.name ?? device),
	);
	// The tab's own omp holds the name (its session's title, which Settings › Bot renames); no list read for it.
	const sessionName = useSessionStore(state => state.sessionName);
	const name = botDisplayName({ title: sessionName ?? "" }, t("sidebar.botBadge"));
	const state = botState(tabBotFacts(tab));
	const wake = nextWake(wakes);
	const badge = STATE_BADGE[state];
	const wakeText = wake ? t("botHome.nextWake", { time: formatClock(wake) }) : t("botHome.noWake");
	const deviceText = t("botHome.device", { device: computer || t("botHome.thisComputer") });
	return (
		<header className={BOT_BAR_FRAME.outer} data-bot-bar="">
			<div className={BOT_BAR_FRAME.inner}>
				<span
					aria-hidden
					className="flex size-7 shrink-0 items-center justify-center rounded-(--sc-radius-md) bg-(--sc-accent-soft) text-(--sc-accent-on-soft)"
				>
					<Bot className="size-4" />
				</span>
				<h2 className="min-w-0 shrink truncate text-sc-md font-semibold text-(--sc-text)" data-bot-name>
					{name}
				</h2>
				<Badge dot pulse={badge.live} variant={badge.variant}>
					<span data-bot-state={state}>{t(botStateKey(state))}</span>
				</Badge>
				<span
					className="shrink-0 text-sc-sm whitespace-nowrap text-(--sc-text-muted) tabular-nums"
					data-bot-next-wake
				>
					{wakeText}
				</span>
				<span className="min-w-0 truncate text-sc-sm text-(--sc-text-subtle)" data-bot-device title={deviceText}>
					{deviceText}
				</span>
			</div>
		</header>
	);
}
