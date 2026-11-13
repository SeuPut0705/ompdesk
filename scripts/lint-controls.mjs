/**
 * Raw control lint — a renderer component uses the shared controls (src/renderer/components/common/README.md), not a
 * raw `<button>`, a raw `<input type="checkbox|radio">`, a hand-made `role="dialog"`, a hand-made `role="tab"` or
 * `role="tablist"` (Tabs, SegmentedChoice), a hand-made `role="progressbar"` (ProgressBar) or a turning lucide loader
 * (`Loader2`, `LoaderCircle`, `Loader` with `animate-spin` in its class; Spinner).
 *
 * Checked in every renderer .tsx file outside components/common (the primitives themselves) and tests. A deliberate
 * raw element says why in a comment on its line or the line above: `controls-ok: <reason>`; any other one fails.
 * `scripts/lint-surfaces.mjs` runs the check with the other surface rules; `node scripts/lint-controls.mjs` runs it
 * alone.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("../src/renderer", import.meta.url));

/** The kinds refused, each named with the shared component that replaces it. */
const KINDS = {
	button: "raw <button> (Button, IconButton, ListRow, MenuButton…)",
	checkbox: "raw checkbox (Checkbox)",
	radio: "raw radio (Radio)",
	dialog: 'hand-made role="dialog" (Modal, Sheet, Popover)',
	tab: 'hand-made role="tab"/"tablist" (Tabs, SegmentedChoice)',
	progressbar: 'hand-made role="progressbar" (ProgressBar)',
	spinner: "turning lucide loader (Spinner)",
};

const LOADER_ICONS = new Set(["Loader2", "LoaderCircle", "Loader"]);

/** @param {ts.JsxAttributes} attributes @param {string} name */
function attribute(attributes, name) {
	for (const property of attributes.properties) {
		if (ts.isJsxAttribute(property) && property.name.getText() === name) return property;
	}
	return undefined;
}

/** @param {ts.JsxAttributes} attributes @param {string} name */
function attributeText(attributes, name) {
	const property = attribute(attributes, name);
	if (!property) return undefined;
	const value = property.initializer;
	if (!value) return "";
	if (ts.isStringLiteral(value)) return value.text;
	if (ts.isJsxExpression(value) && value.expression && ts.isStringLiteralLike(value.expression))
		return value.expression.text;
	return null;
}

/**
 * @param {ts.JsxOpeningElement | ts.JsxSelfClosingElement} node
 * @param {ts.SourceFile} file
 * @returns {keyof typeof KINDS | null}
 */
function kindOf(node, file) {
	const tag = node.tagName.getText(file);
	if (tag === "button") return "button";
	if (tag === "input") {
		const type = attributeText(node.attributes, "type");
		if (type === "checkbox" || type === "radio") return type;
	}
	const role = attributeText(node.attributes, "role");
	if (role === "dialog") return "dialog";
	if (role === "tab" || role === "tablist") return "tab";
	if (role === "progressbar") return "progressbar";
	if (LOADER_ICONS.has(tag)) {
		const className = attribute(node.attributes, "className")?.initializer?.getText(file) ?? "";
		if (/\banimate-spin\b/.test(className)) return "spinner";
	}
	return null;
}

/**
 * @param {string} source
 * @param {string} [fileName]
 * @returns {{ line: number; kind: string; id: keyof typeof KINDS }[]}
 */
export function findRawControls(source, fileName = "file.tsx") {
	const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
	const lines = source.split("\n");
	/** @type {{ line: number; kind: string; id: keyof typeof KINDS }[]} */
	const found = [];
	/** @param {ts.Node} node */
	function visit(node) {
		if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
			const id = kindOf(node, file);
			if (id) {
				const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line;
				const near = `${lines[line - 1] ?? ""}\n${lines[line] ?? ""}`;
				if (!/\bcontrols-ok\b/.test(near)) found.push({ line: line + 1, kind: KINDS[id], id });
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(file);
	return found;
}

/** @param {string} rel */
export function isCounted(rel) {
	const path = rel.split(sep).join("/");
	return path.endsWith(".tsx") && !/\.test\.tsx$/.test(path) && !path.startsWith("components/common/");
}

/** @returns {string[]} */
function collect(dir) {
	const out = [];
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules") continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...collect(full));
		else if (isCounted(relative(ROOT, full))) out.push(full);
	}
	return out;
}

/**
 * One line per raw control in the renderer that carries no `controls-ok` reason. `only` (absolute paths) limits it to
 * those files: the rule reads one file at a time, so the pre-push gate (scripts/pre-push-gate.ts) checks what it changed.
 * @param {string[]} [only]
 */
export function rawControlViolations(only) {
	const violations = [];
	const files = only
		? only.filter(file => file.startsWith(ROOT + sep) && isCounted(relative(ROOT, file)) && existsSync(file))
		: collect(ROOT);
	for (const file of files) {
		const rel = relative(ROOT, file).split(sep).join("/");
		for (const hit of findRawControls(readFileSync(file, "utf8"), file))
			violations.push(`${rel}:${hit.line}  ${hit.kind}  (use the shared component, or controls-ok: <reason>)`);
	}
	return violations;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const violations = rawControlViolations();
	for (const line of violations) console.error(line);
	if (violations.length > 0) process.exit(1);
	console.log("raw controls: clean");
}
