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
		sum += child.getBoundingClientRect().height;
	}
	return sum;
}

/**
 * Pane height left for the ask card after every fixed row (header, banners, the work strip), the composer box as
 * sized, the dock's own rows (goal bar, island) and the transcript floor; the dock's cards get what the card leaves.
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
	const composerBox = composer.getBoundingClientRect().height - ask;
	const card = Math.floor(
		pane.clientHeight -
			fixedRows(pane, [composer, dockRegion]) -
			columnRows -
			composerBox -
			dockRows -
			TRANSCRIPT_FLOOR_PX,
	);
	const cardMounted = askDock.querySelector("[data-prompt-card]") !== null;
	return { card, dock: cardMounted ? Math.max(0, Math.floor(card - ask)) : null };
}

/** Mount point for the ask card; renders nothing visible while empty. */
export function AskDockSlot() {
	const ref = useDockRegistration("above");
	useLayoutEffect(() => {
		const element = ref.current;
		const pane = element?.closest<HTMLElement>(".omp-session-pane");
		const region = element?.closest<HTMLElement>(".omp-composer-region");
		if (!element || !pane || !region || typeof ResizeObserver === "undefined") return;
		const update = () => {
			const room = measurePromptRoom(element);
			if (room === null) element.style.removeProperty("--omp-prompt-room");
			else element.style.setProperty("--omp-prompt-room", `${room.card}px`);
			if (room === null || room.dock === null) pane.style.removeProperty("--omp-dock-room");
			else pane.style.setProperty("--omp-dock-room", `${room.dock}px`);
		};
		const observer = new ResizeObserver(update);
		observer.observe(pane);
		observer.observe(region);
		// The work strip coming or going resizes the transcript, one of the column's rows.
		const column = pane.querySelector("[data-workspace-dock]")?.closest(".omp-composer-region")?.parentElement;
		for (const row of column?.children ?? []) observer.observe(row);
		update();
		return () => {
			observer.disconnect();
			pane.style.removeProperty("--omp-dock-room");
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
