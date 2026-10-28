import fs from "node:fs";
import path from "node:path";
import { isRecord } from "./json";

/** One `@code path:line[-line] note` comment: ties a model step to the code it stands for. */
export interface CodeTag {
	path: string;
	startLine?: number;
	endLine?: number;
	note?: string;
	/** 1-based line of the tag comment in the model file. */
	line: number;
}

const TAG = /(?:\\\*|--|\(\*|\/-|\/\/|#)[-*\s]*@code\s+(.*?)\s*(?:\*\)|-\/)?\s*$/;
const TARGET = /^(\S+?)(?::(\d+)(?:-(\d+))?)?(?:\s+(.*))?$/;

/** The tag on one line of a model file (TLA+ `\* @code`, `(* @code *)`, Lean `-- @code` / `/-- @code -/`), if any. */
export function parseTagLine(text: string, line: number): CodeTag | null {
	const match = TAG.exec(text);
	if (!match) return null;
	const target = TARGET.exec((match[1] as string).trim());
	if (!target) return null;
	const start = target[2] === undefined ? undefined : Number(target[2]);
	const end = target[3] === undefined ? undefined : Number(target[3]);
	return {
		path: target[1] as string,
		...(start === undefined ? {} : { startLine: start }),
		...(end === undefined ? {} : { endLine: end }),
		...(target[4] ? { note: target[4] } : {}),
		line,
	};
}

export function extractTags(source: string): CodeTag[] {
	const tags: CodeTag[] = [];
	source.split(/\r?\n/).forEach((text, index) => {
		const tag = parseTagLine(text, index + 1);
		if (tag) tags.push(tag);
	});
	return tags;
}

export function formatTag(tag: CodeTag): string {
	const range =
		tag.startLine === undefined
			? ""
			: tag.endLine === undefined
				? `:${tag.startLine}`
				: `:${tag.startLine}-${tag.endLine}`;
	return `${tag.path}${range}`;
}

export interface DefinitionTags {
	name: string;
	line: number;
	/** Tags directly above the definition or inside its body. */
	tags: CodeTag[];
	/** Names of other top-level definitions the body mentions (comments stripped): the callees. */
	calls?: string[];
}

const DEFINITION = /^([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s*==/;
const COMMENT_LINE = /^\s*(?:\\\*|\(\*)/;

/** Top-level TLA+ definitions with the `@code` tags above or inside each. */
export function indexDefinitions(source: string): DefinitionTags[] {
	const lines = source.split(/\r?\n/);
	const defs: DefinitionTags[] = [];
	/** 1-based first line of the comment block directly above each definition (the definition's own line when none). */
	const blockStart: number[] = [];
	lines.forEach((text, index) => {
		const match = DEFINITION.exec(text);
		if (!match) return;
		const tags: CodeTag[] = [];
		let first = index;
		for (let above = index - 1; above >= 0 && COMMENT_LINE.test(lines[above] as string); above--) {
			first = above;
			const tag = parseTagLine(lines[above] as string, above + 1);
			if (tag) tags.unshift(tag);
		}
		defs.push({ name: match[1] as string, line: index + 1, tags });
		blockStart.push(first + 1);
	});
	defs.forEach((def, i) => {
		const end = i + 1 < defs.length ? (blockStart[i + 1] as number) - 1 : lines.length;
		const body: string[] = [];
		for (let at = def.line; at <= end; at++) {
			const tag = parseTagLine(lines[at - 1] as string, at);
			if (tag && !def.tags.some(known => known.line === tag.line)) def.tags.push(tag);
			body.push((lines[at - 1] as string).replace(/\\\*.*$/, "").replace(/\(\*.*?\*\)/g, " "));
		}
		const names = new Set(defs.map(other => other.name));
		const words = new Set(
			body
				.join("\n")
				.replace(DEFINITION, " ")
				.match(/[A-Za-z_]\w*/g) ?? [],
		);
		def.calls = [...words].filter(word => word !== def.name && names.has(word));
	});
	return defs;
}

/**
 * Tags for the definition named `name`, else for the one that starts at or encloses `line`, else (the action is a
 * wrapper such as `ResumeStep == \\E p \\in Pairs : Step(p)` that TLC names instead of `Step`) the tags of the tagged
 * definitions it calls, nearest first, at most three calls deep. A wrapper that calls several tagged actions yields
 * all of their tags: tag the wrapper itself to be exact.
 */
export function tagsFor(defs: DefinitionTags[], name: string | undefined, line: number | undefined): CodeTag[] {
	const named = name ? defs.find(def => def.name === name) : undefined;
	if (named?.tags.length) return named.tags;
	let enclosing: DefinitionTags | undefined;
	if (line !== undefined) {
		for (const def of defs) if (def.line <= line) enclosing = def;
		if (enclosing?.tags.length) return enclosing.tags;
	}
	const start = named ?? enclosing;
	if (!start) return [];
	const seen = new Set<string>([start.name]);
	let frontier = [start];
	for (let depth = 0; depth < 3 && frontier.length > 0; depth++) {
		const next: DefinitionTags[] = [];
		for (const def of frontier) {
			for (const callee of def.calls ?? []) {
				if (seen.has(callee)) continue;
				seen.add(callee);
				const found = defs.find(candidate => candidate.name === callee);
				if (found) next.push(found);
			}
		}
		const tags = next.flatMap(def => def.tags);
		if (tags.length > 0) return tags;
		frontier = next;
	}
	return [];
}

function manifestCodeRoot(dir: string): string | null {
	const file = path.join(dir, "manifest.json");
	try {
		const json: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (isRecord(json) && json.version === 1 && Array.isArray(json.models)) {
			return path.resolve(dir, typeof json.codeRoot === "string" ? json.codeRoot : "..");
		}
	} catch {
		// no manifest here
	}
	return null;
}

/**
 * The code root around `start`: the `codeRoot` of the nearest `manifest.json` (a formal/ folder), else the
 * nearest ancestor with `.git`, else `start`.
 */
export function findCodeRoot(start: string): string {
	let dir = path.resolve(start);
	for (;;) {
		const fromManifest = manifestCodeRoot(dir);
		if (fromManifest) return fromManifest;
		if (fs.existsSync(path.join(dir, ".git"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return path.resolve(start);
		dir = parent;
	}
}

export interface TagProblem {
	tag: CodeTag;
	file: string;
	problem: string;
}

/** Tags whose file is missing, outside the code root, or whose line range runs past the end of the file. */
export function checkTags(tags: CodeTag[], file: string, codeRoot: string): TagProblem[] {
	const problems: TagProblem[] = [];
	const lineCounts = new Map<string, number | null>();
	const root = path.resolve(codeRoot);
	for (const tag of tags) {
		const target = path.resolve(root, tag.path);
		const inside = path.relative(root, target);
		if (inside.startsWith("..") || path.isAbsolute(inside)) {
			problems.push({ tag, file, problem: `${tag.path} is outside the code root ${root}` });
			continue;
		}
		if (!lineCounts.has(target)) {
			try {
				lineCounts.set(
					target,
					fs
						.readFileSync(target, "utf8")
						.replace(/\r?\n$/, "")
						.split(/\r?\n/).length,
				);
			} catch {
				lineCounts.set(target, null);
			}
		}
		const count = lineCounts.get(target);
		if (count === null || count === undefined) {
			problems.push({ tag, file, problem: `${tag.path} does not exist under ${root}` });
			continue;
		}
		const last = tag.endLine ?? tag.startLine;
		if (
			tag.startLine !== undefined &&
			(tag.startLine < 1 || (tag.endLine !== undefined && tag.endLine < tag.startLine))
		) {
			problems.push({ tag, file, problem: `${formatTag(tag)} is not a valid line range` });
		} else if (last !== undefined && last > count) {
			problems.push({ tag, file, problem: `${formatTag(tag)} runs past the end of the file (${count} lines)` });
		}
	}
	return problems;
}
