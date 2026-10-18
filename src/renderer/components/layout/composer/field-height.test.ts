/**
 * The field's height fit measures the field at 0px. Its box must hold its height for that measuring
 * layout: the transcript above takes whatever the composer gives up, and Chromium clamps the
 * transcript's scroll offset to the larger viewport at that layout, for good (DI-2: a transcript riding
 * its live edge ended up under the composer, one line per keystroke).
 */
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { fieldCeiling, fitFieldHeight } from "./field-height";

const PANE = 800;
const BOX_PADDING = 16;
const LINE = 24;

/** linkedom lays nothing out: a pane, the composer field in its box, and the transcript that shares the pane. */
function composer(lines: number, boxStyle = "") {
	const { document } = parseHTML(
		`<div class="omp-session-pane"><div style="${boxStyle}"><textarea></textarea></div></div>`,
	);
	const pane = document.querySelector("div") as HTMLElement;
	const field = document.querySelector("textarea") as HTMLTextAreaElement;
	const box = field.parentElement as HTMLElement;
	field.value = Array.from({ length: lines }, (_, line) => `line ${line + 1}`).join("\n");
	field.style.height = `${LINE}px`;
	const px = (value: string) => Number.parseFloat(value) || 0;
	const boxHeight = () => Math.max(px(field.style.height) + BOX_PADDING, px(box.style.minHeight));
	const transcript = { scrollHeight: 5_000, scrollTop: 0, viewport: 0 };
	// One layout: the transcript gets what the composer leaves, and a viewport that grew clamps its offset.
	const layout = () => {
		transcript.viewport = PANE - boxHeight();
		transcript.scrollTop = Math.min(transcript.scrollTop, transcript.scrollHeight - transcript.viewport);
	};
	layout();
	transcript.scrollTop = transcript.scrollHeight - transcript.viewport;
	const reads: string[] = [];
	const read = (what: string, value: () => number) => () => {
		layout();
		reads.push(`${what} with box min-height "${box.style.minHeight}"`);
		return value();
	};
	Object.defineProperty(field, "scrollHeight", { get: read("field.scrollHeight", () => lines * LINE) });
	Object.defineProperty(pane, "clientHeight", { get: read("pane.clientHeight", () => PANE) });
	box.getBoundingClientRect = () => {
		layout();
		return { height: boxHeight() } as DOMRect;
	};
	return { field, box, transcript, reads, layout };
}

describe("fitFieldHeight", () => {
	it("grows the field to its text without moving a transcript that rides its live edge", () => {
		const { field, transcript, layout } = composer(4);
		const atEdge = transcript.scrollTop;
		fitFieldHeight(field, false);
		layout();
		expect(field.style.height).toBe(`${4 * LINE}px`);
		// The viewport shrank by three lines and the offset stayed: the transcript's resize observer closes
		// that distance. A clamp during the measure would have taken a line off the offset first.
		expect(transcript.scrollTop).toBe(atEdge);
		expect(transcript.scrollHeight - transcript.scrollTop - transcript.viewport).toBe(3 * LINE);
	});

	it("measures with the box held at its height, then hands the box its own min-height back", () => {
		const plain = composer(2);
		fitFieldHeight(plain.field, false);
		expect(plain.reads).toEqual([
			`pane.clientHeight with box min-height "${LINE + BOX_PADDING}px"`,
			`field.scrollHeight with box min-height "${LINE + BOX_PADDING}px"`,
		]);
		expect(plain.box.style.minHeight).toBe("");

		const styled = composer(2, "min-height: 10px");
		fitFieldHeight(styled.field, false);
		expect(styled.box.style.minHeight).toBe("10px");
	});

	it("shrinks back to its text", () => {
		const { field } = composer(1);
		field.style.height = `${6 * LINE}px`;
		fitFieldHeight(field, false);
		expect(field.style.height).toBe(`${LINE}px`);
	});

	it("leaves the expanded field's height to CSS", () => {
		const { field, box, reads } = composer(3);
		fitFieldHeight(field, true);
		expect(field.style.height).toBe("");
		expect(box.style.minHeight).toBe("");
		expect(reads).toEqual([]);
	});
});

describe("fieldCeiling", () => {
	it("is 40 % of the pane while the screen has room", () => {
		expect(fieldCeiling(800, 844)).toBe(320);
		expect(fieldCeiling(1000, 1200)).toBe(400);
	});

	it("never leaves less than 120 px of the visible screen (a phone with its keyboard up)", () => {
		// 508 px visible, a 500 px pane: 40 % would be 200, the visible room allows 388.
		expect(fieldCeiling(500, 508)).toBe(200);
		// 240 px visible (landscape with a keyboard): the field may take 120 of it.
		expect(fieldCeiling(300, 240)).toBe(120);
		expect(fieldCeiling(300, 100)).toBe(0);
	});
});
