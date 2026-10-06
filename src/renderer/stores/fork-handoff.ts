/**
 * Open-state store for the handoff dialog. Kept separate from the ui store so
 * the session handoff feature stays self-contained — the parent wires the
 * open action into the command registry and mounts the dialog in App.
 */

import { create } from "zustand";

interface ForkHandoffStore {
	handoffDialogOpen: boolean;
	openHandoffDialog: () => void;
	closeHandoffDialog: () => void;
}

export const useForkHandoffStore = create<ForkHandoffStore>()(set => ({
	handoffDialogOpen: false,
	openHandoffDialog: () => set({ handoffDialogOpen: true }),
	closeHandoffDialog: () => set({ handoffDialogOpen: false }),
}));

/** Fire-and-forget helpers for non-component call sites (command registry, menus). */
export function openHandoffDialog(): void {
	useForkHandoffStore.getState().openHandoffDialog();
}

export function closeHandoffDialog(): void {
	useForkHandoffStore.getState().closeHandoffDialog();
}
