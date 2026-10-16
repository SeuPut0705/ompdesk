/**
 * The packaged app keeps only Electron's en-US and ko locale files (`electronLanguages` in both
 * builder configs), so Chromium's application locale falls back to en-US for every other system
 * language. Two things Electron derives from that locale follow the system's own languages
 * (`app.getPreferredSystemLanguages()`) instead:
 * - a session's spellchecker on Windows (macOS always uses the system spellchecker): Electron seeds
 *   `spellcheck.dictionaries` from the locale while that list is empty (`electron_browser_context.cc`),
 *   which would now be en-US for a new German profile;
 * - the Accept-Language a Preview page receives (`Session.setUserAgent`).
 */
import type { Session } from "electron";

/**
 * The Accept-Language list for `preferred`: each tag followed by its bare language when that is
 * not listed yet, then English, the way Chromium's own per-locale defaults read (`de-DE,de,en-US,en`).
 * Empty without a system language, which leaves Chromium's default in place.
 */
export function acceptLanguages(preferred: readonly string[]): string {
	const list: string[] = [];
	const add = (tag: string) => {
		if (tag && !list.some(entry => entry.toLowerCase() === tag.toLowerCase())) list.push(tag);
	};
	for (const raw of preferred) {
		const tag = raw.trim().replaceAll("_", "-");
		add(tag);
		add(tag.split("-")[0] ?? "");
	}
	if (list.length === 0) return "";
	add("en-US");
	add("en");
	return list.join(",");
}

/**
 * The spellchecker language Electron seeded from a full locale set: the one matching the first
 * system language (exact tag, then the bare language, then its first regional variant), or none
 * when no dictionary covers it (Chromium's `GetCorrespondingSpellCheckLanguage`).
 */
export function spellcheckerLanguage(preferred: readonly string[], available: readonly string[]): string | undefined {
	const tag = preferred[0]?.trim().replaceAll("_", "-").toLowerCase();
	if (!tag) return undefined;
	const base = tag.split("-")[0];
	return (
		available.find(code => code.toLowerCase() === tag) ??
		available.find(code => code.toLowerCase() === base) ??
		available.find(code => code.toLowerCase().startsWith(`${base}-`))
	);
}

/**
 * On Windows, re-seed a session's spellchecker from the system language where the trimmed locale
 * set left it on en-US (or on nothing). A list seeded before the trim, or one that already
 * matches, stays as it is; OMPdesk has no setting of its own for it.
 */
export function seedSpellchecker(ses: Session, preferred: readonly string[], platform: NodeJS.Platform): void {
	if (platform !== "win32") return;
	const wanted = spellcheckerLanguage(preferred, ses.availableSpellCheckerLanguages);
	if (!wanted) return;
	const current = ses.getSpellCheckerLanguages();
	if (current.length === 0 || (current.length === 1 && current[0] === "en-US" && wanted !== "en-US")) {
		ses.setSpellCheckerLanguages([wanted]);
	}
}

/** Send the system languages as the Accept-Language of every request `ses` makes; its user agent stays. */
export function applyAcceptLanguages(ses: Session, preferred: readonly string[]): void {
	const languages = acceptLanguages(preferred);
	if (languages) ses.setUserAgent(ses.getUserAgent(), languages);
}
