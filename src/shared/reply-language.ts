/**
 * The agent's reply language. By default it follows the device language (not
 * the UI language: the UI ships only en/ko, the device may be Japanese, German, …);
 * Settings › General can pin one or turn it off (prefs `replyLanguage`).
 * Main passes the result to omp as `OMP_GUI_REPLY_LANGUAGE` at spawn and through
 * the bridge's `reply_language_set` on change; the gui-bridge
 * (resources/gui-bridge/modes/reply-language.ts) turns it into one system-prompt line.
 */

/** prefs key (electron-store `prefs`). */
export const REPLY_LANGUAGE_PREF = "replyLanguage";

/** The languages Settings offers by name; the value is what the instruction names. */
export const REPLY_LANGUAGE_CHOICES = [
	"Korean",
	"English",
	"Japanese",
	"Chinese (Simplified)",
	"Chinese (Traditional)",
	"Spanish",
	"French",
	"German",
	"Portuguese",
	"Vietnamese",
] as const;

export type ReplyLanguageChoice = (typeof REPLY_LANGUAGE_CHOICES)[number];

/** `auto`: the device language; `off`: stock omp, no instruction; else a pinned language. */
export type ReplyLanguagePref = "auto" | "off" | ReplyLanguageChoice;

export function isReplyLanguagePref(value: unknown): value is ReplyLanguagePref {
	return value === "auto" || value === "off" || (REPLY_LANGUAGE_CHOICES as readonly unknown[]).includes(value);
}

/** A stored pref; missing or unknown (hand-edited, a later version's choice) reads as `auto`. */
export function parseReplyLanguagePref(value: unknown): ReplyLanguagePref {
	return isReplyLanguagePref(value) ? value : "auto";
}

/** The language name omp gets for `pref`; undefined = no instruction. */
export function resolveReplyLanguage(pref: unknown, device: string | undefined): string | undefined {
	const parsed = parseReplyLanguagePref(pref);
	if (parsed === "off") return undefined;
	return parsed === "auto" ? device : parsed;
}

const LANGUAGE_NAMES = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });

/**
 * A BCP 47 tag's language subtag: `ko-KR` → `ko`, `de-AT` → `de`. The region
 * is dropped; a script that differs from the language's usual one is kept
 * (`zh-TW` → `zh-Hant`, `sr-Latn` → `sr-Latn`). Unparseable tags, and tags
 * whose language has no English name → undefined.
 */
export function replyLanguageTag(tag: string | undefined): string | undefined {
	if (!tag) return undefined;
	try {
		// Some platforms report POSIX-style `ko_KR`.
		const locale = new Intl.Locale(tag.trim().replaceAll("_", "-"));
		const { language } = locale;
		if (!language || language === "und") return undefined;
		const script = locale.maximize().script;
		const usualScript = new Intl.Locale(language).maximize().script;
		const subtag = script && script !== usualScript ? `${language}-${script}` : language;
		if (LANGUAGE_NAMES.of(subtag)) return subtag;
		return LANGUAGE_NAMES.of(language) ? language : undefined;
	} catch {
		// Engines differ on which malformed tags throw (CI Node rejects some local Bun accepts).
		return undefined;
	}
}

/**
 * English name of a BCP 47 tag's language (`replyLanguageTag` rules):
 * `ko-KR` → `Korean`, `zh-TW` → `Traditional Chinese`. Unknown → undefined.
 */
export function replyLanguageName(tag: string | undefined): string | undefined {
	const subtag = replyLanguageTag(tag);
	return subtag && LANGUAGE_NAMES.of(subtag);
}

/** First device language with a name, as its subtag; `preferred` comes first, `fallback` (e.g. `app.getLocale()`) last. */
export function deviceLanguageTag(preferred: readonly string[], fallback: string | undefined): string | undefined {
	for (const tag of [...preferred, fallback]) {
		const subtag = replyLanguageTag(tag);
		if (subtag) return subtag;
	}
	return undefined;
}
