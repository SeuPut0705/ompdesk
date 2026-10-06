/**
 * Contract tests for large-paste bookkeeping (plan/17 §3): the two
 * independent thresholds, marker text shape, submit-time expansion on every
 * dispatch path, and cleanup. Mirrors the TUI editor contract.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
	clearPastes,
	dropPaste,
	dropReferencedPastes,
	expandPasteMarkers,
	isMarkerSized,
	pasteMarkerText,
	referencedPasteIds,
	shouldOfferPasteMenu,
	storePaste,
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
