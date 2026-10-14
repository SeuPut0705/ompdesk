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

/** Transcript height kept visible above a docked card, so the card never takes the whole pane. */
const MIN_TRANSCRIPT_PX = 32;

/**
 * Height a docked card may take: the pane minus its fixed rows (header, banners),
 * minus the composer under the card (it grows with a multiline draft and
 * attachments), minus some transcript. Published as `--omp-prompt-room` on the dock;
 * `.omp-prompt-card` caps itself by it, so the answer controls and the composer
 * stay inside the pane whatever the composer's current size.
 */
function measurePromptRoom(dock: HTMLElement): number | null {
	const pane = dock.closest<HTMLElement>(".omp-session-pane");
	const region = dock.closest<HTMLElement>(".omp-composer-region");
	if (!pane || !region) return null;
	let fixedRows = 0;
	for (const child of pane.children) {
		if (!(child instanceof HTMLElement) || child === region || child.contains(region)) continue;
		// The transcript column flexes; every other row keeps its height.
		if (getComputedStyle(child).flexGrow !== "0") continue;
		fixedRows += child.getBoundingClientRect().height;
	}
	const composer = region.getBoundingClientRect().height - dock.getBoundingClientRect().height;
	return Math.floor(pane.clientHeight - fixedRows - composer - MIN_TRANSCRIPT_PX);
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
			else element.style.setProperty("--omp-prompt-room", `${room}px`);
		};
		const observer = new ResizeObserver(update);
		// The region grows with the draft, attachments and the card itself; the pane with the layout.
		observer.observe(pane);
		observer.observe(region);
		update();
		return () => observer.disconnect();
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
