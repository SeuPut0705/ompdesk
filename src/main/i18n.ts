import { app } from "electron";
import Store from "electron-store";
import { fillText } from "../shared/fill-text";
import { isUiLanguage, type UiLanguage, uiLanguageFromLocale } from "../shared/ui-language";
import type { EditLabels } from "./editable-context-menu";
import { MAIN_TEXT, type MainTextKey } from "./i18n-text";
import type { OmpFailure } from "./omp-runtime";

export type MainLanguage = UiLanguage;

const prefs = new Store<{ language?: MainLanguage }>({ name: "prefs" });

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

/** The edit items' names, for the Edit menu and the text-field context menu. */
export function editLabels(language = getMainLanguage()): EditLabels {
	return {
		undo: mainT("menu.undo", language),
		redo: mainT("menu.redo", language),
		cut: mainT("menu.cut", language),
		copy: mainT("menu.copy", language),
		paste: mainT("menu.paste", language),
		selectAll: mainT("menu.selectAll", language),
		addToDictionary: mainT("menu.addToDictionary", language),
		copyImage: mainT("menu.copyImage", language),
	};
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
	}
}
