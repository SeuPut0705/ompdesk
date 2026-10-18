/**
 * Fake run-state for the three prototypes: the same reducer drives A, B and C so only the presentation differs.
 * It mirrors stock's semantics and nothing more: a queue with a steer lane and a follow-up lane, no reorder inside
 * a lane, "move lane" and "edit" re-queue at the END of the target lane, Stop gives the queued items back to the
 * composer (here as separate restored chips, not one merged text), and Stop is ignored while a stop is in flight.
 */

import { useEffect, useMemo, useReducer } from "react";
import { protoText } from "./strings";

export type Lane = "steer" | "followUp";
export type Variant = "a" | "b" | "c";
export type Ask = "none" | "question" | "approval";

export const STATES = [
	"idle",
	"typing",
	"running",
	"running-draft",
	"queue1",
	"queue4",
	"queue10",
	"edit-queued",
	"paused-after-stop",
	"stop-pending",
	"ask",
	"approval",
	"edited",
] as const;

/** `?open=1`: the folded lists (A's tray, B's "+N more", C's popover) start expanded, for captures. */
export const initialOpen = new URLSearchParams(location.search).get("open") === "1";
export type StateName = (typeof STATES)[number];

export interface QItem {
	id: number;
	lane: Lane;
	text: string;
	/** Pictures that went with it (stock lanes carry text only; the renderer remembers the count by chip id). */
	images: number;
}

export interface Editing {
	id: number;
	lane: Lane;
	text: string;
	prevDraft: string;
	prevImages: number;
}

export interface LiveMsg {
	n: number;
	key: string;
	params?: Record<string, string | number>;
}

export interface PState {
	running: boolean;
	stopPending: boolean;
	draft: string;
	draftImages: number;
	/** Insertion order; the display order is steer lane first, then follow-ups (`ordered`). */
	queue: QItem[];
	mode: Lane;
	paused: boolean;
	restored: QItem[];
	editing: Editing | null;
	ask: Ask;
	/** The item that was just re-queued at the end of a lane (edit or lane move), for the position note. */
	moved: { id: number; kind: "edit" | "lane" } | null;
	live: LiveMsg | null;
	nextId: number;
	/** Counts every send, for the harness' assertions. */
	sent: { lane: Lane; text: string }[];
	stops: number;
}

export function ordered(queue: QItem[]): QItem[] {
	return [...queue.filter(item => item.lane === "steer"), ...queue.filter(item => item.lane === "followUp")];
}

function item(id: number, lane: Lane, lang: string, sample: number, images = 0): QItem {
	return { id, lane, text: protoText(lang, `sample.${sample}`), images };
}

export function sampleQueue(lang: string, count: number): QItem[] {
	const base: QItem[] = [
		item(1, "steer", lang, 1),
		item(2, "steer", lang, 2),
		item(3, "followUp", lang, 3),
		item(4, "followUp", lang, 4, 2),
		item(5, "steer", lang, 5),
		item(6, "followUp", lang, 6),
		item(7, "steer", lang, 7),
		item(8, "followUp", lang, 8),
		item(9, "steer", lang, 9),
		item(10, "followUp", lang, 10),
	];
	if (count === 1) return [base[0]!];
	if (count === 4) return base.slice(0, 4);
	return base.slice(0, count);
}

export function initialState(name: StateName, lang: string): PState {
	const blank: PState = {
		running: false,
		stopPending: false,
		draft: "",
		draftImages: 0,
		queue: [],
		mode: "steer",
		paused: false,
		restored: [],
		editing: null,
		ask: "none",
		moved: null,
		live: null,
		nextId: 100,
		sent: [],
		stops: 0,
	};
	const draft = protoText(lang, "draft.typing");
	switch (name) {
		case "idle":
			return blank;
		case "typing":
			return { ...blank, draft };
		case "running":
			return { ...blank, running: true };
		case "running-draft":
			return { ...blank, running: true, draft };
		case "queue1":
			return { ...blank, running: true, queue: sampleQueue(lang, 1) };
		case "queue4":
			return { ...blank, running: true, queue: sampleQueue(lang, 4) };
		case "queue10":
			return { ...blank, running: true, queue: sampleQueue(lang, 10) };
		case "edit-queued": {
			const queue = sampleQueue(lang, 4);
			const target = queue[2]!;
			return {
				...blank,
				running: true,
				queue,
				draft: protoText(lang, "draft.half"),
				editing: {
					id: target.id,
					lane: target.lane,
					text: target.text,
					prevDraft: protoText(lang, "draft.half"),
					prevImages: 0,
				},
			};
		}
		case "paused-after-stop":
			return { ...blank, paused: true, restored: sampleQueue(lang, 4) };
		case "stop-pending":
			return { ...blank, running: true, stopPending: true, queue: sampleQueue(lang, 4) };
		case "ask":
			return { ...blank, running: true, ask: "question", queue: sampleQueue(lang, 1) };
		case "approval":
			return { ...blank, running: true, ask: "approval", queue: sampleQueue(lang, 1) };
		case "edited": {
			const start = initialState("edit-queued", lang);
			const e = start.editing;
			if (!e) return start;
			return reducer(
				{ ...start, editing: { ...e, text: `${e.text} (${protoText(lang, "msg.tool")})` } },
				{ t: "editSave" },
			);
		}
	}
}

export type Action =
	| { t: "draft"; v: string }
	| { t: "images"; n: number }
	| { t: "mode"; v: Lane }
	| { t: "send"; lane?: Lane }
	| { t: "stop" }
	| { t: "stopDone" }
	| { t: "toLane"; id: number; lane: Lane }
	| { t: "remove"; id: number }
	| { t: "clear" }
	| { t: "editStart"; id: number }
	| { t: "editText"; v: string }
	| { t: "editSave" }
	| { t: "editCancel" }
	| { t: "resume" }
	| { t: "discard" }
	| { t: "removeRestored"; id: number }
	| { t: "flashOff" }
	| { t: "endTurn" };

function say(s: PState, key: string, params?: Record<string, string | number>): LiveMsg {
	return { n: (s.live?.n ?? 0) + 1, key, params };
}

/** Stock re-queues an edited or moved message at the END of the lane it lands in. */
function requeue(s: PState, id: number, lane: Lane, text: string, kind: "edit" | "lane"): PState {
	const old = s.queue.find(entry => entry.id === id);
	if (!old) return s;
	const next: QItem = { id: s.nextId, lane, text, images: old.images };
	return {
		...s,
		queue: [...s.queue.filter(entry => entry.id !== id), next],
		nextId: s.nextId + 1,
		moved: { id: next.id, kind },
		live: say(s, "moved.live", { lane: `lane.${lane}` }),
	};
}

export function reducer(s: PState, a: Action): PState {
	switch (a.t) {
		case "draft":
			return { ...s, draft: a.v };
		case "images":
			return { ...s, draftImages: a.n };
		case "mode":
			return { ...s, mode: a.v };
		case "send": {
			if (s.editing && !a.lane) return reducer(s, { t: "editSave" });
			if (s.draft.trim() === "" && s.draftImages === 0) return s;
			const lane = a.lane ?? s.mode;
			const sent = [...s.sent, { lane, text: s.draft }];
			if (!s.running) return { ...s, running: true, draft: "", draftImages: 0, sent, paused: false };
			const entry: QItem = { id: s.nextId, lane, text: s.draft.trim(), images: s.draftImages };
			const queue = [...s.queue, entry];
			return {
				...s,
				queue,
				nextId: s.nextId + 1,
				draft: "",
				draftImages: 0,
				sent,
				moved: null,
				live: say(s, "queued.live", { count: queue.length }),
			};
		}
		case "stop":
			// DR-13: a second Stop or Esc while one is in flight is ignored.
			if (!s.running || s.stopPending) return s;
			return { ...s, stopPending: true, stops: s.stops + 1, live: say(s, "stopping.live") };
		case "stopDone": {
			if (!s.stopPending) return s;
			const back = ordered(s.queue);
			return {
				...s,
				running: false,
				stopPending: false,
				queue: [],
				restored: back,
				paused: back.length > 0,
				moved: null,
				editing: null,
				live: back.length > 0 ? say(s, "paused.live", { count: back.length }) : s.live,
			};
		}
		case "toLane":
			return requeue(
				{ ...s, editing: null },
				a.id,
				a.lane,
				s.queue.find(entry => entry.id === a.id)?.text ?? "",
				"lane",
			);
		case "remove":
			return { ...s, queue: s.queue.filter(entry => entry.id !== a.id), moved: null };
		case "clear":
			return { ...s, queue: [], moved: null, editing: null };
		case "editStart": {
			const target = s.queue.find(entry => entry.id === a.id);
			if (!target) return s;
			return {
				...s,
				moved: null,
				editing: {
					id: target.id,
					lane: target.lane,
					text: target.text,
					prevDraft: s.draft,
					prevImages: s.draftImages,
				},
			};
		}
		case "editText":
			return s.editing ? { ...s, editing: { ...s.editing, text: a.v } } : s;
		case "editSave": {
			const e = s.editing;
			if (!e) return s;
			const next = e.text.trim();
			const old = s.queue.find(entry => entry.id === e.id);
			const restored = { ...s, editing: null, draft: e.prevDraft, draftImages: e.prevImages };
			if (!old || next.length === 0 || next === old.text) return restored;
			return requeue(restored, e.id, e.lane, next, "edit");
		}
		case "editCancel":
			return s.editing ? { ...s, editing: null, draft: s.editing.prevDraft, draftImages: s.editing.prevImages } : s;
		case "resume": {
			const [first, ...rest] = s.restored;
			if (!first) return { ...s, paused: false };
			const queue = rest.map((entry, index) => ({ ...entry, id: s.nextId + index }));
			return {
				...s,
				running: true,
				paused: false,
				restored: [],
				queue,
				nextId: s.nextId + rest.length,
				sent: [...s.sent, { lane: first.lane, text: first.text }],
				live: say(s, "queued.live", { count: queue.length }),
			};
		}
		case "discard":
			return { ...s, restored: [], paused: false };
		case "removeRestored": {
			const restored = s.restored.filter(entry => entry.id !== a.id);
			return { ...s, restored, paused: restored.length > 0 };
		}
		case "flashOff":
			return { ...s, moved: null };
		case "endTurn":
			return { ...s, running: false, stopPending: false };
	}
}

export interface Store {
	s: PState;
	act: (a: Action) => void;
	list: QItem[];
}

export function useProto(name: StateName, lang: string, expose?: string): Store {
	const [s, act] = useReducer(reducer, undefined, () => initialState(name, lang));
	const list = useMemo(() => ordered(s.queue), [s.queue]);
	useEffect(() => {
		if (!s.stopPending) return;
		const timer = window.setTimeout(() => act({ t: "stopDone" }), 700);
		return () => window.clearTimeout(timer);
	}, [s.stopPending]);
	useEffect(() => {
		if (!s.moved) return;
		const timer = window.setTimeout(() => act({ t: "flashOff" }), 4000);
		return () => window.clearTimeout(timer);
	}, [s.moved]);
	useEffect(() => {
		if (!expose) return;
		window.__protoRun ??= {};
		window.__protoRun[expose] = { state: s, act };
	}, [expose, s]);
	return { s, act, list };
}

declare global {
	interface Window {
		/** Harness handle per variant: current state and dispatch, read by the capture scripts. */
		__protoRun?: Record<string, { state: PState; act: (a: Action) => void }>;
	}
}
