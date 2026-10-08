/**
 * The agent's default reply language, from the device language (not the UI
 * language: the UI ships only en/ko, the device may be Japanese, German, …).
 * Main passes the result to omp as `OMP_GUI_REPLY_LANGUAGE`; the gui-bridge
 * (resources/gui-bridge/modes/reply-language.ts) turns it into one system-prompt line.
 */

const LANGUAGE_NAMES = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });

/**
 * English name of a BCP 47 tag's language: `ko-KR` → `Korean`, `de-AT` → `German`.
 * The region is dropped; a script that differs from the language's usual one
 * is kept (`zh-TW` → `Traditional Chinese`, `sr-Latn` → `Serbian (Latin)`).
 * Unparseable or unknown tags → undefined.
 */
export function replyLanguageName(tag: string | undefined): string | undefined {
	if (!tag) return undefined;
	let locale: Intl.Locale;
	try {
		// Some platforms report POSIX-style `ko_KR`.
		locale = new Intl.Locale(tag.trim().replaceAll("_", "-"));
	} catch {
		return undefined;
	}
	const { language } = locale;
	if (language === "und") return undefined;
	const script = locale.maximize().script;
	const usualScript = new Intl.Locale(language).maximize().script;
	const subtag = script && script !== usualScript ? `${language}-${script}` : language;
	return LANGUAGE_NAMES.of(subtag) ?? LANGUAGE_NAMES.of(language);
}

/** First device language that maps to a name; `preferred` comes first, `fallback` (e.g. `app.getLocale()`) last. */
export function deviceReplyLanguage(preferred: readonly string[], fallback: string | undefined): string | undefined {
	for (const tag of [...preferred, fallback]) {
		const name = replyLanguageName(tag);
		if (name) return name;
	}
	return undefined;
}
