/**
 * The bot's home: what the bot carries for the owner, in one screen that replaces the transcript while the pane shows
 * it (`BotPane`). In order: the header (the bot's mark and name, its state, its next wake, the computer it runs on),
 * the decisions waiting on the owner, the standing duties, the sessions it opened and its scheduled wakes. The desk
 * is main's (`stores/bot-desk.ts`); until the first read lands every part of it is a static skeleton, never a spinner.
 */
import { Bot } from "lucide-react";
import { type ReactNode, useId } from "react";
import { openBotDecisions } from "../../../shared/bot-desk";
import { formatClock } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { botDisplayName } from "../../lib/session-title";
import { useBotDeskStore } from "../../stores/bot-desk";
import { useRemoteStore } from "../../stores/remote";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { Badge, type BadgeVariant, Button, InlineNotice, SkeletonRows } from "../common";
import { BotDecisions } from "./BotDecisions";
import { BotDuties } from "./BotDuties";
import { BotSessions } from "./BotSessions";
import { BotWakes } from "./BotWakes";
import { type BotState, botState, botStateKey, nextWake, tabBotFacts } from "./bot-status";

const STATE_BADGE: Record<BotState, { variant: BadgeVariant; live: boolean }> = {
	idle: { variant: "muted", live: false },
	working: { variant: "info", live: true },
	waiting: { variant: "warning", live: false },
	asleep: { variant: "muted", live: false },
};

function HomeSection({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
	const id = useId();
	return (
		<section aria-labelledby={id} className="flex flex-col gap-3 border-t border-(--sc-border-subtle) pt-5">
			<h2 className="flex items-center gap-2 text-sc-md font-semibold text-(--sc-text)" id={id}>
				{title}
				{count !== undefined && count > 0 ? <Badge variant="warning">{count}</Badge> : null}
			</h2>
			{children}
		</section>
	);
}

function BotHeader({ tabId }: { tabId: string }) {
	const t = useT();
	const tab = useTabsStore(state => state.tabs.find(entry => entry.id === tabId));
	const wakes = useBotDeskStore(state => state.desk.wakes);
	const device = useRemoteStore(state => state.state?.host.name);
	// The tab's own omp holds the name (its session's title, which Settings › Bot renames); no list read for it.
	const sessionName = useSessionStore(state => state.sessionName);
	const name = botDisplayName({ title: sessionName ?? "" }, t("sidebar.botBadge"));
	const state = botState(tabBotFacts(tab));
	const wake = nextWake(wakes);
	const badge = STATE_BADGE[state];
	return (
		<header className="flex items-center gap-4" data-bot-home-header>
			<span
				aria-hidden
				className="flex size-14 shrink-0 items-center justify-center rounded-(--sc-radius-lg) bg-(--sc-accent-soft) text-(--sc-accent-on-soft)"
			>
				<Bot className="size-7" />
			</span>
			<div className="flex min-w-0 flex-col gap-1.5">
				<h1 className="truncate text-sc-xl font-semibold text-(--sc-text)" data-bot-name>
					{name}
				</h1>
				<p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sc-sm text-(--sc-text-muted)">
					<Badge dot pulse={badge.live} variant={badge.variant}>
						<span data-bot-state={state}>{t(botStateKey(state))}</span>
					</Badge>
					<span data-bot-next-wake>
						{wake ? t("botHome.nextWake", { time: formatClock(wake) }) : t("botHome.noWake")}
					</span>
					<span data-bot-device>{t("botHome.device", { device: device || t("botHome.thisComputer") })}</span>
				</p>
			</div>
		</header>
	);
}

export function BotHome({ tabId }: { tabId: string }) {
	const t = useT();
	const desk = useBotDeskStore(state => state.desk);
	const loaded = useBotDeskStore(state => state.loaded);
	const loadError = useBotDeskStore(state => state.loadError);
	const refresh = useBotDeskStore(state => state.refresh);
	const open = openBotDecisions(desk);
	const skeleton = (widths: readonly number[]) => <SkeletonRows label={t("botHome.loading")} widths={widths} />;
	return (
		<div className="min-h-0 flex-1 overflow-y-auto" data-bot-home>
			<div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-6">
				<BotHeader tabId={tabId} />
				{!loaded && loadError ? (
					<InlineNotice
						action={
							<Button onClick={() => void refresh()} size="sm">
								{t("common.retry")}
							</Button>
						}
						detail={loadError}
						title={t("botHome.loadFailed")}
						tone="danger"
					/>
				) : null}
				<HomeSection count={open.length} title={t("botHome.decisions.title")}>
					{loaded ? <BotDecisions decisions={desk.decisions} /> : skeleton([70, 45])}
				</HomeSection>
				<HomeSection title={t("botHome.duties.title")}>
					{loaded ? <BotDuties duties={desk.duties} /> : skeleton([60, 50, 40])}
				</HomeSection>
				<HomeSection title={t("botHome.sessions.title")}>
					<BotSessions tabId={tabId} />
				</HomeSection>
				<HomeSection title={t("botHome.wakes.title")}>
					{loaded ? <BotWakes wakes={desk.wakes} /> : skeleton([55])}
				</HomeSection>
			</div>
		</div>
	);
}
