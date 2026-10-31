/**
 * The bot's own session pane: a two-way switch (Home, Chat) above the body, and the home in place of the transcript
 * while it is on Home. The composer stays under both; sending a message switches to Chat, where the reply shows.
 * Home is the default each time the pane opens. Any other pane (a plain session, the bot of a paired computer) is
 * drawn as it was: `BotPane` returns its children untouched.
 *
 * The home is loaded on demand (`preloadBotHome`): a paired phone's first screen never shows it, and with it the first
 * screen grew 18.8 kB past its budget (scripts/check-main-bundle.ts). It is fetched on idle once the bot is on, so the
 * pane usually has it at once; until then the body is a static skeleton (rule://no-loading-screens).
 */
import { type ComponentType, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { openBotDecisions } from "../../../shared/bot-desk";
import { useT } from "../../lib/i18n";
import { useBotStore } from "../../stores/bot";
import { type BotView, useBotDeskStore } from "../../stores/bot-desk";
import { useComposerStore } from "../../stores/composer";
import type { SessionTab } from "../../stores/tabs";
import { SkeletonRows, Tabs } from "../common";

type HomeComponent = ComponentType<{ tabId: string }>;
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

function LoadedHome({ tabId }: { tabId: string }) {
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
	return Home ? <Home tabId={tabId} /> : <SkeletonRows label={t("botHome.loading")} widths={[60, 44, 70]} />;
}

/** This computer's bot session, on its own tab: never a paired computer's, which has a bot of its own. */
export function useIsBotTab(tab: Pick<SessionTab, "sessionPath" | "device">): boolean {
	const enabled = useBotStore(state => state.enabled);
	const path = useBotStore(state => state.path);
	return enabled && path !== null && tab.sessionPath === path && tab.device === undefined;
}

function BotSwitch() {
	const t = useT();
	const view = useBotDeskStore(state => state.view);
	const setView = useBotDeskStore(state => state.setView);
	const decisions = useBotDeskStore(state => openBotDecisions(state.desk).length);
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

function BotBody({ tabId, children }: { tabId: string; children: ReactNode }) {
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
			<BotSwitch />
			{view === "home" ? <LoadedHome tabId={tabId} /> : children}
		</>
	);
}

export function BotPane({ tab, children }: { tab: SessionTab; children: ReactNode }) {
	const enabled = useBotStore(state => state.enabled);
	// The bot is on: fetch its home while nothing else happens, so opening it shows the home at once.
	useEffect(() => {
		if (!enabled || loadedHome) return;
		const idle = window.requestIdleCallback?.(() => void preloadBotHome().catch(() => undefined));
		return () => {
			if (idle !== undefined) window.cancelIdleCallback?.(idle);
		};
	}, [enabled]);
	return useIsBotTab(tab) ? <BotBody tabId={tab.id}>{children}</BotBody> : children;
}
