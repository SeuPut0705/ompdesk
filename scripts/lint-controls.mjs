/**
 * Raw control lint — a renderer component uses the shared controls (src/renderer/components/common/README.md), not a
 * raw `<button>`, a raw `<input type="checkbox|radio">` or a hand-made `role="dialog"`.
 *
 * Counted in every renderer .tsx file outside components/common (the primitives themselves) and tests. A deliberate
 * raw element says why in a comment on its line or the line above: `controls-ok: <reason>`. The raw elements that
 * existed when the rule came are frozen per file in lint-controls-baseline.json: a file may hold at most its count,
 * and a file below its count fails too, so the baseline only ever goes down (`node scripts/lint-controls.mjs
 * --update` lowers it; it never raises a count or adds a file).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("../src/renderer", import.meta.url));
const BASELINE = fileURLToPath(new URL("./lint-controls-baseline.json", import.meta.url));

/** @param {ts.JsxAttributes} attributes @param {string} name */
function attributeText(attributes, name) {
	for (const property of attributes.properties) {
		if (!ts.isJsxAttribute(property) || property.name.getText() !== name) continue;
		const value = property.initializer;
		if (!value) return "";
		if (ts.isStringLiteral(value)) return value.text;
		if (ts.isJsxExpression(value) && value.expression && ts.isStringLiteralLike(value.expression))
			return value.expression.text;
		return null;
	}
	return undefined;
}

/**
 * @param {string} source
 * @param {string} [fileName]
 * @returns {{ line: number; kind: string }[]}
 */
export function findRawControls(source, fileName = "file.tsx") {
	const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
	const lines = source.split("\n");
	/** @type {{ line: number; kind: string }[]} */
	const found = [];
	/** @param {ts.Node} node */
	function visit(node) {
		if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
			const tag = node.tagName.getText(file);
			const type = attributeText(node.attributes, "type");
			const role = attributeText(node.attributes, "role");
			const kind =
				tag === "button"
					? "raw <button> (Button, IconButton, ListRow, MenuButton…)"
					: tag === "input" && (type === "checkbox" || type === "radio")
						? `raw ${type} (Checkbox, Radio)`
						: role === "dialog"
							? 'hand-made role="dialog" (Modal, Sheet, Popover)'
							: null;
			if (kind) {
				const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line;
				const near = `${lines[line - 1] ?? ""}\n${lines[line] ?? ""}`;
				if (!/\bcontrols-ok\b/.test(near)) found.push({ line: line + 1, kind });
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

/** @returns {Map<string, { line: number; kind: string }[]>} */
export function scanRenderer() {
	const hits = new Map();
	for (const file of collect(ROOT)) {
		const found = findRawControls(readFileSync(file, "utf8"), file);
		if (found.length > 0) hits.set(relative(ROOT, file).split(sep).join("/"), found);
	}
	return hits;
}

/** @returns {Record<string, number>} */
export function readBaseline() {
	return JSON.parse(readFileSync(BASELINE, "utf8"));
}

/**
 * @param {Map<string, { line: number; kind: string }[]>} hits
 * @param {Record<string, number>} baseline
 * @returns {string[]}
 */
export function compareToBaseline(hits, baseline) {
	const violations = [];
	for (const [rel, found] of hits) {
		const allowed = baseline[rel] ?? 0;
		if (found.length <= allowed) continue;
		const shown = allowed === 0 ? found : found.slice(-(found.length - allowed));
		violations.push(
			`${rel}: ${found.length} raw controls, baseline ${allowed}  (use the shared component, or controls-ok: <reason>)`,
		);
		for (const hit of shown) violations.push(`  ${rel}:${hit.line}  ${hit.kind}`);
	}
	for (const [rel, allowed] of Object.entries(baseline)) {
		const count = hits.get(rel)?.length ?? 0;
		if (count < allowed)
			violations.push(
				`${rel}: baseline ${allowed}, now ${count}  (lower it: node scripts/lint-controls.mjs --update)`,
			);
	}
	return violations;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--update")) {
	const hits = scanRenderer();
	const baseline = readBaseline();
	/** @type {Record<string, number>} */
	const next = {};
	for (const rel of Object.keys(baseline).sort()) {
		const count = Math.min(baseline[rel], hits.get(rel)?.length ?? 0);
		if (count > 0) next[rel] = count;
	}
	writeFileSync(BASELINE, `${JSON.stringify(next, null, "\t")}\n`);
	console.log(`lint-controls baseline: ${Object.keys(next).length} files`);
}
