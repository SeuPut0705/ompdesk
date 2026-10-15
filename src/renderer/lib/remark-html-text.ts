/**
 * User-written text is shown as typed: an HTML tag in a prompt (`<h1>Tally</h1>`)
 * is part of what was sent, so it renders as that text instead of a heading,
 * and instead of vanishing when the sanitizer drops the raw node.
 */
import type { Parent, Root, RootContent, Text } from "mdast";

/** Parents whose children are inline; a raw block under any other parent needs a paragraph of its own. */
const INLINE_PARENTS: ReadonlySet<string> = new Set([
	"paragraph",
	"heading",
	"emphasis",
	"strong",
	"delete",
	"link",
	"linkReference",
	"tableCell",
]);

function convertChildren(parent: Parent): void {
	parent.children = parent.children.map((child): RootContent => {
		if (child.type === "html") {
			const text: Text = { type: "text", value: child.value };
			return INLINE_PARENTS.has(parent.type) ? text : { type: "paragraph", children: [text] };
		}
		if ("children" in child) convertChildren(child);
		return child;
	});
}

export function remarkHtmlAsText() {
	return (tree: Root) => convertChildren(tree);
}
