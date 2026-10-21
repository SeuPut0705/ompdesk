/**
 * Autopilot's release procedure detection: a repository "defines" a release procedure when one of its
 * rules files has a section about it, or, when none does, its Autopilot guide (AUTOPILOT.md, which Start writes from the
 * project's facts) has a Release section that does not say `Releases: no`. Autopilot's auto release and the screen's
 * Release button only exist then, and the agent is told the file and the headings to follow literally
 * (`AutopilotBeginResult.ship.releaseProcedure`). Pure parsing plus a few file reads; never writes.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	AUTOPILOT_GUIDE_FILE,
	type AutopilotReleaseProcedure,
} from "../../resources/gui-bridge/modes/autopilot-contracts";
import { guideRelease, markdownSections } from "../../resources/gui-bridge/modes/autopilot-release-core";

/** What makes a heading, or the prose of the section before it, a release one (English, Korean). */
const RELEASE_WORDS = /release|releasing|릴리스|릴리즈|배포|publish/i;
/** Rules files in priority order; the first that has a procedure wins. */
const RULES_FILES = ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md"];
/** Files that are a procedure as a whole. */
const WHOLE_FILES = ["RELEASING.md"];
/** A rules file is read whole up to this size (this repository's own AGENTS.md passed 512 KB, cutting off its Release
 *  section at the end). */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * The headings of a rules file that make up its release procedure: every heading that names a release,
 * and the section of the same level right before such a heading when its own text talks about releasing
 * (this repository's "Change workflow" leads into its "Release" section that way). File order.
 */
export function findReleaseAnchors(text: string): string[] {
	const all = markdownSections(text);
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
		return { file, anchors: [markdownSections(text)[0]?.title ?? base.replace(/\.[^.]+$/, "")] };
	}
	const guide = await readText(join(root, AUTOPILOT_GUIDE_FILE));
	const release = guide === null ? null : guideRelease(guide);
	return release?.releases ? { file: AUTOPILOT_GUIDE_FILE, anchors: [release.title] } : null;
}
