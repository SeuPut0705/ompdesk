/**
 * A message's Markdown as one line of reading text, for previews too small to render it (the session tree's
 * node cards, whose `textPreview` arrives with its line breaks already collapsed to spaces): heading, quote and
 * list markers, fences, table rules, emphasis, inline code and link syntax go, the words stay. Not a parser: a
 * preview is a couple of clipped lines, and a marker it misses shows as typed.
 */
export function markdownPlainText(markdown: string): string {
	let text = markdown.replace(/\s+/g, " ");
	// A table's rule row (`|---|:--:|`) marks a table: then its cell bars read as separators.
	const rule = /\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?/g;
	if (rule.test(text)) text = text.replace(rule, " ").replace(/\s*\|(?:\s*\|)*\s*/g, " · ");
	return text
		.replace(/(^|\s)#{1,6}(?=\s)/g, "$1")
		.replace(/(^|\s)(`{3,}|~{3,})[\w-]*/g, "$1")
		.replace(/^\s*(?:>\s*)+/, "")
		.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, "$2")
		.replace(/(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])/g, "$1")
		.replace(/(?<!\w)_(?=\S)(.+?)(?<=\S)_(?!\w)/g, "$1")
		.replace(/~~(?=\S)(.+?)(?<=\S)~~/g, "$1")
		.replace(/`+([^`]+)`+/g, "$1")
		.replace(/^\s*·\s*|\s*·\s*$/g, "")
		.replace(/\s+/g, " ")
		.trim();
}
