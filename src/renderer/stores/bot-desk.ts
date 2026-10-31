/**
 * The bot's desk as this window knows it (`shared/bot-desk.ts`): duties, decisions and the bot's own wakes. Main owns
 * the file; this store holds the last state main sent (`BOT_DESK_GET`, then every `BOT_DESK_CHANGED`), whether the
 * first read landed, and which of the bot's two views its pane shows (`BotPane`). Answering and editing the duties go
 * through main and come back as a change: the card leaves, the list moves, only when main says so.
 */
import { create } from "zustand";
import { type BotDeskDuties, type BotDeskState, EMPTY_BOT_DESK } from "../../shared/bot-desk";
import { translate } from "../lib/i18n";
import { toastError } from "./toast";

export type BotView = "home" | "chat";

interface BotDeskStore {
	desk: BotDeskState;
	/** The first read (or a push) has landed: until then the home draws its static skeleton. */
	loaded: boolean;
	/** The first read failed and nothing has arrived since. */
	loadError: unknown;
	/** Bumped by every push; a read begun before a push must not overwrite it. */
	revision: number;
	view: BotView;
	apply: (desk: BotDeskState) => void;
	setView: (view: BotView) => void;
	/** Read the desk from main; a push that lands meanwhile wins over the reply. */
	refresh: () => Promise<void>;
	/** Answer a decision; false (and a toast) when main refused. */
	answer: (id: string, answer: string) => Promise<boolean>;
	/** Write the whole duty list; false (and a toast) when main refused. */
	setDuties: (duties: BotDeskDuties["duties"]) => Promise<boolean>;
	reset: () => void;
}

export const useBotDeskStore = create<BotDeskStore>()((set, get) => ({
	desk: EMPTY_BOT_DESK,
	loaded: false,
	loadError: null,
	revision: 0,
	view: "home",
	apply: desk => set(current => ({ desk, loaded: true, loadError: null, revision: current.revision + 1 })),
	setView: view => set({ view }),
	refresh: async () => {
		const revision = get().revision;
		try {
			const desk = await window.omp.sessions.botDesk.get();
			if (get().revision === revision) get().apply(desk);
		} catch (error) {
			if (get().revision === revision) set({ loadError: error });
		}
	},
	answer: async (id, answer) => {
		try {
			await window.omp.sessions.botDesk.answer({ id, answer });
			return true;
		} catch (error) {
			toastError({ title: translate("botHome.answerFailed"), error });
			return false;
		}
	},
	setDuties: async duties => {
		try {
			await window.omp.sessions.botDesk.setDuties({ duties });
			return true;
		} catch (error) {
			toastError({ title: translate("botHome.dutiesFailed"), error });
			return false;
		}
	},
	reset: () => set({ desk: EMPTY_BOT_DESK, loaded: false, loadError: null, revision: 0, view: "home" }),
}));

let subscribed = false;

/** Read the desk once and follow main's changes; a missing bridge (tests) is skipped. */
export function ensureBotDesk(): void {
	if (subscribed || typeof window === "undefined" || typeof window.omp?.sessions?.botDesk?.get !== "function") return;
	subscribed = true;
	void useBotDeskStore.getState().refresh();
	window.omp.sessions.botDesk.onChanged(desk => useBotDeskStore.getState().apply(desk));
}
