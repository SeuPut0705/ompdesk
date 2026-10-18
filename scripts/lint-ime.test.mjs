import { describe, expect, it } from "vitest";
import { findImeViolations } from "./lint-ime.mjs";

describe("lint-ime", () => {
	it("flags a key handler that acts on Enter without the IME guard", () => {
		const source = `
export function Row() {
	return <input onKeyDown={event => { if (event.key === "Enter") commit(); }} />;
}
`;
		expect(findImeViolations(source)).toHaveLength(1);
	});

	it("flags a switch case on Enter and a !== early return with no guard", () => {
		const source = `
const a = (event: KeyboardEvent) => {
	switch (event.key) {
		case "Enter":
			go();
	}
};
const b = (e: KeyboardEvent) => {
	if (e.key !== "Enter") return;
	go();
};
`;
		expect(findImeViolations(source)).toHaveLength(2);
	});

	it("accepts a handler that uses isImeKeyEvent, isComposing or keyCode 229", () => {
		const source = `
const a = (event) => { if (isImeKeyEvent(event)) return; if (event.key === "Enter") go(); };
const b = (event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) go(); };
const c = (event) => { if (event.key === "Enter" && event.keyCode !== 229) go(); };
`;
		expect(findImeViolations(source)).toEqual([]);
	});

	it("accepts an explicit ime-ok escape and ignores strings that are not key tests", () => {
		const source = `
// ime-ok: a button, never a text field
const a = (event) => { if (event.key === "Enter") go(); };
const b = (event) => { if (event.key === "Tab") go(); };
const labels = { send: "Enter" };
`;
		expect(findImeViolations(source)).toEqual([]);
	});

	it("does not let a guard in a sibling function excuse another handler", () => {
		const source = `
const guarded = (event) => { if (isImeKeyEvent(event)) return; };
const raw = (event) => { if (event.key === "Enter") go(); };
`;
		expect(findImeViolations(source).map(hit => hit.line)).toEqual([3]);
	});
});
