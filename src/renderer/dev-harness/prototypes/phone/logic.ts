import { useCallback, useEffect, useLayoutEffect } from "react";
import { useEnv } from "./Frame";
import { type Session, useSession } from "./fake";

/** Send the draft the way the composer does: idle → prompt, running → steer or queued follow-up (stock's two lanes). */
export function useSend(): { send: () => boolean; canSend: boolean; hasDraft: boolean } {
	const { s, set, act, fieldRef } = useSession();
	const hasDraft = s.text.trim() !== "" || s.images.length > 0;
	const send = useCallback((): boolean => {
		if (!hasDraft) return false;
		if (!s.running) {
			act("send", s.text);
			set({ text: "", images: [], pastes: 0, expanded: false });
		} else if (s.sendMode === "steer") {
			act("steer", s.text);
			set({ text: "", images: [], pastes: 0 });
		} else {
			act("follow-up", s.text);
			set(current => ({
				text: "",
				images: [],
				pastes: 0,
				queue: [...current.queue, { id: Date.now(), lane: "followUp", text: current.text }],
			}));
		}
		fieldRef.current?.focus();
		return true;
	}, [act, fieldRef, hasDraft, s.running, s.sendMode, s.text, set]);
	return { send, canSend: hasDraft, hasDraft };
}

/** A newline at the caret (soft keyboards have no Shift+Enter). */
export function useInsertNewline(): () => void {
	const { fieldRef, set, act } = useSession();
	return useCallback(() => {
		const el = fieldRef.current;
		if (!el) return;
		const start = el.selectionStart ?? el.value.length;
		const end = el.selectionEnd ?? start;
		const next = `${el.value.slice(0, start)}\n${el.value.slice(end)}`;
		set({ text: next });
		act("newline");
		requestAnimationFrame(() => {
			el.focus();
			el.setSelectionRange(start + 1, start + 1);
		});
	}, [act, fieldRef, set]);
}

/**
 * Grow the field with its text: up to 40 % of the pane, never more than the visible height minus 120 px (keyboard up),
 * and refit when only the HEIGHT changes (PT-23: the production observer only watches the width).
 */
export function useFitField(text: string, expanded: boolean): void {
	const { fieldRef } = useSession();
	const { visibleH } = useEnv();
	const fit = useCallback(() => {
		const el = fieldRef.current;
		if (!el) return;
		if (expanded) {
			el.style.height = "";
			return;
		}
		el.style.height = "0px";
		const pane = el.closest<HTMLElement>(".omp-session-pane")?.clientHeight ?? window.innerHeight;
		const max = el.value.length === 0 ? 24 : Math.max(48, Math.min(pane * 0.4, visibleH - 120));
		el.style.height = `${Math.min(el.scrollHeight, max)}px`;
	}, [expanded, fieldRef, visibleH]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new draft text refits the field
	useLayoutEffect(fit, [fit, text]);
	useEffect(() => {
		window.addEventListener("resize", fit);
		const pane = fieldRef.current?.closest(".omp-session-pane");
		const observer = typeof ResizeObserver === "undefined" || !pane ? null : new ResizeObserver(fit);
		if (pane) observer?.observe(pane);
		return () => {
			window.removeEventListener("resize", fit);
			observer?.disconnect();
		};
	}, [fit, fieldRef]);
}

export function patchQueue(s: Session, id: number, patch: Partial<Session["queue"][number]>): Session["queue"] {
	return s.queue.map(item => (item.id === id ? { ...item, ...patch } : item));
}
