import { describe, expect, it } from "vitest";
import { compareToBaseline, findRawControls, isCounted, seedNewKinds } from "./lint-controls.mjs";

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

	it("finds hand-made tab strips, progress bars and turning loaders", () => {
		const source = `
const a = <div role="tablist">{tabs}</div>;
const b = <span role="tab" aria-selected={on} />;
const c = <div role="progressbar" aria-valuenow={0.4} />;
const d = <Loader2 className="size-4 animate-spin" />;
const e = <LoaderCircle className={cx("animate-spin", muted && "opacity-50")} />;
`;
		expect(findRawControls(source).map(hit => [hit.line, hit.id])).toEqual([
			[2, "tab"],
			[3, "tab"],
			[4, "progressbar"],
			[5, "spinner"],
			[6, "spinner"],
		]);
	});

	it("leaves a still loader icon, a tab role it cannot read and a controls-ok tab alone", () => {
		const source = `
const a = <Loader2 className="size-4" />;
const b = <RefreshCw className="size-4" />;
const c = <div role={role} />;
// controls-ok: the phone's bottom bar is laid out by mobile.css
const d = <button role="tab" />;
`;
		expect(findRawControls(source)).toEqual([]);
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

	it("seeds the later kinds once without raising any file's first-kind count", () => {
		const at = id => ({ line: 1, kind: id, id });
		const hits = new Map([
			// One raw button over its baseline of 1 stays failing; its tab strip is frozen.
			["components/a.tsx", [at("button"), at("button"), at("tab")]],
			// Holds only later kinds: added.
			["components/new.tsx", [at("progressbar"), at("spinner")]],
			// Fixed since: a stale entry drops out.
			["components/c.tsx", []],
		]);
		const baseline = { "components/a.tsx": 1, "components/c.tsx": 2 };
		expect(seedNewKinds(hits, baseline)).toEqual({ "components/a.tsx": 2, "components/new.tsx": 2 });
	});
});
