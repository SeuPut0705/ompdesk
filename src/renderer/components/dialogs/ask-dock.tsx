/**
 * Docks beside the composer. InputArea renders an `AskDockSlot` at the top of
 * its composer shell and a `BelowEditorDockSlot` under the input box;
 * ExtensionDialog portals into the slots that belong to the same session
 * runtime (tab). The ask card and above-editor widgets then sit in flow
 * directly above the composer, matching its width, while the transcript stays
 * visible and scrollable above it; the extension status line and below-editor
 * widgets sit under the input box, where stock's TUI draws them.
 */

import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useSessionRuntime } from "../../stores/session-runtime-context";

type DockPlace = "above" | "below";

const docks: Record<DockPlace, Map<string | null, HTMLElement>> = { above: new Map(), below: new Map() };
const listeners = new Set<() => void>();

function notify(): void {
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function useDockRegistration(place: DockPlace) {
	const tabId = useSessionRuntime()?.tabId ?? null;
	const ref = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		docks[place].set(tabId, element);
		notify();
		return () => {
			if (docks[place].get(tabId) === element) docks[place].delete(tabId);
			notify();
		};
	}, [place, tabId]);
	return ref;
}

/** Transcript height kept above the composer while a card waits: the card and the workspace dock share what is left. */
const TRANSCRIPT_FLOOR_PX = 240;
/**
 * Card height the floor never squeezes. A pane too short for both (a split, a short window, a widget over the card)
 * gives the card what it had before the floor existed, up to this: the transcript goes to nothing and the card covers
 * the column's rows (goal bar, work strip) from below, so a card that fit then still fits.
 */
const CARD_KEEP_PX = 240;

/** Room above the composer box: the card's ceiling, and the workspace dock's while a card is mounted. */
export interface PromptRoom {
	card: number;
	dock: number | null;
}

function fixedRows(container: Element, skip: ReadonlyArray<Element | null>): number {
	let sum = 0;
	for (const child of container.children) {
		if (!(child instanceof HTMLElement) || skip.some(element => element && child.contains(element))) continue;
		const style = getComputedStyle(child);
		if (style.flexGrow !== "0" || style.position === "absolute" || style.position === "fixed") continue;
		sum +=
			child.getBoundingClientRect().height +
			(Number.parseFloat(style.marginTop) || 0) +
			(Number.parseFloat(style.marginBottom) || 0);
	}
	return sum;
}

/**
 * The room above the composer for the card, the dock's cards and the transcript: the pane minus every fixed row
 * (header, banners, the work strip), the composer box as sized, the ask dock's other children (extension widgets)
 * and the dock's own rows (goal bar, island). The card gets it less the transcript floor, but never under
 * `CARD_KEEP_PX` while the pane holds that beside the composer; the dock's cards get what the card leaves above the
 * floor. The ask dock contains its children's margins (`display: flow-root`), so the composer box measures the same
 * with or without a card.
 */
export function measurePromptRoom(askDock: HTMLElement): PromptRoom | null {
	const pane = askDock.closest<HTMLElement>(".omp-session-pane");
	const composer = askDock.closest<HTMLElement>(".omp-composer-region");
	if (!pane || !composer) return null;
	const dock = pane.querySelector<HTMLElement>("[data-workspace-dock]");
	const dockRegion = dock?.closest<HTMLElement>(".omp-composer-region") ?? dock ?? null;
	const column = dockRegion?.parentElement;
	const columnRows = column && column !== pane ? fixedRows(column, [dockRegion]) : 0;
	const scroller = dock?.querySelector<HTMLElement>('[data-testid="workspace-dock"]');
	const dockRows = dockRegion
		? dockRegion.getBoundingClientRect().height - (scroller?.getBoundingClientRect().height ?? 0)
		: 0;
	const ask = askDock.getBoundingClientRect().height;
	const card = askDock.querySelector<HTMLElement>("[data-prompt-card]");
	const cardHeight = card?.getBoundingClientRect().height ?? 0;
	const composerBox = composer.getBoundingClientRect().height - ask;
	const room =
		pane.clientHeight -
		fixedRows(pane, [composer, dockRegion]) -
		columnRows -
		dockRows -
		composerBox -
		(ask - cardHeight);
	const atFloor = room - TRANSCRIPT_FLOOR_PX;
	return {
		card: Math.floor(Math.max(atFloor, Math.min(CARD_KEEP_PX, room + columnRows + dockRows))),
		dock: card ? Math.max(0, Math.floor(atFloor - cardHeight)) : null,
	};
}

/** Mount point for the ask card; renders nothing visible while empty. */
export function AskDockSlot() {
	const ref = useDockRegistration("above");
	useLayoutEffect(() => {
		const element = ref.current;
		const pane = element?.closest<HTMLElement>(".omp-session-pane");
		const region = element?.closest<HTMLElement>(".omp-composer-region");
		if (!element || !pane || !region || typeof ResizeObserver === "undefined") return;
		const column = pane.querySelector("[data-workspace-dock]")?.closest(".omp-composer-region")?.parentElement;
		let frame = 0;
		const write = () => {
			frame = 0;
			const room = measurePromptRoom(element);
			if (room === null) element.style.removeProperty("--omp-prompt-room");
			else element.style.setProperty("--omp-prompt-room", `${room.card}px`);
			const dock = pane.querySelector<HTMLElement>("[data-workspace-dock]");
			if (!dock) return;
			if (room === null || room.dock === null) dock.style.removeProperty("--omp-dock-room");
			else dock.style.setProperty("--omp-dock-room", `${room.dock}px`);
			dock.toggleAttribute("data-dock-yielded", room?.dock === 0);
		};
		// Written a frame later: a write inside the observer's callback resizes what it observes in that same frame,
		// which the browser reports as a ResizeObserver loop error.
		const schedule = () => {
			if (frame === 0) frame = requestAnimationFrame(write);
		};
		const observer = new ResizeObserver(schedule);
		observer.observe(pane);
		observer.observe(region);
		// The transcript column's rows: the work strip comes and goes, a session switch remounts the transcript.
		const rows = new MutationObserver(records => {
			for (const record of records) {
				for (const node of record.addedNodes) if (node instanceof Element) observer.observe(node);
				for (const node of record.removedNodes) if (node instanceof Element) observer.unobserve(node);
			}
			schedule();
		});
		if (column) {
			for (const row of column.children) observer.observe(row);
			rows.observe(column, { childList: true });
		}
		write();
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			rows.disconnect();
			const dock = pane.querySelector<HTMLElement>("[data-workspace-dock]");
			dock?.style.removeProperty("--omp-dock-room");
			dock?.removeAttribute("data-dock-yielded");
		};
	}, [ref]);
	return <div className="omp-ask-dock" ref={ref} />;
}

/** Mount point under the input box for the extension status line and below-editor widgets. */
export function BelowEditorDockSlot() {
	const ref = useDockRegistration("below");
	return <div className="omp-below-editor-dock" ref={ref} />;
}

/** The composer dock above the input box of the current session runtime, or null when none is mounted. */
export function useAskDock(): HTMLElement | null {
	const tabId = useSessionRuntime()?.tabId ?? null;
	return useSyncExternalStore(subscribe, () => docks.above.get(tabId) ?? null);
}

/** The dock under the input box of the current session runtime, or null when none is mounted. */
export function useBelowEditorDock(): HTMLElement | null {
	const tabId = useSessionRuntime()?.tabId ?? null;
	return useSyncExternalStore(subscribe, () => docks.below.get(tabId) ?? null);
}
