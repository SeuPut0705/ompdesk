/**
 * Which tabs wait on the model together (`IpcModelWaitTogether`, src/main/model-wait-count.ts), mirrored from main:
 * per tab id, how many sessions of the account the tab uses wait with it. Main pushes the whole map on every change;
 * nothing is read back, so a window opened mid-wait hears it at the next change.
 */
import { useEffect } from "react";
import { create } from "zustand";

interface ModelWaitTogetherStore {
	tabs: Record<string, number>;
}

export const useModelWaitTogetherStore = create<ModelWaitTogetherStore>()(() => ({ tabs: {} }));

/** Follows main's pushes while the app lives; called once from `App`. */
export function useModelWaitTogetherSync(): void {
	useEffect(() => window.omp.modelWait.onTogether(({ tabs }) => useModelWaitTogetherStore.setState({ tabs })), []);
}
