import katex from "katex";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { replaceMathWithTex } from "./math-copy";

const { document } = parseHTML("<html><body></body></html>");

/** A copied selection as the transcript renders it: text, inline math, display math. */
function selection(): DocumentFragment {
	const holder = document.createElement("div");
	holder.innerHTML = `<p>Download time ${katex.renderToString("t = \\frac{S}{B}")} for size S:</p>${katex.renderToString("P = 1 - \\prod_{i=1}^{n} p_i", { displayMode: true })}`;
	const fragment = document.createDocumentFragment();
	fragment.append(...holder.childNodes);
	return fragment as unknown as DocumentFragment;
}

describe("replaceMathWithTex", () => {
	it("copies each formula once, as its TeX source", () => {
		const fragment = selection();
		expect(replaceMathWithTex(fragment)).toBe(true);
		const out = document.createElement("div");
		out.append(fragment as never);
		const text = out.textContent ?? "";
		expect(text).toContain("Download time $t = \\frac{S}{B}$ for size S:");
		expect(text).toContain("$$P = 1 - \\prod_{i=1}^{n} p_i$$");
		// Neither rendering is left behind: no MathML glyph runs, no HTML layer.
		expect(out.querySelector(".katex")).toBeNull();
	});

	it("leaves a selection without math to the browser", () => {
		const holder = document.createElement("p");
		holder.textContent = "Plain words";
		const fragment = document.createDocumentFragment();
		fragment.append(holder);
		expect(replaceMathWithTex(fragment as unknown as DocumentFragment)).toBe(false);
	});
});
