/**
 * The bot's own session pane: one screen, the conversation in the middle with the bot's desk around it. Its bar on top
 * (the bot's name, its state, its next wake, the computer it runs on), the decisions it waits on docked above the
 * composer, and its duties, wakes and past decisions as sections of the work board (docked beside the conversation, or
 * the status strip's panel where the pane is narrow; the board's Now section lists the sessions it opened). A paired
 * host's bot gets the same screen, read from that host's own desk: its tab is the bot's once the host's session list
 * marks its session (`bot: "on"`). Any other pane (a plain session, a bot the owner turned off) is drawn as it was:
 * `BotPane` returns its children untouched.
 */
import { type ReactNode, useEffect, useMemo } from "react";
import { useStore } from "zustand";
import { ensureBotPath, useBotStore } from "../../stores/bot";
import { useBotCallStore } from "../../stores/bot-call";
import { ensureBotDesk, useBotDesk } from "../../stores/bot-desk";
import { sessionListFeed } from "../../stores/session-list";
import type { SessionTab } from "../../stores/tabs";
import { BOT_BAR_FRAME } from "./bot-bar-frame";
import { BotTabContext, useBotDeskModule, usePreloadBotDesk } from "./bot-tab";

function BotScreen({
	tabId,
	device,
	channel,
	children,
}: {
	tabId: string;
	device?: string;
	/** The side chat's topic, when the tab holds one. */
	channel?: string;
	children: ReactNode;
}) {
	const desk = useBotDeskModule(true);
	const onCall = useBotCallStore(store => store.tabId === tabId);
	const bot = useMemo(() => (device === undefined ? { tabId } : { tabId, device }), [tabId, device]);
	// This computer's desk is read by the sidebar at launch; a host's is read here (its sidebar section reads it too for
	// the count once its link is up).
	useEffect(() => {
		if (device !== undefined) ensureBotDesk(device);
	}, [device]);
	return (
		<BotTabContext.Provider value={bot}>
			{desk ? (
				<desk.BotBar {...(channel === undefined ? {} : { channel })} device={device} tabId={tabId} />
			) : (
				<div aria-hidden className={BOT_BAR_FRAME.outer} data-bot-bar="">
					<div className={BOT_BAR_FRAME.inner} />
				</div>
			)}
			{children}
			{desk && onCall ? <desk.BotCallBar tabId={tabId} /> : null}
			{desk ? <desk.BotDecisionDock device={device} /> : null}
		</BotTabContext.Provider>
	);
}

/** A session the owner took over from the bot: its pane says so, with "Hand back" (`BotTakeover.tsx`). */
function TakenOver({ sessionPath, device, children }: { sessionPath: string; device?: string; children: ReactNode }) {
	const desk = useBotDeskModule(true);
	return (
		<>
			{desk ? <desk.BotTakeoverBar {...(device === undefined ? {} : { device })} sessionPath={sessionPath} /> : null}
			{children}
		</>
	);
}

/** `children`, under the takeover bar while the owner has this tab's session (`BotDeskState.takeovers`). */
function withTakeover(tab: SessionTab, taken: boolean, children: ReactNode, device?: string): ReactNode {
	return taken && tab.sessionPath ? (
		<TakenOver {...(device === undefined ? {} : { device })} sessionPath={tab.sessionPath}>
			{children}
		</TakenOver>
	) : (
		children
	);
}

/** This computer's bot session, on its own tab. */
function LocalBotPane({ tab, children }: { tab: SessionTab; children: ReactNode }) {
	const enabled = useBotStore(state => state.enabled);
	// The sidebar reads both at launch; a phone's page keeps its sidebar in a drawer it may never open, so the pane does
	// too (both read once, whoever asks first).
	useEffect(() => {
		ensureBotPath();
		ensureBotDesk();
	}, []);
	const path = useBotStore(state => state.path);
	// A side chat (`BotChannel`) is the bot's too: the same bar, decisions and board, its topic on the bar.
	const desk = useBotDesk().desk;
	const channel = desk.channels.find(entry => entry.sessionPath === tab.sessionPath);
	const taken = desk.takeovers?.some(entry => entry.sessionPath === tab.sessionPath) ?? false;
	const isBot = enabled && path !== null && (tab.sessionPath === path || channel !== undefined);
	usePreloadBotDesk(enabled);
	return isBot ? (
		<BotScreen {...(channel ? { channel: channel.title } : {})} tabId={tab.id}>
			{children}
		</BotScreen>
	) : (
		withTakeover(tab, taken, children)
	);
}

/** A paired host's bot session: the host's own list marks it, on or off (`SessionInfo.bot`), and only on is the bot's. */
function HostBotPane({ tab, device, children }: { tab: SessionTab; device: string; children: ReactNode }) {
	const feed = sessionListFeed("global", device);
	// The sidebar holds the host's list while its section shows; a phone's page keeps the sidebar in a drawer it may
	// never open, so the pane holds it too (a deep-linked or reloaded bot tab still knows it is the host's bot).
	useEffect(() => feed.retain(), [feed]);
	const isBot = useStore(feed.store, state =>
		state.sessions.some(row => row.path === tab.sessionPath && row.bot === "on"),
	);
	const desk = useBotDesk(device).desk;
	const channel = desk.channels.find(entry => entry.sessionPath === tab.sessionPath);
	const taken = desk.takeovers?.some(entry => entry.sessionPath === tab.sessionPath) ?? false;
	usePreloadBotDesk(isBot || channel !== undefined);
	return isBot || channel ? (
		<BotScreen {...(channel ? { channel: channel.title } : {})} device={device} tabId={tab.id}>
			{children}
		</BotScreen>
	) : (
		withTakeover(tab, taken, children, device)
	);
}

export function BotPane({ tab, children }: { tab: SessionTab; children: ReactNode }) {
	return tab.device === undefined ? (
		<LocalBotPane tab={tab}>{children}</LocalBotPane>
	) : (
		<HostBotPane device={tab.device} tab={tab}>
			{children}
		</HostBotPane>
	);
}
