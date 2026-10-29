/**
 * Prompt-section lint — a bridge module adds to the system prompt only through `registerPromptSection`.
 *
 * A `before_agent_start` handler that returns its own `systemPrompt` reaches a prompt only: a turn stock's restore
 * continues and the context inspector build the prompt from the registered sections (resources/gui-bridge/
 * prompt-sections.ts `withTurnSections`), so such a handler's text is missing from every revived subagent's and
 * restored turn's first request, as all of OMPdesk's sections were on 27 Oct 2026. A deliberate exception carries
 * `prompt-section-ok: <reason>` in a comment on the `on(` line.
 */
import ts from "typescript";

/**
 * @param {string} source
 * @param {string} [fileName]
 * @returns {{ line: number; text: string }[]}
 */
export function findPromptHookViolations(source, fileName = "file.ts") {
	const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const lines = source.split("\n");
	/** @type {{ line: number; text: string }[]} */
	const found = [];
	/** @param {ts.Node} node */
	function visit(node) {
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			node.expression.name.text === "on" &&
			ts.isStringLiteralLike(node.arguments[0]) &&
			node.arguments[0].text === "before_agent_start" &&
			node.arguments[1] !== undefined &&
			setsSystemPrompt(node.arguments[1])
		) {
			const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
			if (!/\bprompt-section-ok\b/.test(lines[line - 1] ?? ""))
				found.push({ line, text: node.getText(file).split("\n")[0] });
		}
		ts.forEachChild(node, visit);
	}
	visit(file);
	return found;
}

/** @param {ts.Node} node */
function setsSystemPrompt(node) {
	if (
		(ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
		ts.isIdentifier(node.name) &&
		node.name.text === "systemPrompt"
	)
		return true;
	return ts.forEachChild(node, setsSystemPrompt) === true;
}
