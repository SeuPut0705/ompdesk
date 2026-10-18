/**
 * IME guard lint — an Enter key handler must not act on the Enter that commits
 * a Korean/Japanese/Chinese composition.
 *
 * A renderer function that compares a key event's `key`/`code` to "Enter" (a
 * `===`/`!==` test or a `case "Enter":`) must, inside that same function,
 * reference the shared guard (`isImeKeyEvent`, src/renderer/lib/ime.ts) or read
 * `isComposing` / the legacy keyCode 229 itself. A deliberate exception carries
 * `ime-ok: <reason>` in a comment inside or just above the function.
 *
 * Heuristic by design: it proves the guard is mentioned in the handler, not that
 * it runs on every path.
 */
import ts from "typescript";

const ENTER_VALUES = new Set(["Enter", "NumpadEnter"]);
const EQUALITY = new Set([
	ts.SyntaxKind.EqualsEqualsEqualsToken,
	ts.SyntaxKind.ExclamationEqualsEqualsToken,
	ts.SyntaxKind.EqualsEqualsToken,
	ts.SyntaxKind.ExclamationEqualsToken,
]);
const GUARD = /\bisImeKeyEvent\b|\bisComposing\b|\b229\b|\bime-ok\b/;

/** @param {ts.Expression} node */
function isKeyAccess(node) {
	if (ts.isPropertyAccessExpression(node)) return node.name.text === "key" || node.name.text === "code";
	if (ts.isIdentifier(node)) return node.text === "key" || node.text === "code";
	return false;
}

/** @param {ts.Expression} node */
function isEnterLiteral(node) {
	return ts.isStringLiteralLike(node) && ENTER_VALUES.has(node.text);
}

/**
 * @param {string} source
 * @param {string} [fileName]
 * @returns {{ line: number; text: string }[]}
 */
export function findImeViolations(source, fileName = "file.tsx") {
	const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
	/** @type {{ line: number; text: string }[]} */
	const found = [];
	/** @type {Set<ts.Node>} */
	const reported = new Set();

	/** @param {ts.Node} at */
	function check(at) {
		/** @type {ts.Node} */
		let scope = file;
		for (let node = at.parent; node; node = node.parent) {
			if (ts.isFunctionLike(node)) {
				scope = node;
				break;
			}
		}
		// An escape comment above `const handler = () => …` sits in the statement's trivia, not the arrow's.
		let statement = scope;
		while (statement.parent && !ts.isStatement(statement)) statement = statement.parent;
		const text = `${source.slice(statement.getFullStart(), statement.getStart(file))}${scope.getFullText(file)}`;
		if (GUARD.test(text)) return;
		if (reported.has(scope)) return;
		reported.add(scope);
		const line = file.getLineAndCharacterOfPosition(at.getStart(file)).line + 1;
		found.push({ line, text: at.getText(file).split("\n")[0] });
	}

	/** @param {ts.Node} node */
	function visit(node) {
		if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) {
			const { left, right } = node;
			if ((isKeyAccess(left) && isEnterLiteral(right)) || (isKeyAccess(right) && isEnterLiteral(left))) check(node);
		} else if (ts.isCaseClause(node) && isEnterLiteral(node.expression)) {
			const clause = node.parent.parent;
			if (ts.isSwitchStatement(clause) && isKeyAccess(clause.expression)) check(node);
		}
		ts.forEachChild(node, visit);
	}
	visit(file);
	return found;
}
