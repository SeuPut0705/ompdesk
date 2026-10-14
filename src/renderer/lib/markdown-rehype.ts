/**
 * Rehype steps of the markdown pipeline (lib/markdown.tsx) that stock's TUI
 * has no counterpart for, since a terminal has no anchors or alert boxes:
 * GitHub-style heading ids and GitHub alerts (`> [!NOTE]`).
 */
import type { Element, ElementContent, Root } from "hast";

/**
 * Prefix rehype-sanitize puts before every `id` (and aria id reference), so
 * model output can never shadow an app element or a `window` global. In-page
 * `#fragment` links name the unprefixed id, as on GitHub.
 */
export const MARKDOWN_ID_PREFIX = "user-content-";

function walk(node: Root | Element, visit: (element: Element) => void): void {
	for (const child of node.children) {
		if (child.type !== "element") continue;
		visit(child);
		walk(child, visit);
	}
}

function textOf(node: ElementContent): string {
	if (node.type === "text") return node.value;
	if (node.type === "element") return node.children.map(textOf).join("");
	return "";
}

/** github-slugger's slug: lowercase, punctuation and symbols dropped, spaces to "-". */
export function headingSlug(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
		.replace(/ /g, "-");
}

const HEADING = /^h[1-6]$/;

/**
 * Give every heading GitHub's id (repeats get `-1`, `-2`, … as github-slugger
 * numbers them). Runs before sanitize, which prefixes the id like any other.
 * A heading that already has one (raw HTML, the footnote label) keeps it.
 */
export function rehypeHeadingIds() {
	return (tree: Root) => {
		const occurrences = new Map<string, number>();
		walk(tree, element => {
			if (!HEADING.test(element.tagName) || element.properties.id != null) return;
			const base = headingSlug(element.children.map(textOf).join(""));
			if (!base) return;
			let slug = base;
			while (occurrences.has(slug)) {
				const next = (occurrences.get(base) ?? 0) + 1;
				occurrences.set(base, next);
				slug = `${base}-${next}`;
			}
			occurrences.set(slug, 0);
			element.properties.id = slug;
		});
	};
}

export const MARKDOWN_ALERT_KINDS = ["note", "tip", "important", "warning", "caution"] as const;
export type MarkdownAlertKind = (typeof MARKDOWN_ALERT_KINDS)[number];

/** The marker alone on the quote's first line, as GitHub requires. */
const ALERT_MARKER = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\r?\n|$)/i;

export function isMarkdownAlertKind(value: unknown): value is MarkdownAlertKind {
	return typeof value === "string" && (MARKDOWN_ALERT_KINDS as readonly string[]).includes(value);
}

/**
 * GitHub alerts: a blockquote whose first line is `[!NOTE]` (TIP, IMPORTANT,
 * WARNING, CAUTION) loses the marker and carries `data-alert="note"` for the
 * Blockquote component. Runs after sanitize: the attribute is renderer-owned,
 * never something raw HTML can set.
 */
export function rehypeAlerts() {
	return (tree: Root) => {
		walk(tree, element => {
			if (element.tagName !== "blockquote") return;
			const first = element.children.find(child => child.type === "element");
			if (first?.type !== "element" || first.tagName !== "p") return;
			const head = first.children[0];
			if (head?.type !== "text") return;
			const match = ALERT_MARKER.exec(head.value);
			const kind = match?.[1]?.toLowerCase();
			if (!match || !isMarkdownAlertKind(kind)) return;
			head.value = head.value.slice(match[0].length);
			if (!head.value) first.children.shift();
			if (first.children[0]?.type === "element" && first.children[0].tagName === "br") first.children.shift();
			if (first.children.length === 0) element.children.splice(element.children.indexOf(first), 1);
			element.properties.dataAlert = kind;
		});
	};
}
