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

export function parseCfg(text: string): CfgInfo {
	const info: CfgInfo = { invariants: [], properties: [], checkDeadlock: true, constants: {} };
	let section = "";
	for (const raw of stripComments(text).split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		const tokens = line.split(/\s+/);
		let names = tokens;
		if (isKeyword(tokens[0])) {
			section = tokens[0] as string;
			names = tokens.slice(1);
		}
		if (section === "INVARIANT" || section === "INVARIANTS") info.invariants.push(...names);
		else if (section === "PROPERTY" || section === "PROPERTIES") info.properties.push(...names);
		else if (section === "CHECK_DEADLOCK") info.checkDeadlock = !/^FALSE$/i.test(names[0] ?? "");
		else if (section === "CONSTANT" || section === "CONSTANTS") {
			const assign = /^([A-Za-z_]\w*)\s*(?:=|<-)\s*(.*)$/.exec(names.join(" "));
			if (assign) info.constants[assign[1] as string] = (assign[2] as string).trim();
		}
	}
	return info;
}

/**
 * Returns the config with these constants set to the given TLC values (`{w1, w2}`, `3`, `"x"`): their old
 * assignments (one `Name = value` per line, continuation lines included) are removed, then a new CONSTANTS block
 * is appended. A name the config does not mention is simply added. Comments are dropped.
 */
export function overrideConstants(text: string, overrides: Record<string, string>): string {
	if (Object.keys(overrides).length === 0) return text;
	const out: string[] = [];
	let section = "";
	let skipping = false;
	for (const raw of stripComments(text).split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		const [first = "", ...rest] = line.split(/\s+/);
		let body = line;
		let header = "";
		if (isKeyword(first)) {
			section = first;
			skipping = false;
			header = first;
			body = rest.join(" ");
		}
		const assign = section === "CONSTANT" || section === "CONSTANTS" ? /^([A-Za-z_]\w*)\s*(?:=|<-)/.exec(body) : null;
		if (assign) skipping = Object.hasOwn(overrides, assign[1] as string);
		if (skipping && (assign || !header)) body = "";
		if (header) out.push(body ? `${header} ${body}` : header);
		else if (body) out.push(`    ${body}`);
	}
	const block = ["CONSTANTS", ...Object.entries(overrides).map(([name, value]) => `    ${name} = ${value}`)];
	return `${[...out, ...block].join("\n")}\n`;
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
