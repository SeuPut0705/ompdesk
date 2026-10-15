/**
 * Saved model pools ("presets") for reuse across sessions. One JSON blob under
 * the "modelPool" prefs key via window.omp.prefs (electron-store in main);
 * hydrated lazily by the Modes popover's pool tab. Saves and deletes are
 * optimistic and roll back when the write fails. The live pool itself is
 * per session and lives in the session journal (gui-bridge modes/pool.ts).
 */
import { create } from "zustand";
import { normalizePool } from "../../../resources/gui-bridge/pool-contracts";
import type { RpcModelPoolMember } from "../../shared/rpc-types";
import { translate } from "../lib/i18n";
import { optimisticWrite } from "../lib/optimistic";
import { PREFS_BOOT_RETRY_MS, readPref } from "../lib/prefs-read";
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
		const valid = normalizePool({ members }).members;
		if (valid.length === 0) continue;
		presets.push({ id, name: name.trim(), members: valid });
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

export const useModelPoolPresets = create<ModelPoolPresetsStore>()((set, get) => {
	/**
	 * Reads the stored presets. A failed read leaves the store un-hydrated:
	 * every save writes the whole list, so none may happen until a read succeeds.
	 */
	const load = async (retryDelaysMs: readonly number[]): Promise<void> => {
		if (get().hydrated) return;
		const read = await readPref(MODEL_POOL_PREFS_KEY, retryDelaysMs);
		// Another read (the popover's backoff or a save's own) may have landed meanwhile.
		if (!read.ok || get().hydrated) return;
		const blob = (read.value ?? undefined) as ModelPoolPrefsBlob | undefined;
		set({ presets: normalizePresets(blob?.presets), hydrated: true });
	};

	/** A save or delete: read the stored list first (once, no backoff) when nothing has, and refuse with a toast while it stays unreadable. */
	const write = async (mutate: (state: ModelPoolPresetsStore) => Partial<ModelPoolPresetsStore>): Promise<void> => {
		if (!get().hydrated) await load([]);
		if (!get().hydrated) {
			toastError({ title: translate("modelPool.presetSaveFailed"), error: translate("prefs.unreadable") });
			return;
		}
		await optimisticWrite({
			store: { getState: get, setState: set },
			mutate,
			persist: () => writePresets(get().presets),
			onFailure: failure => toastError({ title: translate("modelPool.presetSaveFailed"), error: failure }),
		});
	};

	return {
		presets: [],
		hydrated: false,

		hydrate: () => load(PREFS_BOOT_RETRY_MS),

		savePreset: (name, members) => {
			const trimmed = name.trim().slice(0, MAX_PRESET_NAME);
			if (!trimmed || members.length === 0) return Promise.resolve();
			return write(state => {
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
			});
		},

		deletePreset: id => write(state => ({ presets: state.presets.filter(preset => preset.id !== id) })),

		reset: () => set({ presets: [], hydrated: false }),
	};
});
