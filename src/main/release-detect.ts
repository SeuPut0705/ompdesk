/**
 * Autopilot's release procedure detection: a repository "defines" a release procedure when one of its
 * rules files has a section about it. Autopilot's auto release and the screen's Release button only
 * exist then, and the agent is told the file and the headings to follow literally
 * (`AutopilotBeginResult.ship.releaseProcedure`). Pure parsing plus a few file reads; never writes.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AutopilotReleaseProcedure } from "../../resources/gui-bridge/modes/autopilot-contracts";

/** What makes a heading, or the prose of the section before it, a release one (English, Korean). */
const RELEASE_WORDS = /release|releasing|릴리스|릴리즈|배포|publish/i;
/** Rules files in priority order; the first that has a procedure wins. */
const RULES_FILES = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"];
/** Files that are a procedure as a whole. */
const WHOLE_FILES = ["RELEASING.md"];
const MAX_FILE_BYTES = 512 * 1024;

interface Section {
	title: string;
	level: number;
	body: string;
}

/** ATX headings outside code fences, with the text up to the next heading of the same or a higher level. */
function sections(text: string): Section[] {
	const lines = text.split(/\r?\n/);
	const heads: Array<{ title: string; level: number; at: number }> = [];
	let fence: string | null = null;
	lines.forEach((line, at) => {
		const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (mark) {
			if (fence === null) fence = mark[0] ?? "`";
			else if (mark[0] === fence) fence = null;
			return;
		}
		if (fence !== null) return;
		const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
		if (heading?.[1] && heading[2]) heads.push({ title: heading[2].trim(), level: heading[1].length, at });
	});
	return heads.map((head, index) => {
		const end = heads.slice(index + 1).find(next => next.level <= head.level)?.at ?? lines.length;
		return { title: head.title, level: head.level, body: lines.slice(head.at + 1, end).join("\n") };
	});
}

/**
 * The headings of a rules file that make up its release procedure: every heading that names a release,
 * and the section of the same level right before such a heading when its own text talks about releasing
 * (this repository's "Change workflow" leads into its "Release" section that way). File order.
 */
export function findReleaseAnchors(text: string): string[] {
	const all = sections(text);
	const anchored = new Set<number>();
	all.forEach((section, index) => {
		if (!RELEASE_WORDS.test(section.title)) return;
		anchored.add(index);
		// The nearest earlier section of the same level, unless a higher heading is in between.
		for (let before = index - 1; before >= 0; before--) {
			const previous = all[before];
			if (!previous || previous.level < section.level) break;
			if (previous.level !== section.level) continue;
			if (!RELEASE_WORDS.test(previous.title) && RELEASE_WORDS.test(previous.body)) anchored.add(before);
			break;
		}
	});
	return [...anchored].sort((a, b) => a - b).map(index => all[index]?.title ?? "");
}

async function readText(file: string): Promise<string | null> {
	try {
		const text = await readFile(file, "utf8");
		return text.length > MAX_FILE_BYTES ? text.slice(0, MAX_FILE_BYTES) : text;
	} catch {
		return null;
	}
}

/** `RELEASING.md` and `docs/release*.md`: the file is the procedure. */
async function wholeFiles(root: string): Promise<string[]> {
	const names = [...WHOLE_FILES];
	try {
		const docs = (await readdir(join(root, "docs")))
			.filter(name => /^release[^/]*\.(md|markdown)$/i.test(name))
			.sort();
		names.push(...docs.map(name => `docs/${name}`));
	} catch {
		// No docs folder.
	}
	return names;
}

/** The repository's release procedure, or null when no rules file defines one. */
export async function detectReleaseProcedure(root: string): Promise<AutopilotReleaseProcedure | null> {
	for (const file of RULES_FILES) {
		const text = await readText(join(root, file));
		if (text === null) continue;
		const anchors = findReleaseAnchors(text);
		if (anchors.length > 0) return { file, anchors };
	}
	for (const file of await wholeFiles(root)) {
		const text = await readText(join(root, file));
		if (text === null) continue;
		const base = file.split("/").pop() ?? file;
		return { file, anchors: [sections(text)[0]?.title ?? base.replace(/\.[^.]+$/, "")] };
	}
	return null;
}
