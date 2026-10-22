/**
 * A person's own text keeps the line breaks they typed (Shift+Enter in the composer): Markdown reads a single newline
 * inside a paragraph as a space, so a multi-line prompt showed as one run-on line in its bubble. Every newline in a
 * text node becomes a line break, as GitHub does for comments (remark-breaks' rule). Code keeps its own lines.
 */
import type { Break, Parent, Root, RootContent, Text } from "mdast";

function split(text: Text): Array<Text | Break> {
	const parts = text.value.split(/\r?\n|\r/);
	return parts.flatMap((value, index): Array<Text | Break> => {
		const node: Text[] = value ? [{ type: "text", value }] : [];
		return index === 0 ? node : [{ type: "break" }, ...node];
	});
}

function convertChildren(parent: Parent): void {
	parent.children = parent.children.flatMap((child): RootContent[] => {
		if (child.type === "text")
			return child.value.includes("\n") || child.value.includes("\r") ? split(child) : [child];
		if ("children" in child) convertChildren(child);
		return [child];
	});
}

export function remarkSoftBreaks() {
	return (tree: Root) => convertChildren(tree);
}
