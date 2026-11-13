import { app } from "electron";
import { fillText } from "../shared/fill-text";
import { isUiLanguage, type UiLanguage, uiLanguageFromLocale } from "../shared/ui-language";
import { MAIN_TEXT, type MainTextKey } from "./i18n-text";
import type { OmpFailure } from "./omp-runtime";
import { SafeStore } from "./safe-store";

export type MainLanguage = UiLanguage;

const prefs = new SafeStore<{ language?: MainLanguage }>({ name: "prefs" });

export function getMainLanguage(): MainLanguage {
	const stored = prefs.get("language");
	if (isUiLanguage(stored)) return stored;
	return uiLanguageFromLocale(app.getLocale());
}

export function mainT(
	key: MainTextKey,
	language = getMainLanguage(),
	params?: Record<string, string | number>,
): string {
	return fillText(MAIN_TEXT[key][language], params);
}

/** User-facing text for why the system omp is unusable, in the UI language. */
export function ompFailureText(reason: OmpFailure, language = getMainLanguage()): string {
	switch (reason.kind) {
		case "not-found":
			return mainT("omp.notFound", language);
		case "override-missing":
			return mainT("omp.overrideMissing", language, { path: reason.path });
		case "cannot-run":
			return mainT("omp.cannotRun", language, { bin: reason.bin, detail: reason.detail });
		case "too-old":
			return mainT("omp.tooOld", language, { version: reason.version, minimum: reason.minimum });
		case "compiled":
			return mainT("omp.compiled", language, { bin: reason.bin });
		case "bun-too-old":
			return mainT("omp.bunTooOld", language, {
				bin: reason.bin,
				bun: reason.bun,
				bunVersion: reason.bunVersion,
				minimum: reason.minimum,
			});
	}
}
