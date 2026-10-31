/**
 * The bot's activity log as the pane reads it (`shared/bot-activity.ts`): a page from main (`BOT_ACTIVITY_GET`, or a
 * paired host's `host.botDesk.activity`), read while a reader is mounted and again every `BOT_ACTIVITY_POLL_MS` while
 * the window shows. Main never pushes it: the log grows with every tool the bot runs.
 */
import { useEffect } from "react";
import { create } from "zustand";
import type { BotActivityPage } from "../../shared/bot-activity";
import { pollWhileVisible } from "../lib/visible-poll";

export const BOT_ACTIVITY_POLL_MS = 5_000;

export interface BotActivityEntry {
	page: BotActivityPage | null;
	loadError: unknown;
}

const NONE: BotActivityEntry = { page: null, loadError: null };

interface BotActivityStore {
	byComputer: Record<string, BotActivityEntry>;
	refresh: (device?: string) => Promise<void>;
	reset: () => void;
}

const keyOf = (device: string | undefined): string => device ?? "local";

export const useBotActivityStore = create<BotActivityStore>()((set, get) => ({
	byComputer: {},
	refresh: async device => {
		const key = keyOf(device);
		try {
			const api = window.omp.sessions.botDesk;
			const page = await (device === undefined ? api.activity() : api.activity(device));
			// The same revision is the same log: keep the array, so nothing renders again.
			if (get().byComputer[key]?.page?.revision === page.revision) return;
			set(state => ({ byComputer: { ...state.byComputer, [key]: { page, loadError: null } } }));
		} catch (error) {
			set(state => ({
				byComputer: { ...state.byComputer, [key]: { ...(state.byComputer[key] ?? NONE), loadError: error } },
			}));
		}
	},
	reset: () => set({ byComputer: {} }),
}));

/** The log of this computer's bot (no `device`) or a paired host's, read while `active`. */
export function useBotActivity(device: string | undefined, active: boolean): BotActivityEntry {
	useEffect(() => {
		if (!active || typeof window.omp?.sessions?.botDesk?.activity !== "function") return;
		const refresh = useBotActivityStore.getState().refresh;
		void refresh(device);
		return pollWhileVisible(() => void refresh(device), BOT_ACTIVITY_POLL_MS);
	}, [device, active]);
	return useBotActivityStore(state => state.byComputer[keyOf(device)] ?? NONE);
}
