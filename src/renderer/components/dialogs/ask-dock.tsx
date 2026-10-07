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
	return <div className="omp-ask-dock" ref={ref} />;
}

/** The composer dock of the current session runtime, or null when none is mounted. */
export function useAskDock(): HTMLElement | null {
	const tabId = useSessionRuntime()?.tabId ?? null;
	return useSyncExternalStore(subscribe, () => docks.get(tabId) ?? null);
}
