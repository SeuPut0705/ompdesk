/**
 * Duplicate-rule lint — one rule, one home. Main, the renderer, src/shared and the bridge each keep their own
 * copy of a rule only by mistake: the copies drift, a fix lands in one and the other side re-fixes it later (the
 * worktree folder pattern `gui-<name>-<hash7>` was spelled in main's sidebar projects and again in
 * src/shared/project-origin.ts until 05ca85282 merged them; the same pass found the host and its devices on two copies).
 *
 * Narrow on purpose (a general clone detector over these trees mostly finds URL, drive-letter and escape regexes):
 *  - a regular expression bound to a top-level `const` in one side's file whose pattern also appears, literally, in a
 *    file of another side. Patterns are compared after dropping flags `g`/`y`/`d` and group decoration that changes no
 *    match (`(?:…)`, `(?<name>…)`, unquantified groups without `|`); shorter than 10 characters is no rule.
 *  - an exported constant (string, number or regex literal) whose name and value are both exported by another side.
 *
 * Sides: src/main, src/renderer, src/shared, resources/gui-bridge; tests, benches, fixtures and test rigs are out.
 * Known duplicates stay in `lint-duplicate-rules-allow.json`, each with its reason; an entry that no longer
 * matches fails too, so the list only shrinks. The fix for a new one is to import the one copy: src/ may import from
 * resources/gui-bridge (contracts) and src/shared; the bridge imports neither.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const SIDES = /** @type {const} */ ({
	main: "src/main",
	renderer: "src/renderer",
	shared: "src/shared",
	bridge: "resources/gui-bridge",
});
const SOURCE = /\.tsx?$/;
const NOT_PRODUCT = /\.(?:test|e2e|spec|bench)\.tsx?$|(?:^|[/-])test-|-test-rig\.ts$|-fixture\.ts$|\.d\.ts$/;
const MIN_PATTERN = 10;

/** @param {string} file repo-relative, `/`-separated */
export function sideOf(file) {
	for (const [side, dir] of Object.entries(SIDES)) if (file.startsWith(`${dir}/`)) return side;
	return null;
}

/**
 * A regex literal's text in a spelling that ignores what changes no match: `g`/`y`/`d` flags, `(?:`/`(?<name>`
 * openers and groups that are neither quantified nor hold an alternation. A pattern with a backreference keeps its
 * groups (their numbering is part of it).
 * @param {string} literal e.g. `/^gui-(.+)-([0-9a-f]{7})$/g`
 */
export function normalizeRegex(literal) {
	const end = literal.lastIndexOf("/");
	const body = literal.slice(1, end);
	const flags = [...literal.slice(end + 1).replace(/[gyd]/g, "")].sort().join("");
	if (/\\[1-9]|\\k</.test(body)) return `/${body}/${flags}`;
	let i = 0;
	/** @returns {{ text: string; alt: boolean }} */
	const sequence = () => {
		let text = "";
		let alt = false;
		while (i < body.length && body[i] !== ")") {
			const c = body[i];
			if (c === "\\") {
				text += body.slice(i, i + 2);
				i += 2;
			} else if (c === "[") {
				let j = i + 1;
				while (j < body.length && body[j] !== "]") j += body[j] === "\\" ? 2 : 1;
				text += body.slice(i, j + 1);
				i = j + 1;
			} else if (c === "(") {
				const look = /^\(\?(?:=|!|<=|<!)/.exec(body.slice(i))?.[0];
				const opener = look ?? /^\(\?(?::|<[A-Za-z_$][\w$]*>)/.exec(body.slice(i))?.[0] ?? "(";
				i += opener.length;
				const inner = sequence();
				i++; // ")"
				const quantified = /[*+?{]/.test(body[i] ?? "");
				if (look) text += `${look}${inner.text})`;
				else if (quantified || inner.alt) text += `(${inner.text})`;
				else text += inner.text;
			} else {
				if (c === "|") alt = true;
				text += c;
				i++;
			}
		}
		return { text, alt };
	};
	return `/${sequence().text}/${flags}`;
}

/**
 * @typedef {{ file: string; source: string }} SourceFile
 * @typedef {{ rule: string; kind: "regex" | "constant"; files: string[] }} Duplicate
 * @param {SourceFile[]} files repo-relative paths with their text
 * @returns {Duplicate[]}
 */
export function findDuplicateRules(files) {
	/** @type {Map<string, { file: string; named: boolean }[]>} */
	const regexes = new Map();
	/** @type {Map<string, string[]>} name + value → files */
	const constants = new Map();
	for (const { file, source } of files) {
		const tree = ts.createSourceFile(
			file,
			source,
			ts.ScriptTarget.Latest,
			true,
			file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
		);
		/** @type {Set<ts.Node>} */
		const named = new Set();
		for (const statement of tree.statements) {
			if (!ts.isVariableStatement(statement)) continue;
			const exported = statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
			for (const declaration of statement.declarationList.declarations) {
				let value = declaration.initializer;
				while (value && (ts.isAsExpression(value) || ts.isSatisfiesExpression(value))) value = value.expression;
				if (!value || !ts.isIdentifier(declaration.name)) continue;
				if (value.kind === ts.SyntaxKind.RegularExpressionLiteral) named.add(value);
				if (!exported) continue;
				const literal =
					ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)
						? JSON.stringify(value.text)
						: ts.isNumericLiteral(value)
							? value.text
							: value.kind === ts.SyntaxKind.RegularExpressionLiteral
								? normalizeRegex(value.getText(tree))
								: null;
				if (literal === null) continue;
				const key = `${declaration.name.text} = ${literal}`;
				constants.set(key, [...(constants.get(key) ?? []), file]);
			}
		}
		/** @param {ts.Node} node */
		const visit = node => {
			if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
				const key = normalizeRegex(node.getText(tree));
				if (key.lastIndexOf("/") - 1 >= MIN_PATTERN)
					regexes.set(key, [...(regexes.get(key) ?? []), { file, named: named.has(node) }]);
			}
			ts.forEachChild(node, visit);
		};
		visit(tree);
	}
	const sides = (/** @type {string[]} */ list) => new Set(list.map(sideOf)).size;
	/** @type {Duplicate[]} */
	const found = [];
	for (const [rule, uses] of regexes) {
		const list = [...new Set(uses.map(use => use.file))];
		if (uses.some(use => use.named) && sides(list) > 1) found.push({ rule, kind: "regex", files: list });
	}
	for (const [rule, list] of constants) {
		if (sides(list) > 1) found.push({ rule, kind: "constant", files: [...new Set(list)] });
	}
	return found.sort((a, b) => a.rule.localeCompare(b.rule));
}

/** @param {string} dir absolute */
function collect(dir) {
	/** @type {string[]} */
	const out = [];
	for (const name of readdirSync(dir)) {
		if (name === "node_modules") continue;
		const full = join(dir, name);
		if (statSync(full).isDirectory()) out.push(...collect(full));
		else if (SOURCE.test(name)) out.push(full);
	}
	return out;
}

/** Every product source file of the four sides. @returns {SourceFile[]} */
export function readSides(root = ROOT) {
	return Object.values(SIDES)
		.flatMap(dir => collect(join(root, dir)))
		.map(full => relative(root, full).split("\\").join("/"))
		.filter(file => !NOT_PRODUCT.test(file))
		.map(file => ({ file, source: readFileSync(join(root, file), "utf8") }));
}

/** @typedef {{ rule: string; files: string[]; reason: string }} AllowEntry */

/** @returns {AllowEntry[]} */
export function readAllowList(root = ROOT) {
	return JSON.parse(readFileSync(join(root, "scripts/lint-duplicate-rules-allow.json"), "utf8"));
}

/**
 * Lint lines: every duplicate the allow-list does not name, or names with fewer files (a known rule copied into one
 * more file is a new copy), and every entry that matches nothing, has gone down to fewer files or gives no reason.
 * @param {Duplicate[]} found
 * @param {AllowEntry[]} allow
 * @returns {string[]}
 */
export function compareToAllowList(found, allow) {
	const allowed = new Map(allow.map(entry => [entry.rule, new Set(entry.files)]));
	const seen = new Map(found.map(duplicate => [duplicate.rule, new Set(duplicate.files)]));
	const LIST = "scripts/lint-duplicate-rules-allow.json";
	return [
		...found.flatMap(duplicate => {
			const files = allowed.get(duplicate.rule);
			const extra = files ? duplicate.files.filter(file => !files.has(file)) : duplicate.files;
			return extra.length === 0
				? []
				: [
						`duplicate rule ${duplicate.rule} in ${extra.join(", ")}${files ? " (beyond the allow-list's copies)" : ""}: import one copy (scripts/lint-duplicate-rules.mjs)`,
					];
		}),
		...allow.flatMap(entry => {
			const files = seen.get(entry.rule);
			if (!files) return [`${LIST}: ${entry.rule} no longer duplicated, remove the entry`];
			const gone = entry.files.filter(file => !files.has(file));
			return gone.length > 0
				? [`${LIST}: ${entry.rule} no longer in ${gone.join(", ")}, drop them from the entry`]
				: [];
		}),
		...allow.filter(entry => !entry.reason?.trim()).map(entry => `${LIST}: ${entry.rule} needs a reason`),
	];
}
