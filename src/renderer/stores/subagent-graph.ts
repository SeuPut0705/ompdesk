import { createStore } from "zustand/vanilla";
import { createScopedStoreHook } from "./session-runtime-context";

export interface SubagentGraphStore {
	/** Maps a `task` tool call id to the id of the subagent whose transcript contains it. */
	toolCallOwners: Map<string, string>;
	reset: () => void;
	registerToolCallOwners: (agentId: string, toolCallIds: string[]) => void;
}

export const createSubagentGraphStore = () =>
	createStore<SubagentGraphStore>()((set, get) => ({
		toolCallOwners: new Map(),
		reset: () => set({ toolCallOwners: new Map() }),
		registerToolCallOwners: (agentId, toolCallIds) => {
			const current = get().toolCallOwners;
			let next: Map<string, string> | null = null;
			for (const id of toolCallIds) {
				if (current.get(id) === agentId) continue;
				if (!next) next = new Map(current);
				next.set(id, agentId);
			}
			if (next) set({ toolCallOwners: next });
		},
	}));

export const useSubagentGraphStore = createScopedStoreHook("subagentGraph", createSubagentGraphStore());
