/**
 * Which Playwright specs a change touches, for `scripts/check-changed.ts`. A name match, not a
 * dependency graph: a changed spec; a spec whose file name or text names a changed source file
 * (`layout/work-board/WorkBoard.tsx` → `e2e/work-board.e2e.ts`); and a spec that drives a changed
 * component through the English text it renders (`t("themePicker.search")` → "Search themes…").
 * Specs find controls by that text far more often than by file name: v0.61.13's release failed on
 * six specs that picked a theme in the dialog a change had rebuilt, and none was named after it.
 */
import path from "node:path";

const isTest = (file: string) => /\.(?:test|spec|bench)\.[cm]?[jt]sx?$/.test(file);

/**
 * Words a source file answers to in a spec: `layout/work-board/WorkBoard.tsx` → work-board,
 * workboard; `auto-title-core.ts` → auto-title-core and auto-title.
 */
export function names(file: string): string[] {
	const stem = path.basename(file).replace(/(?:\.(?:test|spec))?\.[^.]+$/, "");
	const kebab = stem
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replace(/_/g, "-")
		.toLowerCase();
	const bare = kebab.replace(/-(?:core|engine|contracts|service|store|stock|runner|utils|types)$/, "");
	return [...new Set([kebab, bare, bare.replace(/-/g, ""), stem])].filter(
		name => name.length >= 6 && name !== "index",
	);
}

/** Shorter text ("Cancel", "Open file") is in specs that never touch the component. */
const MIN_PHRASE = 12;

/**
 * The English text a source file shows through `t("key")` with a literal key, split at its
 * `{placeholders}`: each piece of at least 12 characters with a space in it.
 */
export function phrases(source: string, strings: Readonly<Record<string, string>>): string[] {
	const out = new Set<string>();
	for (const match of source.matchAll(/\bt\(\s*"([^"]+)"/g)) {
		const text = strings[match[1] ?? ""];
		if (!text) continue;
		for (const piece of text.split(/\{[^}]*\}/)) {
			const phrase = piece.trim();
			if (phrase.length >= MIN_PHRASE && phrase.includes(" ")) out.add(phrase);
		}
	}
	return [...out];
}

export interface SpecSources {
	/** Spec file name (`work-board.e2e.ts`) → its text. */
	specs: ReadonlyMap<string, string>;
	read(file: string): string;
	/** The English UI strings (`src/renderer/locales/en.ts`). */
	strings: Readonly<Record<string, string>>;
}

export function specsFor(files: readonly string[], sources: SpecSources): string[] {
	const picked = new Set<string>();
	const changedSources: string[] = [];
	for (const file of files) {
		if (file.startsWith("e2e/") && file.endsWith(".e2e.ts")) picked.add(path.basename(file));
		else if (/^(?:src|resources)\//.test(file) && !isTest(file)) changedSources.push(file);
	}
	for (const file of changedSources) {
		const words = names(file);
		const shown = file.startsWith("src/renderer/") ? phrases(sources.read(file), sources.strings) : [];
		for (const [spec, text] of sources.specs) {
			// A plain lowercase word ("window", "changes") is in every spec's text; only a
			// hyphenated or camel-case name is distinctive enough to match the text.
			const named = words.some(name => spec.includes(name) || (/[-A-Z]/.test(name) && text.includes(name)));
			if (named || shown.some(phrase => text.includes(phrase))) picked.add(spec);
		}
	}
	return [...picked].sort().map(spec => `e2e/${spec}`);
}
