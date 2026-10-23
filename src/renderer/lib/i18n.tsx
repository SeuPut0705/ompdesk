import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { isUiLanguage, type UiLanguage, uiLanguageFromLocale } from "../../shared/ui-language";
import { loadChunk } from "./chunk-load";

export type Locale = Record<string, string>;
export type Lang = UiLanguage;

/**
 * Each language is a chunk of its own (en ≈ 350 KB, ko ≈ 290 KB of strings), loaded on first use: a page parses
 * only the language it shows. The entries (main.tsx, the web page's web-boot.ts) load the current one before
 * the first render, and a switch loads the next one before it applies, so no text ever shows as its key.
 */
const LOCALES: Partial<Record<Lang, Locale>> = {};
const LOCALE_CHUNKS: Record<Lang, () => Promise<Locale>> = {
	en: () => import("../locales/en").then(module => module.en),
	ko: () => import("../locales/ko").then(module => module.ko),
};
const pendingLocales: Partial<Record<Lang, Promise<void>>> = {};

/** A load that failed (twice: `loadChunk`) is forgotten, so the next use tries again instead of failing forever. */
export function loadLocale(lang: Lang): Promise<void> {
	if (LOCALES[lang]) return Promise.resolve();
	pendingLocales[lang] ??= loadChunk(LOCALE_CHUNKS[lang]).then(
		locale => {
			LOCALES[lang] = locale;
		},
		(error: unknown) => {
			delete pendingLocales[lang];
			throw error;
		},
	);
	return pendingLocales[lang];
}

export function localeLoaded(lang: Lang): boolean {
	return LOCALES[lang] !== undefined;
}
const LANG_KEY = "omp.lang";

function readStoredLanguage(): Lang | undefined {
	try {
		const stored = localStorage.getItem(LANG_KEY);
		return isUiLanguage(stored) ? stored : undefined;
	} catch {
		return undefined;
	}
}

function storeLanguage(lang: Lang): void {
	try {
		localStorage.setItem(LANG_KEY, lang);
	} catch {
		/* ignore */
	}
}

/**
 * A language shown without being saved (B16: the paired host's language while
 * one of its tabs is focused); null = the user's own. The provider re-renders
 * on a change, and `translate()` / `uiLocale()` read it on every call.
 */
let languageOverride: Lang | null = null;
/** The override last asked for, applied once its language has loaded. */
let requestedOverride: Lang | null = null;
const overrideListeners = new Set<(lang: Lang | null) => void>();

export function setLanguageOverride(lang: Lang | null): void {
	requestedOverride = lang;
	if (lang !== null && !localeLoaded(lang)) {
		void loadLocale(lang).then(() => {
			if (requestedOverride === lang) setLanguageOverride(lang);
		});
		return;
	}
	if (lang === languageOverride) return;
	languageOverride = lang;
	for (const listener of overrideListeners) listener(lang);
}

/** The user's own UI language: the saved one, else the system locale's. */
function ownLanguage(): Lang {
	return (
		readStoredLanguage() ?? uiLanguageFromLocale(typeof navigator !== "undefined" ? navigator.language : undefined)
	);
}

export function getCurrentLanguage(): Lang {
	return languageOverride ?? ownLanguage();
}

function translateForLang(lang: Lang, key: string, params?: Record<string, string | number>): string {
	const str = LOCALES[lang]?.[key] ?? LOCALES.en?.[key] ?? key;
	if (!params) return str;
	// One pass: a value is never re-scanned (a path holding "{name}" stays literal), a placeholder
	// repeated in a string is filled everywhere, and "$&"-style patterns in a value are not special.
	// `{plural}` is "s" unless `count` is 1, when the caller does not say otherwise ("1 session", "2 sessions"). A
	// count passed already formatted ("1,204") is read back; "1+" is more than one.
	const filled =
		params.count !== undefined && !Object.hasOwn(params, "plural")
			? { ...params, plural: Number(String(params.count).replace(/[,\s\u00a0\u202f']/g, "")) === 1 ? "" : "s" }
			: params;
	return str.replace(/\{(\w+)\}/g, (match, name: string) =>
		Object.hasOwn(filled, name) ? String(filled[name]) : match,
	);
}

/**
 * Non-React translation for services/watchers (voice, notifications) that
 * cannot call the `useT` hook. Re-reads the persisted lang on every call so
 * runtime language switches apply without a subscription.
 */
export function translate(key: string, params?: Record<string, string | number>): string {
	return translateForLang(getCurrentLanguage(), key, params);
}

interface I18nContextValue {
	lang: Lang;
	setLang: (lang: Lang) => void;
	t: (key: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
	const [ownLang, setLangState] = useState<Lang>(ownLanguage);
	const [override, setOverride] = useState<Lang | null>(languageOverride);
	const lang = override ?? ownLang;

	useEffect(() => {
		overrideListeners.add(setOverride);
		setOverride(languageOverride);
		return () => {
			overrideListeners.delete(setOverride);
		};
	}, []);
	const userSelected = useRef(false);
	/** The user's language changes once its strings are here (saved first, so `translate()` agrees). */
	const applyOwn = useCallback((next: Lang) => {
		void loadLocale(next).then(() => {
			storeLanguage(next);
			setLangState(next);
		});
	}, []);

	useEffect(() => {
		const prefs = window.omp?.prefs;
		if (!prefs) return;
		const stored = readStoredLanguage();
		let cancelled = false;
		void prefs
			.get("language")
			.then(value => {
				if (cancelled || userSelected.current) return;
				if (isUiLanguage(value)) {
					applyOwn(value);
				} else if (stored) {
					void prefs.set("language", stored).catch(() => {});
				}
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [applyOwn]);

	const setLang = useCallback(
		(next: Lang) => {
			userSelected.current = true;
			applyOwn(next);
			void window.omp?.prefs?.set("language", next).catch(() => {});
		},
		[applyOwn],
	);

	const t = useCallback(
		(key: string, params?: Record<string, string | number>): string => translateForLang(lang, key, params),
		[lang],
	);

	const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);

	return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT(): (key: string, params?: Record<string, string | number>) => string {
	const ctx = useContext(I18nContext);
	if (!ctx) throw new Error("useT must be used within I18nProvider");
	return ctx.t;
}

/**
 * The UI language for a value cached from {@link translate} (a label a hook keeps in state): the provider's while one
 * is mounted, so a switch re-renders the caller; outside one, the current language.
 */
export function useCurrentLang(): Lang {
	return useContext(I18nContext)?.lang ?? getCurrentLanguage();
}

export function useLang(): { lang: Lang; setLang: (lang: Lang) => void } {
	const ctx = useContext(I18nContext);
	if (!ctx) throw new Error("useLang must be used within I18nProvider");
	return { lang: ctx.lang, setLang: ctx.setLang };
}
