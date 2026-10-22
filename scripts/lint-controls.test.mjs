import { describe, expect, it } from "vitest";
import { compareToBaseline, findRawControls, isCounted } from "./lint-controls.mjs";

describe("lint-controls", () => {
	it("finds raw buttons, raw checkboxes and radios, and hand-made dialogs", () => {
		const source = `
const a = <button onClick={go}>Go</button>;
const b = <input type="checkbox" checked={on} />;
const c = <input type={"radio"} name="x" />;
const d = <div role="dialog" aria-modal>…</div>;
`;
		expect(findRawControls(source).map(hit => hit.line)).toEqual([2, 3, 4, 5]);
	});

	it("leaves the shared components, other inputs and a controls-ok escape alone", () => {
		const source = `
const a = <Button onClick={go}>Go</Button>;
const b = <input type="file" hidden />;
const c = <input value={text} onChange={set} />;
// controls-ok: a listbox option driven by aria-activedescendant
const d = <button role="option" />;
const e = <button className="omp-row" />; // controls-ok: the row's box is .omp-row
const f = <div role="status" />;
`;
		expect(findRawControls(source)).toEqual([]);
	});

	it("counts renderer components only, never the primitives or tests", () => {
		expect(isCounted("components/chat/ChatStream.tsx")).toBe(true);
		expect(isCounted("components/common/Button.tsx")).toBe(false);
		expect(isCounted("components/chat/ChatStream.test.tsx")).toBe(false);
		expect(isCounted("lib/format.ts")).toBe(false);
	});

	it("fails a file above its baseline and a baseline above its file, so the count only goes down", () => {
		const hit = { line: 1, kind: "raw <button>" };
		const hits = new Map([
			["components/a.tsx", [hit, hit, hit]],
			["components/new.tsx", [hit]],
			["components/c.tsx", [hit]],
		]);
		const baseline = { "components/a.tsx": 2, "components/b.tsx": 1, "components/c.tsx": 1 };
		const messages = compareToBaseline(hits, baseline).filter(line => !line.startsWith("  "));
		expect(messages).toEqual([
			expect.stringMatching(/^components\/a\.tsx: 3 raw controls, baseline 2/),
			expect.stringMatching(/^components\/new\.tsx: 1 raw controls, baseline 0/),
			expect.stringMatching(/^components\/b\.tsx: baseline 1, now 0/),
		]);
	});
});
