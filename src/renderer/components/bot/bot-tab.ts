/**
 * Which pane is the bot's, for the parts of it drawn outside `BotPane` (the work board and its strip read it), and the
 * bot's lazy module. `BotPane` provides the context for the bot's own pane only (this computer's bot, or a paired
 * host's that its list marks on); every other pane reads null.
 *
 * The bot's parts are loaded on demand (`preloadBotDesk`): a paired phone's first screen never shows them, and with
 * them the first screen grew 18.8 kB past its budget (scripts/check-main-bundle.ts). They are fetched on idle once the
 * bot is on, so its pane usually has them at once; until then the bar is a static frame (rule://no-loading-screens).
 */
import { createContext, useContext, useEffect, useState } from "react";
import type * as BotDesk from "./BotDesk";

export interface BotTab {
	tabId: string;
	/** The paired host the bot runs on; absent for this computer's own bot. */
	device?: string;
}

export const BotTabContext = createContext<BotTab | null>(null);

/** The bot's own pane, or null in any other. */
export function useBotTab(): BotTab | null {
	return useContext(BotTabContext);
}

type BotDeskModule = typeof BotDesk;

let loaded: BotDeskModule | null = null;
let loading: Promise<BotDeskModule> | null = null;

/** The bot's module, fetched once; later calls share it, and a failed fetch is tried again by the next. */
export function preloadBotDesk(): Promise<BotDeskModule> {
	loading ??= import("./BotDesk").then(
		module => {
			loaded = module;
			return module;
		},
		(error: unknown) => {
			loading = null;
			throw error;
		},
	);
	return loading;
}

/** The bot's module once it is here; `wanted` false asks nothing (a pane that is not the bot's). */
export function useBotDeskModule(wanted: boolean): BotDeskModule | null {
	const [module, setModule] = useState<BotDeskModule | null>(() => loaded);
	useEffect(() => {
		if (!wanted || module) return;
		let live = true;
		preloadBotDesk().then(
			next => {
				if (live) setModule(next);
			},
			() => undefined,
		);
		return () => {
			live = false;
		};
	}, [wanted, module]);
	return wanted ? module : null;
}

/** The bot is on: fetch its module while nothing else happens, so opening it shows everything at once. */
export function usePreloadBotDesk(wanted: boolean): void {
	useEffect(() => {
		if (!wanted || loaded) return;
		const idle = window.requestIdleCallback?.(() => void preloadBotDesk().catch(() => undefined));
		return () => {
			if (idle !== undefined) window.cancelIdleCallback?.(idle);
		};
	}, [wanted]);
}
