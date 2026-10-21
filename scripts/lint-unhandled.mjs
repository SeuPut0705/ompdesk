/**
 * Unhandled rejection lint — a `void window.omp.…(…)` or `void tabRpc.…(…)` call must handle its rejection.
 *
 * Every `window.omp` call can reject (and every `tabRpc` call, the tab's RPC through the same transport): on a paired phone page it is a WebSocket call the dropped link fails with
 * "The link to the computer dropped", and a `void` call nobody catches is an unhandled rejection (a page error, and a
 * click that silently does nothing). The chain after the call must end in `.catch(…)` or a two-argument
 * `.then(onFulfilled, onRejected)`. A deliberate exception carries `unhandled-ok: <reason>` in a comment on the
 * statement. Links go through lib/open-external.ts, update buttons through stores/updater.ts runUpdaterAction.
 */
import ts from "typescript";

/** @param {ts.Expression} node */
function startsAtWindowOmp(node) {
	let current = node;
	let root = node;
	while (ts.isPropertyAccessExpression(root) || ts.isCallExpression(root) || ts.isElementAccessExpression(root))
		root = root.expression;
	if (ts.isIdentifier(root) && root.text === "tabRpc") return true;
	while (
		ts.isPropertyAccessExpression(current) ||
		ts.isCallExpression(current) ||
		ts.isElementAccessExpression(current)
	) {
		current = ts.isCallExpression(current) ? current.expression : current.expression;
		if (
			ts.isPropertyAccessExpression(current) &&
			current.name.text === "omp" &&
			ts.isIdentifier(current.expression) &&
			current.expression.text === "window"
		)
			return true;
	}
	return false;
}

/** @param {ts.Expression} node */
function handled(node) {
	let current = node;
	while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
		const name = current.expression.name.text;
		if (name === "catch") return true;
		if (name === "then" && current.arguments.length >= 2) return true;
		if (name !== "then" && name !== "finally") return false;
		current = current.expression.expression;
	}
	return false;
}

/**
 * @param {string} source
 * @param {string} [fileName]
 * @returns {{ line: number; text: string }[]}
 */
export function findUnhandledCalls(source, fileName = "file.tsx") {
	const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
	/** @type {{ line: number; text: string }[]} */
	const found = [];
	/** @param {ts.Node} node */
	function visit(node) {
		if (ts.isVoidExpression(node) && ts.isCallExpression(node.expression) && startsAtWindowOmp(node.expression)) {
			let statement = /** @type {ts.Node} */ (node);
			while (statement.parent && !ts.isStatement(statement) && !ts.isJsxAttribute(statement))
				statement = statement.parent;
			const text = `${source.slice(statement.getFullStart(), statement.getStart(file))}${statement.getText(file)}`;
			if (!handled(node.expression) && !/\bunhandled-ok\b/.test(text)) {
				const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
				found.push({ line, text: node.getText(file).split("\n")[0] });
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(file);
	return found;
}
