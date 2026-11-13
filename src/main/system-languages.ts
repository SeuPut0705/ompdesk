/**
 * The packaged app keeps only Electron's en-US and ko locale files (`electronLanguages` in both
 * builder configs), so Chromium's application locale falls back to en-US for every other system
 * language. A session's spellchecker on Windows (macOS always uses the system spellchecker) follows the system's own
 * languages (`app.getPreferredSystemLanguages()`) instead: Electron seeds `spellcheck.dictionaries` from the locale
 * while that list is empty (`electron_browser_context.cc`), which would now be en-US for a new German profile. (The
 * Accept-Language a Preview page receives is the shell's: `preview_core/languages.rs`.)
 */
import type { Session } from "electron";

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
