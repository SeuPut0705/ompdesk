/**
 * Dock for the non-modal `ask` card: InputArea renders an `AskDockSlot` at the
 * top of its composer shell, and ExtensionDialog portals the card into the slot
 * that belongs to the same session runtime (tab). The card then sits in flow
 * directly above the composer, matching its width, while the transcript stays
 * visible and scrollable above it.
 */

import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useSessionRuntime } from "../../stores/session-runtime-context";

const docks = new Map<string | null, HTMLElement>();
const listeners = new Set<() => void>();

function notify(): void {
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
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
	const tabId = useSessionRuntime()?.tabId ?? null;
	const ref = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		docks.set(tabId, element);
		notify();
		return () => {
			if (docks.get(tabId) === element) docks.delete(tabId);
			notify();
		};
	}, [tabId]);
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
	}, []);
	return <div className="omp-ask-dock" ref={ref} />;
}

/** The composer dock of the current session runtime, or null when none is mounted. */
export function useAskDock(): HTMLElement | null {
	const tabId = useSessionRuntime()?.tabId ?? null;
	return useSyncExternalStore(subscribe, () => docks.get(tabId) ?? null);
}
