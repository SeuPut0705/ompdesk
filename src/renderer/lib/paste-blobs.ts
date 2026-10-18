// Stock pi-tui/components/editor paste atoms stay synchronous and draft-owned across tabs; omp is not shipped in the renderer.
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
/**
 * Blobs whose marker was deleted from the draft ({@link releasePaste}): out of the store, so nothing references or
 * sends them, but kept for a few edits so Cmd/Ctrl+Z, which brings the marker's text back, brings the paste back.
 */
const released = new Map<number, PasteBlob>();
const RELEASED_KEEP = 16;
let pasteCounter = 0;

/** The live blob of a marker id; a released one comes back the moment its marker is in the draft again. */
function lookup(id: number): PasteBlob | undefined {
	const live = blobs.get(id);
	if (live) return live;
	const back = released.get(id);
	if (!back) return undefined;
	released.delete(id);
	blobs.set(id, back);
	return back;
}

/** A blob this module knows (live or released): its marker text is a marker, not something the user typed. */
const knows = (id: number): boolean => blobs.has(id) || released.has(id);

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

export function dropPaste(id: number): void {
	blobs.delete(id);
	released.delete(id);
}

/** Take a paste out of the store because its marker left the draft; an undo of that edit revives it. */
export function releasePaste(id: number): void {
	const blob = blobs.get(id);
	if (!blob) return;
	blobs.delete(id);
	released.set(id, blob);
	if (released.size > RELEASED_KEEP) {
		const oldest = released.keys().next().value;
		if (oldest !== undefined) released.delete(oldest);
	}
}

export function clearPastes(): void {
	blobs.clear();
	released.clear();
}

// Suffix mirrors the TUI's marker (editor.ts:1685): the ", +N lines"/", N
// chars" part is optional so a partially-edited marker (e.g. the user deleted
// just the suffix in the plain-textarea composer) still expands instead of
// leaking literal marker text to the agent.
const MARKER_RE = /\[Paste #(\d+)(?:, (?:\+\d+ lines|\d+ chars))?\]/g;

/** Substitute every known marker back to its full content (submit-time). */
export function expandPasteMarkers(draft: string): string {
	return draft.replace(MARKER_RE, (marker, idText: string) => {
		const blob = lookup(Number(idText));
		return blob ? blob.content : marker;
	});
}

/** Ids of markers actually referenced by the current draft. */
export function referencedPasteIds(draft: string): number[] {
	const ids: number[] = [];
	for (const match of draft.matchAll(MARKER_RE)) {
		const id = Number(match[1]);
		if (lookup(id)) ids.push(id);
	}
	return ids;
}

export function getPaste(id: number): PasteBlob | undefined {
	return lookup(id);
}

/**
 * Replace a paste's text in place (the "Edit pasted text" dialog) and return
 * the draft with that paste's marker rewritten to describe the new size; the
 * id stays, so every other marker and the caret context are untouched.
 */
export function editPaste(draft: string, id: number, content: string): string {
	const blob = lookup(id);
	if (!blob) return draft;
	blobs.set(id, { id, content, lineCount: content.split("\n").length, charCount: content.length });
	return draft.replace(MARKER_RE, (marker, idText: string) =>
		Number(idText) === id ? pasteMarkerText(id, content) : marker,
	);
}

/** Remove only blobs consumed by one composer draft. Other tabs can hold their
 * own paste markers at the same time, so successful submit must not clear the
 * process-wide store. */
export function dropReferencedPastes(draft: string): void {
	for (const id of referencedPasteIds(draft)) blobs.delete(id);
}

export interface PasteMarkerSpan {
	id: number;
	start: number;
	end: number;
}

/** The markers of known pastes in the draft, in order (a marker nobody stored is text the user typed). */
export function pasteMarkerSpans(draft: string): PasteMarkerSpan[] {
	const spans: PasteMarkerSpan[] = [];
	for (const match of draft.matchAll(MARKER_RE)) {
		const id = Number(match[1]);
		if (knows(id)) spans.push({ id, start: match.index, end: match.index + match[0].length });
	}
	return spans;
}

/**
 * A deletion of `[from, to)` widened to take whole markers: a marker is one unit (the TUI's editor treats it as an
 * atom), so an edit that touches any part of it removes all of it. Null when the range touches no marker.
 */
export function widenToPasteMarkers(
	draft: string,
	from: number,
	to: number,
): { from: number; to: number; ids: number[] } | null {
	let start = from;
	let end = to;
	const ids: number[] = [];
	for (const span of pasteMarkerSpans(draft)) {
		if (span.start < to && span.end > from) {
			start = Math.min(start, span.start);
			end = Math.max(end, span.end);
			ids.push(span.id);
		}
	}
	return ids.length > 0 ? { from: start, to: end, ids } : null;
}

/** The draft with one paste's marker replaced by its text (the chip's "Paste as text"); the blob is done with. */
export function expandPasteMarkerAsText(
	draft: string,
	id: number,
): { text: string; at: number; length: number } | null {
	const span = pasteMarkerSpans(draft).find(candidate => candidate.id === id);
	const blob = span ? lookup(id) : undefined;
	if (!span || !blob) return null;
	blobs.delete(id);
	return {
		text: `${draft.slice(0, span.start)}${blob.content}${draft.slice(span.end)}`,
		at: span.start,
		length: blob.content.length,
	};
}

const CLOSING_FRAGMENT_RE = /Paste #(\d+), (?:\+\d+ lines|\d+ chars)\]/g;

/**
 * What is left of a paste marker once an edit cut into it (`[Paste #3, +15 lines` or `Paste #3, +15 lines]`): text
 * that names a paste of this session but is no marker, so it would reach the agent as literal text while the
 * paste's content stayed behind. Null when the draft has none.
 */
export function danglingPasteFragment(draft: string): string | null {
	if (!draft.includes("Paste #")) return null;
	const rest = draft.replace(MARKER_RE, "\uE000");
	for (const match of rest.matchAll(/\[Paste #(\d+)[^\]\n]{0,24}/g)) if (knows(Number(match[1]))) return match[0];
	for (const match of rest.matchAll(CLOSING_FRAGMENT_RE)) if (knows(Number(match[1]))) return match[0];
	return null;
}
