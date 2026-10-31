/**
 * The bot's own session pane: a two-way switch (Home, Chat) above the body, and the home in place of the transcript
 * while it is on Home. The composer stays under both; sending a message switches to Chat, where the reply shows.
 * Home is the default each time the pane opens. A paired host's bot gets the same home, read from that host's own
 * desk: its tab is the bot's once the host's session list marks its session (`bot: "on"`). Any other pane (a plain
 * session, a bot the owner turned off) is drawn as it was: `BotPane` returns its children untouched.
 *
 * The home is loaded on demand (`preloadBotHome`): a paired phone's first screen never shows it, and with it the first
 * screen grew 18.8 kB past its budget (scripts/check-main-bundle.ts). It is fetched on idle once the bot is on, so the
 * pane usually has it at once; until then the body is a static skeleton (rule://no-loading-screens).
 */
import { type ComponentType, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { openBotDecisions } from "../../../shared/bot-desk";
import { useT } from "../../lib/i18n";
import { useBotStore } from "../../stores/bot";
import { type BotView, useBotDesk, useBotDeskStore } from "../../stores/bot-desk";
import { useComposerStore } from "../../stores/composer";
import { sessionListFeed } from "../../stores/session-list";
import type { SessionTab } from "../../stores/tabs";
import { SkeletonRows, Tabs } from "../common";

type HomeComponent = ComponentType<{ tabId: string; device?: string }>;
let loadedHome: HomeComponent | null = null;
let loadingHome: Promise<HomeComponent> | null = null;

/** The home's module, fetched once; later calls share it. */
export function preloadBotHome(): Promise<HomeComponent> {
	loadingHome ??= import("./BotHome").then(module => {
		loadedHome = module.BotHome;
		return module.BotHome;
	});
	return loadingHome;
}

function LoadedHome({ tabId, device }: { tabId: string; device?: string }) {
	const t = useT();
	const [Home, setHome] = useState<HomeComponent | null>(() => loadedHome);
	useEffect(() => {
		if (Home) return;
		let live = true;
		preloadBotHome().then(
			component => {
				if (live) setHome(() => component);
			},
			() => undefined,
		);
		return () => {
			live = false;
		};
	}, [Home]);
	return Home ? (
		<Home device={device} tabId={tabId} />
	) : (
		<SkeletonRows label={t("botHome.loading")} widths={[60, 44, 70]} />
	);
}

function BotSwitch({ device }: { device?: string }) {
	const t = useT();
	const view = useBotDeskStore(state => state.view);
	const setView = useBotDeskStore(state => state.setView);
	const decisions = openBotDecisions(useBotDesk(device).desk).length;
	return (
		<div className="flex shrink-0 justify-center px-4 pt-2" data-bot-switch>
			<Tabs
				ariaLabel={t("botHome.switch")}
				activeId={view}
				compact
				onChange={id => setView(id as BotView)}
				tabs={[
					{ id: "home", label: t("botHome.tab.home"), ...(decisions > 0 ? { badge: decisions } : {}) },
					{ id: "chat", label: t("botHome.tab.chat") },
				]}
				variant="segmented"
			/>
		</div>
	);
}

function BotBody({ tabId, device, children }: { tabId: string; device?: string; children: ReactNode }) {
	const view = useBotDeskStore(state => state.view);
	const setView = useBotDeskStore(state => state.setView);
	const sending = useComposerStore(state => state.sending);
	const wasSending = useRef(sending);
	// Home each time the pane opens, before the first paint.
	useLayoutEffect(() => setView("home"), [setView]);
	useEffect(() => {
		if (sending && !wasSending.current) setView("chat");
		wasSending.current = sending;
	}, [sending, setView]);
	return (
		<>
			<BotSwitch device={device} />
			{view === "home" ? <LoadedHome device={device} tabId={tabId} /> : children}
		</>
	);
}

/** The bot is on: fetch its home while nothing else happens, so opening it shows the home at once. */
function usePreloadHome(wanted: boolean): void {
	useEffect(() => {
		if (!wanted || loadedHome) return;
		const idle = window.requestIdleCallback?.(() => void preloadBotHome().catch(() => undefined));
		return () => {
			if (idle !== undefined) window.cancelIdleCallback?.(idle);
		};
	}, [wanted]);
}

/** This computer's bot session, on its own tab. */
function LocalBotPane({ tab, children }: { tab: SessionTab; children: ReactNode }) {
	const enabled = useBotStore(state => state.enabled);
	const path = useBotStore(state => state.path);
	usePreloadHome(enabled);
	return enabled && path !== null && tab.sessionPath === path ? (
		<BotBody tabId={tab.id}>{children}</BotBody>
	) : (
		children
	);
}

/** A paired host's bot session: the host's own list marks it, on or off (`SessionInfo.bot`), and only on is its home. */
function HostBotPane({ tab, device, children }: { tab: SessionTab; device: string; children: ReactNode }) {
	const isBot = useStore(sessionListFeed("global", device).store, state =>
		state.sessions.some(row => row.path === tab.sessionPath && row.bot === "on"),
	);
	usePreloadHome(isBot);
	return isBot ? (
		<BotBody device={device} tabId={tab.id}>
			{children}
		</BotBody>
	) : (
		children
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
