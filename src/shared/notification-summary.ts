/**
 * The desktop banner's body for a finished turn: the reply's opening prose
 * with its Markdown syntax removed, so a banner reads "Fixed the parser and
 * added two tests." instead of "## Summary\n- **Fixed** the `parser`".
 * Code blocks, images, tables and HTML carry no prose and are dropped; links
 * keep their text. Stock omp's TUI notification has no body, so there is no
 * stock counterpart to reuse.
 */

/** Banner bodies past this length are cut at a word with an ellipsis. */
export const NOTIFICATION_SUMMARY_LIMIT = 160;

export function notificationSummary(markdown: string, limit = NOTIFICATION_SUMMARY_LIMIT): string {
	const paragraphs = markdown
		// Fenced code (``` or ~~~) and HTML comments never read as prose.
		.replace(/^(```|~~~)[^\n]*\n[\s\S]*?(^\1[^\n]*$|(?![\s\S]))/gm, "\n")
		.replace(/<!--[\s\S]*?-->/g, "")
		.split("\n")
		.map(line => line.trim())
		// Table rows and separators, horizontal rules.
		.map(line => (/^\|.*\|$/.test(line) || /^([-*_]\s*){3,}$/.test(line) ? "" : line))
		.map(line =>
			line
				.replace(/^#{1,6}\s+/, "")
				.replace(/^(>\s*)+/, "")
				// A GitHub alert's marker line ("> [!NOTE]") names a style, not prose.
				.replace(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i, "")
				.replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, ""),
		)
		.join("\n")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/<\/?[a-zA-Z][^>]*>/g, "")
		.replace(/`+([^`]*)`+/g, "$1")
		.replace(/(\*\*|__)(.+?)\1/g, "$2")
		.replace(/(^|[^\w*])[*_](\S(?:.*?\S)?)[*_](?![\w*])/g, "$1$2")
		.replace(/~~(.+?)~~/g, "$1")
		// Paragraphs become sentences; line wraps inside one become spaces.
		.split(/\n\s*\n/)
		.map(paragraph => paragraph.replace(/\s+/g, " ").trim())
		.filter(paragraph => paragraph !== "");
	const prose = paragraphs
		.map((paragraph, index) =>
			index < paragraphs.length - 1 && !/[.!?:。]$/.test(paragraph) ? `${paragraph}.` : paragraph,
		)
		.join(" ");
	if (prose.length <= limit) return prose;
	const cut = prose.slice(0, limit - 1);
	const space = cut.lastIndexOf(" ");
	return `${(space > limit / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, "")}…`;
}
