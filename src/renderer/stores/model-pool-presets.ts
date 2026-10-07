/**
 * Saved model pools ("presets") for reuse across sessions. One JSON blob under
 * the "modelPool" prefs key via window.omp.prefs (electron-store in main);
 * hydrated lazily by the Modes popover's pool tab. Saves and deletes are
 * optimistic and roll back when the write fails. The live pool itself is
 * per session and lives in the session journal (gui-bridge modes/pool.ts).
 */
import { create } from "zustand";
import type { RpcModelPoolMember } from "../../shared/rpc-types";
import { translate } from "../lib/i18n";
import { MAX_POOL_MEMBERS } from "../lib/model-pool";
import { optimisticWrite } from "../lib/optimistic";
import { toastError } from "./toast";

export const MODEL_POOL_PREFS_KEY = "modelPool";
const MAX_PRESETS = 20;
const MAX_PRESET_NAME = 60;

export interface ModelPoolPreset {
	id: string;
	name: string;
	members: RpcModelPoolMember[];
}

interface ModelPoolPrefsBlob {
	presets?: unknown;
}

/** Untrusted prefs → presets: well-formed entries only, members deduplicated and capped. */
export function normalizePresets(raw: unknown): ModelPoolPreset[] {
	if (!Array.isArray(raw)) return [];
	const presets: ModelPoolPreset[] = [];
	for (const item of raw) {
		if (typeof item !== "object" || item === null) continue;
		const { id, name, members } = item as Record<string, unknown>;
		if (typeof id !== "string" || !id || typeof name !== "string" || !name.trim() || !Array.isArray(members))
			continue;
		const seen = new Set<string>();
		const valid: RpcModelPoolMember[] = [];
		for (const member of members) {
			if (typeof member !== "object" || member === null) continue;
			const { selector, name: memberName, role } = member as Record<string, unknown>;
			if (typeof selector !== "string" || !selector.includes("/") || seen.has(selector)) continue;
			seen.add(selector);
			valid.push({
				selector,
				name: typeof memberName === "string" && memberName ? memberName : selector,
				role: typeof role === "string" && role ? role : "general",
			});
		}
		if (valid.length === 0) continue;
		presets.push({ id, name: name.trim(), members: valid.slice(0, MAX_POOL_MEMBERS) });
		if (presets.length === MAX_PRESETS) break;
	}
	return presets;
}

interface ModelPoolPresetsStore {
	presets: ModelPoolPreset[];
	hydrated: boolean;
	hydrate: () => Promise<void>;
	/** Save `members` under `name`; an existing preset with the same name is replaced. */
	savePreset: (name: string, members: RpcModelPoolMember[]) => Promise<void>;
	deletePreset: (id: string) => Promise<void>;
	reset: () => void;
}

async function writePresets(presets: ModelPoolPreset[]): Promise<{ success: boolean; error?: string }> {
	try {
		await window.omp.prefs.set(MODEL_POOL_PREFS_KEY, { presets } satisfies ModelPoolPrefsBlob);
		return { success: true };
	} catch (cause) {
		return { success: false, error: cause instanceof Error ? cause.message : String(cause) };
	}
}

export const useModelPoolPresets = create<ModelPoolPresetsStore>()((set, get) => ({
	presets: [],
	hydrated: false,

	hydrate: async () => {
		if (get().hydrated) return;
		try {
			const blob = (await window.omp.prefs.get(MODEL_POOL_PREFS_KEY)) as ModelPoolPrefsBlob | null | undefined;
			set({ presets: normalizePresets(blob?.presets), hydrated: true });
		} catch {
			set({ hydrated: true });
		}
	},

	savePreset: (name, members) => {
		const trimmed = name.trim().slice(0, MAX_PRESET_NAME);
		if (!trimmed || members.length === 0) return Promise.resolve();
		return optimisticWrite({
			store: { getState: get, setState: set },
			mutate: state => {
				const existing = state.presets.find(preset => preset.name === trimmed);
				const preset: ModelPoolPreset = {
					id: existing?.id ?? crypto.randomUUID(),
					name: trimmed,
					members: members.map(member => ({ ...member })),
				};
				const presets = existing
					? state.presets.map(item => (item.id === existing.id ? preset : item))
					: [...state.presets, preset].slice(-MAX_PRESETS);
				return { presets };
			},
			persist: () => writePresets(get().presets),
			onFailure: message => toastError({ title: translate("modelPool.presetSaveFailed"), error: message }),
		});
	},

	deletePreset: id =>
		optimisticWrite({
			store: { getState: get, setState: set },
			mutate: state => ({ presets: state.presets.filter(preset => preset.id !== id) }),
			persist: () => writePresets(get().presets),
			onFailure: message => toastError({ title: translate("modelPool.presetSaveFailed"), error: message }),
		}),

	reset: () => set({ presets: [], hydrated: false }),
}));
