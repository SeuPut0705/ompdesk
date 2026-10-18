/**
 * Contract tests for large-paste bookkeeping (plan/17 §3): the two
 * independent thresholds, marker text shape, submit-time expansion on every
 * dispatch path, and cleanup. Mirrors the TUI editor contract.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
	clearPastes,
	danglingPasteFragment,
	dropPaste,
	dropReferencedPastes,
	expandPasteMarkerAsText,
	expandPasteMarkers,
	isMarkerSized,
	pasteMarkerSpans,
	pasteMarkerText,
	referencedPasteIds,
	releasePaste,
	shouldOfferPasteMenu,
	storePaste,
	widenToPasteMarkers,
	wrapPasteInAttachmentBlock,
} from "./paste-blobs";

beforeEach(() => clearPastes());

describe("thresholds", () => {
	it("collapses to a marker past 10 lines OR 1000 chars", () => {
		expect(isMarkerSized("short")).toBe(false);
		expect(isMarkerSized(Array(11).fill("line").join("\n"))).toBe(true); // 11 lines
		expect(isMarkerSized("x".repeat(1001))).toBe(true); // single long line
		expect(isMarkerSized(Array(10).fill("line").join("\n"))).toBe(false); // exactly 10 lines
		expect(isMarkerSized("x".repeat(1000))).toBe(false); // exactly 1000 chars
	});

	it("menu gate is line-count-only and 0 disables it", () => {
		expect(shouldOfferPasteMenu(100, 100)).toBe(true);
		expect(shouldOfferPasteMenu(99, 100)).toBe(false);
		expect(shouldOfferPasteMenu(500, 0)).toBe(false);
		// A single 5000-char line hits the marker threshold but NOT the menu.
		expect(isMarkerSized("x".repeat(5000))).toBe(true);
		expect(shouldOfferPasteMenu(1, 100)).toBe(false);
	});
});

describe("marker text", () => {
	it("uses +N lines past 10 lines, char count otherwise", () => {
		const multiline = Array(20).fill("l").join("\n");
		expect(pasteMarkerText(3, multiline)).toBe("[Paste #3, +20 lines]");
		expect(pasteMarkerText(4, "x".repeat(1500))).toBe("[Paste #4, 1500 chars]");
	});
});

describe("expansion", () => {
	it("expands markers back to full content", () => {
		const content = Array(20).fill("code line").join("\n");
		const blob = storePaste(content);
		const draft = `please review\n${pasteMarkerText(blob.id, blob.content)}\nthanks`;
		expect(expandPasteMarkers(draft)).toBe(`please review\n${content}\nthanks`);
	});

	it("expands a known marker after the user removes its count suffix", () => {
		const content = "x".repeat(1500);
		const blob = storePaste(content);
		expect(expandPasteMarkers(`[Paste #${blob.id}]`)).toBe(content);
	});

	it("leaves unknown markers untouched", () => {
		expect(expandPasteMarkers("a [Paste #99, +20 lines] b")).toBe("a [Paste #99, +20 lines] b");
	});

	it("expands attachment-wrapped blobs", () => {
		const content = "wrapped content";
		const blob = storePaste(wrapPasteInAttachmentBlock(content));
		const expanded = expandPasteMarkers(pasteMarkerText(blob.id, blob.content));
		expect(expanded).toBe("<attachment>\nwrapped content\n</attachment>");
	});

	it("references only ids present in the draft", () => {
		const a = storePaste("a".repeat(1500));
		const b = storePaste("b".repeat(1500));
		const draft = `${pasteMarkerText(a.id, a.content)} and ${pasteMarkerText(b.id, b.content)}`;
		expect(referencedPasteIds(draft).sort()).toEqual([a.id, b.id]);
		dropPaste(a.id);
		expect(referencedPasteIds(draft)).toEqual([b.id]);
	});

	it("clearPastes empties the store so markers no longer expand", () => {
		const blob = storePaste("x".repeat(1500));
		const marker = pasteMarkerText(blob.id, blob.content);
		clearPastes();
		expect(expandPasteMarkers(marker)).toBe(marker);
	});

	it("drops only the markers consumed by one tab's draft", () => {
		const active = storePaste("active".repeat(300));
		const background = storePaste("background".repeat(200));
		const activeMarker = pasteMarkerText(active.id, active.content);
		const backgroundMarker = pasteMarkerText(background.id, background.content);

		dropReferencedPastes(activeMarker);

		expect(expandPasteMarkers(activeMarker)).toBe(activeMarker);
		expect(expandPasteMarkers(backgroundMarker)).toBe(background.content);
	});
});

describe("a marker is one unit (DI-3)", () => {
	const content = Array.from({ length: 15 }, (_, line) => `line ${line}`).join("\n");

	it("widens a deletion that touches any part of a marker to the whole marker", () => {
		const blob = storePaste(content);
		const marker = pasteMarkerText(blob.id, content);
		const draft = `see ${marker} now`;
		expect(pasteMarkerSpans(draft)).toEqual([{ id: blob.id, start: 4, end: 4 + marker.length }]);
		// Backspace right after the marker's closing bracket: the last character only.
		const widened = widenToPasteMarkers(draft, 4 + marker.length - 1, 4 + marker.length);
		expect(widened).toEqual({ from: 4, to: 4 + marker.length, ids: [blob.id] });
		// A range inside it, and one that only clips its first character.
		expect(widenToPasteMarkers(draft, 8, 10)?.from).toBe(4);
		expect(widenToPasteMarkers(draft, 3, 5)?.to).toBe(4 + marker.length);
		// Next to it, or elsewhere: no marker touched.
		expect(widenToPasteMarkers(draft, 0, 4)).toBeNull();
		expect(widenToPasteMarkers(draft, 4 + marker.length, draft.length)).toBeNull();
	});

	it("leaves a marker nobody stored alone: that is text the user typed", () => {
		expect(widenToPasteMarkers("a [Paste #99, +20 lines] b", 3, 6)).toBeNull();
	});

	it("a released paste is out of the store until its marker is back (undo)", () => {
		const blob = storePaste(content);
		const marker = pasteMarkerText(blob.id, content);
		releasePaste(blob.id);
		expect(referencedPasteIds("gone")).toEqual([]);
		// While the marker is out of the draft nothing sends the paste.
		expect(expandPasteMarkers("gone")).toBe("gone");
		// Cmd/Ctrl+Z brings the marker's text back and the paste with it.
		expect(expandPasteMarkers(marker)).toBe(content);
		expect(referencedPasteIds(marker)).toEqual([blob.id]);
	});

	it("finds the fragment an edit left of a marker, only for pastes it knows", () => {
		const blob = storePaste(content);
		const marker = pasteMarkerText(blob.id, content);
		expect(danglingPasteFragment(`ask ${marker}`)).toBeNull();
		expect(danglingPasteFragment(marker.slice(0, -1))).toBe(marker.slice(0, -1));
		expect(danglingPasteFragment(marker.slice(1))).toBe(marker.slice(1));
		expect(danglingPasteFragment(`${marker.slice(0, 10)} more`)).toContain("[Paste #");
		expect(danglingPasteFragment("[Paste #404, +9 lines")).toBeNull();
		expect(danglingPasteFragment("plain text")).toBeNull();
	});

	it("expands one marker into its text", () => {
		const blob = storePaste(content);
		const marker = pasteMarkerText(blob.id, content);
		const out = expandPasteMarkerAsText(`a ${marker} b`, blob.id);
		expect(out).toEqual({ text: `a ${content} b`, at: 2, length: content.length });
		// The blob is done with: a second ask finds no marker's paste.
		expect(expandPasteMarkerAsText(`a ${marker} b`, blob.id)).toBeNull();
	});

	it("dropPaste forgets a released paste too", () => {
		const blob = storePaste(content);
		releasePaste(blob.id);
		dropPaste(blob.id);
		expect(expandPasteMarkers(pasteMarkerText(blob.id, content))).toBe(pasteMarkerText(blob.id, content));
	});
});
