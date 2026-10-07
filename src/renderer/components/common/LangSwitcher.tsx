/**
 * Language switcher: compact globe button that toggles the UI between
 * English and 한국어. Reads and persists the active language through useLang()
 * (localStorage LANG_KEY inside I18nProvider), so no extra wiring is needed —
 * mount it anywhere under the provider. Rendered label shows the CURRENT
 * language autonym ("EN" / "한국어"), matching OS-language-picker convention.
 *
 * Mount points (wired by the shell owner): TitleBar trailing icon row and the
 * Settings window GUI tab.
 */

import { Globe } from "lucide-react";
import { nextUiLanguage, UI_LANGUAGE_NAMES } from "../../../shared/ui-language";
import { cx } from "../../lib/format";
import { useLang, useT } from "../../lib/i18n";

export interface LangSwitcherProps {
	className?: string;
}

export function LangSwitcher({ className }: LangSwitcherProps) {
	const { lang, setLang } = useLang();
	const t = useT();
	const next = nextUiLanguage(lang);
	return (
		<button
			type="button"
			onClick={() => setLang(next)}
			title={t("lang.switch")}
			aria-label={t("lang.switch")}
			className={cx(
				"no-drag omp-pressable flex h-9 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-omp-md font-medium text-[var(--omp-muted)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)]",
				className,
			)}
		>
			<Globe size={16} />
			<span>{lang === "en" ? "EN" : UI_LANGUAGE_NAMES[lang]}</span>
		</button>
	);
}
