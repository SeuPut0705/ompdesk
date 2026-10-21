/**
 * Locale lint — a renderer number or date is formatted in the UI language, never the OS's.
 *
 * `n.toLocaleString()`, `d.toLocaleDateString()` and `d.toLocaleTimeString()` with no locale use the OS locale, so a
 * German Windows grouped "20.000" in the English UI. Pass `uiLocale()` (lib/format.ts) or use a lib/format helper. A
 * deliberate exception carries `locale-ok: <reason>` in a comment on the line.
 */
import ts from "typescript";

const METHODS = new Set(["toLocaleString", "toLocaleDateString", "toLocaleTimeString"]);

/**
 * @param {string} source
 * @param {string} [fileName]
 * @returns {{ line: number; text: string }[]}
 */
export function findLocaleViolations(source, fileName = "file.tsx") {
	const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
	const lines = source.split("\n");
	/** @type {{ line: number; text: string }[]} */
	const found = [];
	/** @param {ts.Node} node */
	function visit(node) {
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			METHODS.has(node.expression.name.text) &&
			(node.arguments.length === 0 ||
				node.arguments[0]?.kind === ts.SyntaxKind.UndefinedKeyword ||
				isUndefined(node.arguments[0]))
		) {
			const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
			if (!/\blocale-ok\b/.test(lines[line - 1] ?? ""))
				found.push({ line, text: node.getText(file).split("\n")[0] });
		}
		ts.forEachChild(node, visit);
	}
	visit(file);
	return found;
}

/** @param {ts.Node | undefined} node */
function isUndefined(node) {
	return node !== undefined && ts.isIdentifier(node) && node.text === "undefined";
}
