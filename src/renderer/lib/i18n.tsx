import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { isUiLanguage, type UiLanguage, uiLanguageFromLocale } from "../../shared/ui-language";
import { en } from "../locales/en";
import { ko } from "../locales/ko";
import { zh } from "../locales/zh";

export type Locale = Record<string, string>;
export type Lang = UiLanguage;

const LOCALES: Record<Lang, Locale> = { en, zh, ko };
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

export function getCurrentLanguage(): Lang {
	const stored = readStoredLanguage();
	if (stored) return stored;
	return uiLanguageFromLocale(typeof navigator !== "undefined" ? navigator.language : undefined);
}

function translateForLang(lang: Lang, key: string, params?: Record<string, string | number>): string {
	const locale = LOCALES[lang];
	let str = locale[key] ?? en[key] ?? key;
	if (params) {
		for (const [k, v] of Object.entries(params)) {
			str = str.replace(`{${k}}`, String(v));
		}
	}
	return str;
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
	const [lang, setLangState] = useState<Lang>(getCurrentLanguage);
	const userSelected = useRef(false);

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
					storeLanguage(value);
					setLangState(value);
				} else if (stored) {
					void prefs.set("language", stored).catch(() => {});
				}
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, []);

	const setLang = useCallback((next: Lang) => {
		userSelected.current = true;
		setLangState(next);
		storeLanguage(next);
		void window.omp?.prefs?.set("language", next).catch(() => {});
	}, []);

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

export function useLang(): { lang: Lang; setLang: (lang: Lang) => void } {
	const ctx = useContext(I18nContext);
	if (!ctx) throw new Error("useLang must be used within I18nProvider");
	return { lang: ctx.lang, setLang: ctx.setLang };
}
