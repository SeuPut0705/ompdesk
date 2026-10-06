import type { HLJSApi } from "highlight.js";

let hljsModule: HLJSApi | null = null;
let hljsPromise: Promise<HLJSApi> | null = null;

// Load the shared "common" language subset. Every code surface in the GUI —
// tool cards, markdown fences, diffs — highlights through this one lazy chunk.
export function loadHljs(): Promise<HLJSApi> {
	if (!hljsPromise) {
		hljsPromise = import("highlight.js/lib/common").then(mod => {
			hljsModule = mod.default;
			return mod.default;
		});
	}
	return hljsPromise;
}

/** The already-loaded hljs instance, or null while the lazy chunk is pending. */
export function getLoadedHljs(): HLJSApi | null {
	return hljsModule;
}

/** Above this size, highlight cost (grammar scan + span HTML) outweighs the
 * preview value; callers fall back to escaped plain text. Matches the diff
 * path's existing ceiling. */
export const HIGHLIGHT_CHAR_CAP = 20_000;
