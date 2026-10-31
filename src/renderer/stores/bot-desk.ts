/**
 * The bot's desk as this window knows it (`shared/bot-desk.ts`): duties, decisions and the bot's own wakes, for this
 * computer's bot and for each paired host's (`device` = the host's id; a host's bot pane reads the host's desk over
 * the link, `host.botDesk.*`). Main owns the files; this store holds the last state main sent per computer
 * (`BOT_DESK_GET`, then every `BOT_DESK_CHANGED` / `HOST_BOT_DESK_STATE`) and whether the first read landed.
 * Answering and editing the duties go through main and come back as a change: the decision leaves, the list moves,
 * only when main says so.
 */
import { create } from "zustand";
import { type BotDeskDuties, type BotDeskState, EMPTY_BOT_DESK } from "../../shared/bot-desk";
import { translate } from "../lib/i18n";
import { toastError } from "./toast";

export interface BotDeskEntry {
	desk: BotDeskState;
	/** The first read (or a push) has landed: until then the bot's board sections draw their static skeleton. */
	loaded: boolean;
	/** The first read failed and nothing has arrived since. */
	loadError: unknown;
	/** Bumped by every push; a read begun before a push must not overwrite it. */
	revision: number;
}

const NO_DESK: BotDeskEntry = { desk: EMPTY_BOT_DESK, loaded: false, loadError: null, revision: 0 };

/** This computer's own desk, the one `device` leaves out. */
const LOCAL_DESK = "local";

function keyOf(device: string | undefined): string {
	return device ?? LOCAL_DESK;
}

let unsubscribe: (() => void) | null = null;
/** The computers whose first read was asked for. */
const requested = new Set<string>();

interface BotDeskStore {
	/** By computer: `local`, or a paired host's device id. */
	desks: Record<string, BotDeskEntry>;
	apply: (desk: BotDeskState, device?: string) => void;
	/** Read the desk from main; a push that lands meanwhile wins over the reply. */
	refresh: (device?: string) => Promise<void>;
	/** Answer a decision; false (and a toast) when main refused. */
	answer: (id: string, answer: string, device?: string) => Promise<boolean>;
	/** Write the whole duty list; false (and a toast) when main refused. */
	setDuties: (duties: BotDeskDuties["duties"], device?: string) => Promise<boolean>;
	reset: () => void;
}

export const useBotDeskStore = create<BotDeskStore>()((set, get) => ({
	desks: {},
	apply: (desk, device) =>
		set(current => {
			const key = keyOf(device);
			const revision = (current.desks[key]?.revision ?? 0) + 1;
			return { desks: { ...current.desks, [key]: { desk, loaded: true, loadError: null, revision } } };
		}),
	refresh: async device => {
		const key = keyOf(device);
		const revision = get().desks[key]?.revision ?? 0;
		const fresh = () => (get().desks[key]?.revision ?? 0) === revision;
		try {
			const botDesk = window.omp.sessions.botDesk;
			const desk = await (device === undefined ? botDesk.get() : botDesk.get(device));
			if (fresh()) get().apply(desk, device);
		} catch (error) {
			if (fresh())
				set(current => ({
					desks: { ...current.desks, [key]: { ...(current.desks[key] ?? NO_DESK), loadError: error } },
				}));
		}
	},
	answer: async (id, answer, device) => {
		try {
			const payload = { id, answer };
			await (device === undefined
				? window.omp.sessions.botDesk.answer(payload)
				: window.omp.sessions.botDesk.answer(payload, device));
		} catch (error) {
			toastError({ title: translate("botHome.answerFailed"), error });
			return false;
		}
		// A host's push can miss this page (a paired web page hears none), so its desk is read again.
		if (device !== undefined) void get().refresh(device);
		return true;
	},
	setDuties: async (duties, device) => {
		try {
			const payload = { duties };
			await (device === undefined
				? window.omp.sessions.botDesk.setDuties(payload)
				: window.omp.sessions.botDesk.setDuties(payload, device));
		} catch (error) {
			toastError({ title: translate("botHome.dutiesFailed"), error });
			return false;
		}
		if (device !== undefined) void get().refresh(device);
		return true;
	},
	reset: () => {
		unsubscribe?.();
		unsubscribe = null;
		requested.clear();
		set({ desks: {} });
	},
}));

/** The desk of this computer (no `device`) or of a paired host; an empty one until the first read lands. */
export function useBotDesk(device?: string): BotDeskEntry {
	return useBotDeskStore(state => state.desks[keyOf(device)] ?? NO_DESK);
}

/** Read a computer's desk once and follow every computer's changes; a missing bridge (tests) is skipped. */
export function ensureBotDesk(device?: string): void {
	if (typeof window === "undefined" || typeof window.omp?.sessions?.botDesk?.get !== "function") return;
	unsubscribe ??= window.omp.sessions.botDesk.onChanged((desk, from) => useBotDeskStore.getState().apply(desk, from));
	const key = keyOf(device);
	if (requested.has(key)) return;
	requested.add(key);
	void useBotDeskStore.getState().refresh(device);
}

/** A host's link is gone or its bot is: the next `ensureBotDesk` for it reads again, as its changes were missed. */
export function releaseBotDesk(device: string): void {
	requested.delete(keyOf(device));
}
