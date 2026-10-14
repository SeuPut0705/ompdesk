/**
 * Copying a selection that runs through rendered math. KaTeX renders every
 * formula twice (MathML for assistive tech, HTML for the eye), so the browser's
 * own copy pasted both, one glyph per line. Here each formula becomes its TeX
 * source — `$…$` inline, `$$…$$` on its own line for display math — and the
 * rest keeps the browser's plain-text layout (paragraph breaks, tab-separated
 * table cells). KaTeX's `contrib/copy-tex` does the same swap but flattens the
 * whole selection to `textContent`, losing every line break around the math.
 */

/** Grow a range end that falls inside a formula to cover the whole formula. */
function formulaAround(node: Node): Element | null {
	const element = node instanceof Element ? node : node.parentElement;
	return element?.closest(".katex-display") ?? element?.closest(".katex") ?? null;
}

/** Replace each formula in `fragment` with its TeX source; false when it holds none. */
export function replaceMathWithTex(fragment: DocumentFragment): boolean {
	const formulas = fragment.querySelectorAll(".katex");
	if (formulas.length === 0) return false;
	const doc = fragment.ownerDocument;
	for (const formula of formulas) {
		const tex = formula.querySelector(".katex-mathml annotation")?.textContent ?? formula.textContent ?? "";
		const display = formula.parentElement?.classList.contains("katex-display") ?? false;
		const source = doc.createElement(display ? "div" : "span");
		source.textContent = display ? `$$${tex}$$` : `$${tex}$`;
		(display && formula.parentElement ? formula.parentElement : formula).replaceWith(source);
	}
	return true;
}

/** The `copy` listener: TeX for the formulas, the browser's text layout for the rest. */
export function copyMathAsTex(event: ClipboardEvent): void {
	const selection = document.getSelection();
	if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !event.clipboardData) return;
	const range = selection.getRangeAt(0).cloneRange();
	const start = formulaAround(range.startContainer);
	if (start) range.setStartBefore(start);
	const end = formulaAround(range.endContainer);
	if (end) range.setEndAfter(end);
	const html = document.createElement("div");
	html.append(range.cloneContents());
	const fragment = range.cloneContents();
	if (!replaceMathWithTex(fragment)) return;
	// innerText needs a rendered element to lay out blocks, rows and cells.
	const holder = document.createElement("div");
	holder.style.cssText = "position:fixed;left:-100000px;top:0;width:60rem;white-space:normal";
	holder.append(fragment);
	document.body.append(holder);
	const text = holder.innerText;
	holder.remove();
	event.clipboardData.setData("text/html", html.innerHTML);
	event.clipboardData.setData("text/plain", text);
	event.preventDefault();
}
