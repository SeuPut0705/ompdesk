/**
 * The bot's bar, on top of its pane while the conversation runs below it. Its first line: the bot's mark and name, its
 * state, its next self-wake and the computer it runs on (the computer goes first, then the wake text, while the name
 * keeps room for a few letters), and Stop now while it works. Its second line says what it does this moment, as Muse's avatar does ("Is working…"): the step its
 * turn runs (the running call's own words), the model's wait, or "Thinking"; for a paired host's bot the link's state
 * comes first while it is not online ("Reconnecting to Mac mini…", "Can't reach Mac mini"). Idle, the line is not drawn.
 */
import { MessageSquarePlus, Pause, Pencil, Phone, Play, Square } from "lucide-react";
import { useMemo, useState } from "react";
import { formatClock } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { abortActiveTurn } from "../../lib/messages";
import { useModelWait } from "../../lib/model-wait";
import { botDisplayName } from "../../lib/session-title";
import { useTabRpc } from "../../lib/tab-rpc";
import { useBotCallStore } from "../../stores/bot-call";
import { useBotDesk, useBotDeskStore } from "../../stores/bot-desk";
import { useRemoteStore } from "../../stores/remote";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { toast, toastError } from "../../stores/toast";
import { useTodoStore } from "../../stores/todo";
import { useToolsStore } from "../../stores/tools";
import { Badge, type BadgeVariant, Button, IconButton, LinkButton } from "../common";
import { BotIdentitySheet } from "../settings/BotIdentitySettings";
import { getToolHeader } from "../tools/index";
import { BotAvatar } from "./BotAvatar";
import { BOT_BAR_FRAME } from "./bot-bar-frame";
import { useBotMotion } from "./bot-motion";
import { type BotState, botState, botStateKey, nextWake, tabBotFacts } from "./bot-status";

const STATE_BADGE: Record<BotState, { variant: BadgeVariant; live: boolean }> = {
	idle: { variant: "muted", live: false },
	working: { variant: "info", live: true },
	waiting: { variant: "warning", live: false },
	asleep: { variant: "muted", live: false },
};

/** What the bot's turn does now: the newest running call in its own words, else the model's wait, else thinking. */
function useCurrentStep(working: boolean): string | null {
	const t = useT();
	const live = useToolsStore(state => state.liveTools);
	const modelWait = useModelWait();
	const turnActive = useTodoStore(state => state.turnActive);
	return useMemo(() => {
		if (!working || !turnActive) return null;
		const newest = [...live.values()]
			.filter(entry => entry.status === "running" || entry.status === "pending")
			.sort((a, b) => b.startTime - a.startTime)[0];
		if (newest) {
			const intent = newest.intent?.trim();
			if (intent) return intent;
			const header = getToolHeader(newest.toolName, newest.args);
			return header.target || (header.labelKey ? t(header.labelKey, header.labelParams) : header.tool);
		}
		return modelWait ?? t("botHome.step.thinking");
	}, [working, turnActive, live, modelWait, t]);
}

export function BotBar({ tabId, device, channel }: { tabId: string; device?: string; channel?: string }) {
	const t = useT();
	const rpc = useTabRpc();
	const tab = useTabsStore(state => state.tabs.find(entry => entry.id === tabId));
	const { desk, loaded } = useBotDesk(device);
	const { routines, identity } = desk;
	const paused = desk.paused === true;
	const edit = useBotDeskStore(store => store.edit);
	const onCall = useBotCallStore(store => store.tabId === tabId);
	// Who the bot is opens in a sheet over the pane, for this bar's bot (a host's on a paired computer or the phone).
	const [identityOpen, setIdentityOpen] = useState(false);
	const setPaused = (next: boolean) => void edit({ op: "paused", paused: next }, device);
	// A fresh conversation for this one (the bot's or this side chat's): it starts at the bot's next quiet moment.
	const channelId = desk.channels.find(entry => entry.sessionPath === tab?.sessionPath)?.id;
	const renew = () =>
		void edit({ op: "new_conversation", ...(channelId === undefined ? {} : { channel: channelId }) }, device).then(
			done => {
				if (done) toast({ variant: "success", message: t("botHome.newConversationAsked") });
			},
		);
	// This computer's name, or the paired host the bot runs on, and that host's link.
	const host = useRemoteStore(state =>
		device === undefined ? undefined : state.state?.hosts.find(entry => entry.deviceId === device),
	);
	const thisComputer = useRemoteStore(state => state.state?.host.name);
	const computer = device === undefined ? thisComputer : (host?.name ?? device);
	// The tab's own omp holds the name (its session's title, which Settings › Bot renames); no list read for it.
	const sessionName = useSessionStore(state => state.sessionName);
	const name = botDisplayName({ title: sessionName ?? "" }, t("sidebar.botBadge"));
	const state = botState(tabBotFacts(tab));
	const motion = useBotMotion({ state, device, tabId });
	const step = useCurrentStep(state === "working");
	const wake = nextWake(routines);
	const badge = STATE_BADGE[state];
	const wakeText = wake ? t("botHome.nextWake", { time: formatClock(wake) }) : t("botHome.noWake");
	const deviceText = t("botHome.device", { device: computer || t("botHome.thisComputer") });
	const link =
		host?.state === "connecting"
			? t("botHome.link.connecting", { device: computer ?? "" })
			: host?.state === "offline"
				? t("botHome.link.offline", { device: computer ?? "" })
				: null;
	const stopNow = () =>
		abortActiveTurn(rpc, tabId, "bot-bar").then(
			response => {
				if (!response.success) toastError({ title: t("botHome.stopFailed"), error: response });
			},
			(error: unknown) => toastError({ title: t("botHome.stopFailed"), error }),
		);
	return (
		<header className={BOT_BAR_FRAME.outer} data-bot-bar="">
			<div className={BOT_BAR_FRAME.inner}>
				<BotAvatar avatar={identity.avatar} motion={motion} size="md" />
				{/* A long name ellipsizes (the 390 px bar has room for a few letters); its whole text is the tooltip and, being
				    the heading's own text, its accessible name. */}
				<h2 className="shrink truncate text-sc-md font-semibold text-(--sc-text)" data-bot-name title={name}>
					{name}
				</h2>
				{identity.tagline && (
					<span
						className="hidden min-w-0 shrink-[2] truncate text-sc-sm text-(--sc-text-muted) sm:inline"
						data-bot-tagline
						title={identity.tagline}
					>
						{identity.tagline}
					</span>
				)}
				{channel !== undefined && (
					<Badge variant="muted">
						<span data-bot-channel-badge>{t("botChannels.badge")}</span>
					</Badge>
				)}
				<Badge dot pulse={badge.live} variant={badge.variant}>
					<span data-bot-state={state}>{t(botStateKey(state))}</span>
				</Badge>
				<span
					data-bot-next-wake
					className="min-w-0 shrink-[3] truncate text-sc-sm whitespace-nowrap text-(--sc-text-muted) tabular-nums"
					title={wakeText || undefined}
				>
					{wakeText}
				</span>
				<span
					className="min-w-0 flex-1 truncate text-sc-sm text-(--sc-text-subtle)"
					data-bot-device
					title={deviceText}
				>
					{deviceText}
				</span>
				{state === "working" && !paused ? (
					<Button
						data-bot-stop
						icon={<Square />}
						onClick={() => void stopNow()}
						size="sm"
						title={t("botHome.stopTitle")}
						variant="secondary"
					>
						{t("botHome.stop")}
					</Button>
				) : null}
				{loaded ? (
					<IconButton
						data-bot-new-conversation=""
						icon={<MessageSquarePlus />}
						label={t("botHome.newConversation")}
						onClick={renew}
						size="sm"
					/>
				) : null}
				<IconButton
					data-bot-identity-edit=""
					icon={<Pencil />}
					label={t("botIdentity.edit")}
					onClick={() => setIdentityOpen(true)}
					size="sm"
				/>
				<IconButton
					data-bot-call-start=""
					icon={<Phone />}
					label={t("botCall.start")}
					onClick={() =>
						onCall ? useBotCallStore.getState().end(tabId) : useBotCallStore.getState().start(tabId)
					}
					pressed={onCall}
					size="sm"
				/>
				{loaded ? (
					<IconButton
						aria-pressed={paused}
						data-bot-pause={paused ? "paused" : "running"}
						icon={paused ? <Play /> : <Pause />}
						label={t(paused ? "botHome.resume" : "botHome.pause")}
						onClick={() => setPaused(!paused)}
						size="sm"
					/>
				) : null}
			</div>
			{paused ? (
				<p
					className="omp-composer-shell truncate ps-[calc(var(--omp-column-pad)+2.375rem)] text-sc-xs"
					data-bot-status-line="paused"
				>
					<LinkButton data-bot-resume="" onClick={() => setPaused(false)} title={t("botHome.pausedHint")}>
						{t("botHome.paused")}
					</LinkButton>
				</p>
			) : link || step ? (
				<p
					aria-live="polite"
					className="omp-composer-shell truncate ps-[calc(var(--omp-column-pad)+2.375rem)] text-sc-xs text-(--sc-text-muted)"
					data-bot-status-line={link ? "link" : "step"}
					title={link ?? step ?? undefined}
				>
					<span className={link ? "text-(--sc-warning)" : undefined}>{link ?? step}</span>
				</p>
			) : null}
			<BotIdentitySheet device={device} onClose={() => setIdentityOpen(false)} open={identityOpen} />
		</header>
	);
}
