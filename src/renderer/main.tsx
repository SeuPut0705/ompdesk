import { Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { RootErrorBoundary } from "./components/common/RootErrorBoundary";
import { lazyChunk, watchChunkFailures } from "./lib/chunk-load";
import { getCurrentLanguage, I18nProvider, loadLocale } from "./lib/i18n";
import { installGlobalRuntimeErrorHandlers, reportRuntimeError } from "./lib/runtime-errors";
import "./styles/global.css";
import "./styles/tokens.css";
import "./styles/theme-dark.css";
import "./styles/theme-light.css";
import "./styles/components.css";
import "./styles/work-board.css";
import "./styles/subagent-view.css";
import "./styles/usage-gauges.css";
import "./styles/mobile.css";

/** Internal design review page: OMP_GUI_STYLEGUIDE=1 opens the window at this hash. */
const StyleGuide = lazyChunk(() => import("./components/styleguide/StyleGuide"));

installGlobalRuntimeErrorHandlers();
watchChunkFailures();

const container = document.getElementById("root");
if (!container) {
	const error = new Error("Root container #root not found");
	reportRuntimeError("react-uncaught", error, { url: window.location.href });
	throw error;
}

const root = createRoot(container, {
	onCaughtError: (error, info) => {
		reportRuntimeError("react-render", error, { componentStack: info.componentStack });
	},
	onUncaughtError: (error, info) => {
		reportRuntimeError("react-uncaught", error, { componentStack: info.componentStack });
	},
	onRecoverableError: (error, info) => {
		reportRuntimeError("react-recoverable", error, { componentStack: info.componentStack });
	},
});

// The UI's strings are a chunk per language (lib/i18n.tsx): the first render waits for the current one, so no
// text ever paints as its key; a chunk that fails to load still renders (English keys) rather than nothing.
const render = () =>
	root.render(
		<RootErrorBoundary>
			<I18nProvider>
				{window.location.hash === "#/styleguide" ? (
					<Suspense fallback={null}>
						<StyleGuide />
					</Suspense>
				) : (
					<App />
				)}
			</I18nProvider>
		</RootErrorBoundary>,
	);
void loadLocale(getCurrentLanguage()).then(render, render);
