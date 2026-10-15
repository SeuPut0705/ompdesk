import { create } from "zustand";
import { isOutputStyleId, type OutputStyleId } from "../../../resources/gui-bridge/output-style-contracts";

/**
 * How long and how structured the agent's replies are (Settings › General,
 * `/output-style`). Saved in prefs; `useOutputStyle` hands it to every tab's
 * bridge, which appends the style's instruction from the next turn.
 */
export const OUTPUT_STYLE_PREF = "outputStyle";

interface OutputStyleState {
	style: OutputStyleId;
	loaded: boolean;
	load: () => Promise<void>;
	setStyle: (style: OutputStyleId) => void;
	reset: () => void;
}

export const useOutputStyleStore = create<OutputStyleState>()(set => ({
	style: "default",
	loaded: false,
	load: async () => {
		let saved: unknown;
		try {
			saved = await window.omp.prefs.get(OUTPUT_STYLE_PREF);
		} catch {
			// Unreadable prefs: the stock style.
		}
		set({ style: isOutputStyleId(saved) ? saved : "default", loaded: true });
	},
	setStyle: style => {
		set({ style });
		// A failed write only loses the choice across a restart; open tabs already follow it.
		void window.omp.prefs.set(OUTPUT_STYLE_PREF, style === "default" ? undefined : style).catch(() => {});
	},
	reset: () => set({ style: "default", loaded: false }),
}));
