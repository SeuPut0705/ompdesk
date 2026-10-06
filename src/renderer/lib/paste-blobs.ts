/**
 * Large-paste bookkeeping for the composer, mirroring the TUI editor
 * (`packages/tui/src/components/editor.ts`). The draft text carries compact
 * `[Paste #N, …]` markers; the full blob lives here in memory and is
 * substituted back in at submit time. Marker generation, blob storage, and
 * expansion all go through this one module so the three can never drift
 * (plan/17 §3.1).
 *
 * Two independent thresholds (do NOT merge them):
 * - marker collapse: > 10 lines OR > 1000 chars — pasted text collapses to a marker
 * - menu popup:      `paste.largeMenuThreshold` (default 100) LINES — offers the
 *                    wrap/inline choice; 0 disables the menu but markers still apply
 */

export interface PasteBlob {
	id: number;
	content: string;
	lineCount: number;
	charCount: number;
}

/** Pasted text collapses to a `[Paste #N]` marker at all (editor.ts:2010). */
export function isMarkerSized(text: string): boolean {
	return text.split("\n").length > 10 || text.length > 1000;
}

/** The paste menu should be offered (line-count-only gate, input-controller.ts:1693-1697). */
export function shouldOfferPasteMenu(lineCount: number, threshold: number): boolean {
	return threshold > 0 && lineCount >= threshold;
}

/** Wrap content as an attachment block (TUI `wrapPasteInAttachmentBlock`). */
export function wrapPasteInAttachmentBlock(content: string): string {
	return `<attachment>\n${content}\n</attachment>`;
}

/** Marker text shown in the draft (editor.ts:2071-2080). */
export function pasteMarkerText(id: number, content: string): string {
	const lineCount = content.split("\n").length;
	return lineCount > 10 ? `[Paste #${id}, +${lineCount} lines]` : `[Paste #${id}, ${content.length} chars]`;
}

/**
 * In-memory blob store keyed by marker id. Deliberately NOT a zustand store:
 * draft typing must not re-render subscribers on every keystroke (plan/15 §3.5).
 */
const blobs = new Map<number, PasteBlob>();
let pasteCounter = 0;

export function storePaste(content: string): PasteBlob {
	const blob: PasteBlob = {
		id: ++pasteCounter,
		content,
		lineCount: content.split("\n").length,
		charCount: content.length,
	};
	blobs.set(blob.id, blob);
	return blob;
}

export function getPaste(id: number): PasteBlob | undefined {
	return blobs.get(id);
}

export function dropPaste(id: number): void {
	blobs.delete(id);
}

export function clearPastes(): void {
	blobs.clear();
}

// Suffix mirrors the TUI's marker (editor.ts:1685): the ", +N lines"/", N
// chars" part is optional so a partially-edited marker (e.g. the user deleted
// just the suffix in the plain-textarea composer) still expands instead of
// leaking literal marker text to the agent.
const MARKER_RE = /\[Paste #(\d+)(?:, (?:\+\d+ lines|\d+ chars))?\]/g;

/** Substitute every known marker back to its full content (submit-time). */
export function expandPasteMarkers(draft: string): string {
	return draft.replace(MARKER_RE, (marker, idText: string) => {
		const blob = blobs.get(Number(idText));
		return blob ? blob.content : marker;
	});
}

/** Ids of markers actually referenced by the current draft. */
export function referencedPasteIds(draft: string): number[] {
	const ids: number[] = [];
	for (const match of draft.matchAll(MARKER_RE)) {
		const id = Number(match[1]);
		if (blobs.has(id)) ids.push(id);
	}
	return ids;
}

/** Remove only blobs consumed by one composer draft. Other tabs can hold their
 * own paste markers at the same time, so successful submit must not clear the
 * process-wide store. */
export function dropReferencedPastes(draft: string): void {
	for (const id of referencedPasteIds(draft)) blobs.delete(id);
}
