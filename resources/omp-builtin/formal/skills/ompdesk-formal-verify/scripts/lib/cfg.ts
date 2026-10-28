export interface CfgInfo {
	invariants: string[];
	properties: string[];
	/** `CHECK_DEADLOCK FALSE` turns TLC's deadlock check off. */
	checkDeadlock: boolean;
	constants: Record<string, string>;
}

const KEYWORDS: Record<string, true> = {
	SPECIFICATION: true,
	INIT: true,
	NEXT: true,
	CONSTANT: true,
	CONSTANTS: true,
	INVARIANT: true,
	INVARIANTS: true,
	PROPERTY: true,
	PROPERTIES: true,
	SYMMETRY: true,
	CONSTRAINT: true,
	CONSTRAINTS: true,
	ACTION_CONSTRAINT: true,
	ACTION_CONSTRAINTS: true,
	VIEW: true,
	ALIAS: true,
	POSTCONDITION: true,
	CHECK_DEADLOCK: true,
	TERMINAL: true,
};

function isKeyword(token: string | undefined): boolean {
	return token !== undefined && Object.hasOwn(KEYWORDS, token);
}

/** Drops `\* line` comments and `(* block *)` comments (a config may carry both). */
function stripComments(text: string): string {
	return text.replace(/\(\*[\s\S]*?\*\)/g, " ").replace(/\\\*.*$/gm, "");
}

interface Block {
	/** The section keyword, `""` for text before the first one. */
	keyword: string;
	/** What follows the keyword on its own line. */
	first: string;
	/** The following lines, up to the next keyword. */
	more: string[];
}

function blocks(text: string): Block[] {
	const out: Block[] = [];
	let current: Block | undefined;
	for (const raw of stripComments(text).split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		const [head = "", ...rest] = line.split(/\s+/);
		if (isKeyword(head)) {
			current = { keyword: head, first: rest.join(" "), more: [] };
			out.push(current);
		} else if (current) {
			current.more.push(line);
		} else {
			current = { keyword: "", first: line, more: [] };
			out.push(current);
		}
	}
	return out;
}

function bodyOf(block: Block): string {
	return [block.first, ...block.more].filter(Boolean).join(" ");
}

interface Assignment {
	name: string;
	op: "=" | "<-";
	value: string;
}

/**
 * Splits the body of a CONSTANTS section at every `Name =` or `Name <-` that is not inside a set, tuple, record,
 * parentheses or string: `N = 3 M = 4` is two assignments, `S = {a, b}` one. Text before the first assignment is dropped.
 */
function assignments(body: string): Assignment[] {
	const starts: { at: number; name: string; op: "=" | "<-"; valueAt: number }[] = [];
	let depth = 0;
	let i = 0;
	while (i < body.length) {
		const ch = body[i] as string;
		if (ch === '"') {
			i++;
			while (i < body.length && body[i] !== '"') i += body[i] === "\\" ? 2 : 1;
			i++;
		} else if (/[{([]/.test(ch) || body.startsWith("<<", i)) {
			depth++;
			i += body.startsWith("<<", i) ? 2 : 1;
		} else if (/[})\]]/.test(ch) || body.startsWith(">>", i)) {
			depth = Math.max(0, depth - 1);
			i += body.startsWith(">>", i) ? 2 : 1;
		} else if (/[A-Za-z_]/.test(ch)) {
			const word = /\w+/y;
			word.lastIndex = i;
			const name = (word.exec(body) as RegExpExecArray)[0];
			const after = /\s*(=(?!=)|<-)/y;
			after.lastIndex = i + name.length;
			const op = depth === 0 ? after.exec(body) : null;
			if (op) starts.push({ at: i, name, op: op[1] as "=" | "<-", valueAt: after.lastIndex });
			i += name.length;
		} else if (/\d/.test(ch)) {
			i += (/\w+/y.exec(body.slice(i)) as RegExpExecArray)[0].length;
		} else {
			i++;
		}
	}
	return starts.map((start, index) => ({
		name: start.name,
		op: start.op,
		value: body.slice(start.valueAt, starts[index + 1]?.at ?? body.length).trim(),
	}));
}

export function parseCfg(text: string): CfgInfo {
	const info: CfgInfo = { invariants: [], properties: [], checkDeadlock: true, constants: {} };
	for (const block of blocks(text)) {
		const body = bodyOf(block);
		const names = body ? body.split(/\s+/) : [];
		if (block.keyword === "INVARIANT" || block.keyword === "INVARIANTS") info.invariants.push(...names);
		else if (block.keyword === "PROPERTY" || block.keyword === "PROPERTIES") info.properties.push(...names);
		else if (block.keyword === "CHECK_DEADLOCK") info.checkDeadlock = !/^FALSE$/i.test(names[0] ?? "");
		else if (block.keyword === "CONSTANT" || block.keyword === "CONSTANTS") {
			for (const assignment of assignments(body)) info.constants[assignment.name] = assignment.value;
		}
	}
	return info;
}

/**
 * Returns the config with these constants set to the given TLC values (`{w1, w2}`, `3`, `"x"`): their old
 * assignments (one or several per line, continuation lines included) are removed, the others stay one per line, then
 * a new CONSTANTS block is appended. A name the config does not mention is simply added. Comments are dropped.
 */
export function overrideConstants(text: string, overrides: Record<string, string>): string {
	if (Object.keys(overrides).length === 0) return text;
	const out: string[] = [];
	for (const block of blocks(text)) {
		if (block.keyword === "CONSTANT" || block.keyword === "CONSTANTS") {
			const kept = assignments(bodyOf(block)).filter(assignment => !Object.hasOwn(overrides, assignment.name));
			if (kept.length > 0) out.push(block.keyword, ...kept.map(a => `    ${a.name} ${a.op} ${a.value}`));
			continue;
		}
		if (block.keyword) out.push(block.first ? `${block.keyword} ${block.first}` : block.keyword);
		else if (block.first) out.push(block.first);
		for (const line of block.more) out.push(`    ${line}`);
	}
	const added = ["CONSTANTS", ...Object.entries(overrides).map(([name, value]) => `    ${name} = ${value}`)];
	return `${[...out, ...added].join("\n")}\n`;
}

/**
 * The config with only the named INVARIANT and PROPERTY entries kept (a section that ends up empty is dropped), so a
 * mutation run fails on the property it targets and nothing else. Comments are dropped.
 */
export function isolateProperties(text: string, keep: string[]): string {
	const out: string[] = [];
	let section = "";
	let opened = false;
	for (const raw of stripComments(text).split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		const tokens = line.split(/\s+/);
		let names = tokens;
		const isHeader = isKeyword(tokens[0]);
		if (isHeader) {
			section = tokens[0] as string;
			opened = false;
			names = tokens.slice(1);
		}
		if (section === "INVARIANT" || section === "INVARIANTS" || section === "PROPERTY" || section === "PROPERTIES") {
			const kept = names.filter(name => keep.includes(name));
			if (kept.length === 0) continue;
			out.push(opened ? `    ${kept.join(" ")}` : `${section} ${kept.join(" ")}`);
			opened = true;
			continue;
		}
		out.push(isHeader ? line : `    ${line}`);
	}
	return `${out.join("\n")}\n`;
}
