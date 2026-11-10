/**
 * Raw control lint — a renderer component uses the shared controls (src/renderer/components/common/README.md), not a
 * raw `<button>`, a raw `<input type="checkbox|radio">`, a hand-made `role="dialog"`, a hand-made `role="tab"` or
 * `role="tablist"` (Tabs, SegmentedChoice), a hand-made `role="progressbar"` (ProgressBar) or a turning lucide loader
 * (`Loader2`, `LoaderCircle`, `Loader` with `animate-spin` in its class; Spinner).
 *
 * Counted in every renderer .tsx file outside components/common (the primitives themselves) and tests. A deliberate
 * raw element says why in a comment on its line or the line above: `controls-ok: <reason>`. The raw elements that
 * existed when the rule came are frozen per file in lint-controls-baseline.json: a file may hold at most its count,
 * and a file below its count fails too, so the baseline only ever goes down (`node scripts/lint-controls.mjs
 * --update` lowers it; it never raises a count or adds a file).
 *
 * One-time seeding of the kinds added after the baseline was made (tabs, progress bars, loaders):
 * `node scripts/lint-controls.mjs --seed-new-kinds` sets each file's count to what it may hold of the first kinds
 * (never more than its baseline) plus every site of the new ones it holds now, adding files that hold only new-kind
 * sites. Run it once, on a tree whose first-kind counts already pass; afterwards only `--update` lowers counts.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("../src/renderer", import.meta.url));
const BASELINE = fileURLToPath(new URL("./lint-controls-baseline.json", import.meta.url));

/** The kinds counted, each with the shared component that replaces it. `seeded` kinds came after the first baseline. */
const KINDS = {
	button: { label: "raw <button> (Button, IconButton, ListRow, MenuButton…)", seeded: false },
	checkbox: { label: "raw checkbox (Checkbox)", seeded: false },
	radio: { label: "raw radio (Radio)", seeded: false },
	dialog: { label: 'hand-made role="dialog" (Modal, Sheet, Popover)', seeded: false },
	tab: { label: 'hand-made role="tab"/"tablist" (Tabs, SegmentedChoice)', seeded: true },
	progressbar: { label: 'hand-made role="progressbar" (ProgressBar)', seeded: true },
	spinner: { label: "turning lucide loader (Spinner)", seeded: true },
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
				if (!/\bcontrols-ok\b/.test(near)) found.push({ line: line + 1, kind: KINDS[id].label, id });
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

/** @returns {Map<string, { line: number; kind: string; id: keyof typeof KINDS }[]>} */
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

/**
 * The baseline after the one-time seeding of the later kinds: per file, its first-kind sites up to its old count,
 * plus all of its later-kind sites.
 * @param {Map<string, { id: keyof typeof KINDS }[]>} hits
 * @param {Record<string, number>} baseline
 * @returns {Record<string, number>}
 */
export function seedNewKinds(hits, baseline) {
	/** @type {Record<string, number>} */
	const next = {};
	for (const rel of [...new Set([...Object.keys(baseline), ...hits.keys()])].sort()) {
		const found = hits.get(rel) ?? [];
		const first = found.filter(hit => !KINDS[hit.id].seeded).length;
		const later = found.length - first;
		const count = Math.min(baseline[rel] ?? 0, first) + later;
		if (count > 0) next[rel] = count;
	}
	return next;
}

/** @param {Record<string, number>} next */
function writeBaseline(next) {
	writeFileSync(BASELINE, `${JSON.stringify(next, null, "\t")}\n`);
	console.log(`lint-controls baseline: ${Object.keys(next).length} files`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	if (process.argv.includes("--update")) {
		const hits = scanRenderer();
		const baseline = readBaseline();
		/** @type {Record<string, number>} */
		const next = {};
		for (const rel of Object.keys(baseline).sort()) {
			const count = Math.min(baseline[rel], hits.get(rel)?.length ?? 0);
			if (count > 0) next[rel] = count;
		}
		writeBaseline(next);
	} else if (process.argv.includes("--seed-new-kinds")) {
		writeBaseline(seedNewKinds(scanRenderer(), readBaseline()));
	}
}
