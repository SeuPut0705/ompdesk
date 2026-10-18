/** Renders the pairing screen (`/pair`) with the app's styles and language, without loading the app. */
import { createRoot } from "react-dom/client";
import { getCurrentLanguage, I18nProvider, loadLocale } from "../lib/i18n";
import "../styles/global.css";
import "../styles/tokens.css";
import "../styles/theme-dark.css";
import "../styles/theme-light.css";
import "../styles/components.css";
import { PairScreen } from "./PairScreen";

export function renderPairScreen(): void {
	const container = document.getElementById("root");
	if (!container) throw new Error("Root container #root not found");
	const root = createRoot(container);
	// The strings are a chunk per language (lib/i18n.tsx): render once the current one is here.
	const render = () =>
		root.render(
			<I18nProvider>
				<PairScreen />
			</I18nProvider>,
		);
	void loadLocale(getCurrentLanguage()).then(render, render);
}
