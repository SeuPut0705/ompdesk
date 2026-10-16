/** Renders the pairing screen (`/pair`) with the app's styles and language, without loading the app. */
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../lib/i18n";
import "../styles/global.css";
import "../styles/tokens.css";
import "../styles/theme-dark.css";
import "../styles/theme-light.css";
import "../styles/components.css";
import { PairScreen } from "./PairScreen";

export function renderPairScreen(): void {
	const container = document.getElementById("root");
	if (!container) throw new Error("Root container #root not found");
	createRoot(container).render(
		<I18nProvider>
			<PairScreen />
		</I18nProvider>,
	);
}
