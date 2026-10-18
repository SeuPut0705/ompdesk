/**
 * Run-state composer prototypes (`proto-run.html`): three competing ways to show Send / Stop / Steer / Follow-up
 * and the queue of pending messages while a turn runs, over fake state, with the app's real components, tokens,
 * CSS and locale strings.
 *
 *   ?variant=a|b|c|all   ?state=idle|typing|running|running-draft|queue1|queue4|queue10|edit-queued|
 *                                paused-after-stop|stop-pending|ask|approval
 *   ?shell=desktop|phone|tablet   ?width=<px>   ?height=<px>   ?theme=light|dark   ?lang=en|ko
 *
 * `shell` is resolved by proto-run.html before any module loads (desktop: no data-shell, like an Electron window;
 * phone / tablet pin the real shell mode and touch input through the app's own `?shell=` / `?input=` flags).
 */

import { createRoot } from "react-dom/client";
import { getCurrentLanguage, I18nProvider, loadLocale } from "../../../lib/i18n";
import { applyFontSize, applyTheme } from "../../../lib/theme";
import "../../../styles/global.css";
import "../../../styles/tokens.css";
import "../../../styles/theme-dark.css";
import "../../../styles/theme-light.css";
import "../../../styles/components.css";
import "../../../styles/mobile.css";
import { Frame, type FrameSize } from "./frame";
import { STATES, type StateName, useProto, type Variant } from "./model";
import { ComposerA } from "./VariantA";
import { ComposerB } from "./VariantB";
import { ComposerC } from "./VariantC";

document.documentElement.dataset.platform ||= "web";

const query = new URLSearchParams(location.search);
const shell = query.get("protoShell") ?? "desktop";
const requested = query.get("variant") ?? "all";
const variants: Variant[] = requested === "a" || requested === "b" || requested === "c" ? [requested] : ["a", "b", "c"];
const stateParam = query.get("state") ?? "idle";
const state: StateName = STATES.find(name => name === stateParam) ?? "idle";
const dark = query.get("theme") === "dark";

const sizes: Record<string, FrameSize> = {
	desktop: { width: 1280, height: requested === "all" ? 520 : 900 },
	tablet: { width: 834, height: requested === "all" ? 760 : 1194 },
	phone: { width: 390, height: 844 },
};
const base = sizes[shell] ?? sizes.desktop!;
const size: FrameSize = {
	width: Number(query.get("width")) || base.width,
	height: Number(query.get("height")) || base.height,
};

const TITLES: Record<Variant, string> = {
	a: "A · tray repaired",
	b: "B · queue inside the box",
	c: "C · toolbar pill + popover",
};

function ProtoFrame({ variant, lang }: { variant: Variant; lang: string }) {
	const store = useProto(state, lang, variant);
	const Composer = variant === "a" ? ComposerA : variant === "b" ? ComposerB : ComposerC;
	return (
		<Frame size={size} store={store} variant={variant}>
			<Composer store={store} />
		</Frame>
	);
}

function Page() {
	const lang = getCurrentLanguage();
	return (
		<div
			className={`flex items-start gap-6 bg-(--sc-bg) text-(--sc-text) ${variants.length > 1 ? "p-4" : ""}`}
			data-proto-page
		>
			{variants.map(variant => (
				<section className="flex flex-col gap-2" key={variant}>
					{variants.length > 1 && (
						<h2 className="text-sc-md font-semibold text-(--sc-text-secondary)" data-proto-title>
							{TITLES[variant]}
						</h2>
					)}
					<ProtoFrame lang={lang} variant={variant} />
				</section>
			))}
		</div>
	);
}

applyTheme(dark ? "dark" : "light");
applyFontSize(15);
const container = document.getElementById("root");
if (!container) throw new Error("#root missing");
const root = createRoot(container);
const render = () =>
	root.render(
		<I18nProvider>
			<Page />
		</I18nProvider>,
	);
void loadLocale(getCurrentLanguage()).then(render, render);
