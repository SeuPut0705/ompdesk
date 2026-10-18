/**
 * Entry of proto-phone.html — THROWAWAY prototypes of the phone composer (three variants, fake state). The real
 * stylesheets, tokens, locale strings and shell attributes (`html[data-shell="phone"] data-input="touch"` through the
 * production `useShellMode`, which also runs the keyboard inset) are loaded; the composer parts are drawn here.
 *
 *   ?variant=a|b|c|all   all = three iframes side by side (size ?w=390&h=844)
 *   ?state=idle|typing|multiline|keyboard|running|running-draft|attachments|more-open|menu-slash|queue
 *   ?theme=light|dark  ?lang=en|ko  ?images=N (attachments)  ?stt=0  ?expanded=1  ?plan=1  ?fakekb=<px>  ?focus=1
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../../styles/global.css";
import "../../../styles/tokens.css";
import "../../../styles/theme-dark.css";
import "../../../styles/theme-light.css";
import "../../../styles/components.css";
import "../../../styles/work-board.css";
import "../../../styles/subagent-view.css";
import "../../../styles/usage-gauges.css";
import "../../../styles/mobile.css";
import "./proto-phone.css";
import { useShellMode } from "../../../hooks/use-shell-mode";
import { getCurrentLanguage, I18nProvider, loadLocale } from "../../../lib/i18n";
import { applyFontSize, applyTheme } from "../../../lib/theme";
import { EnvContext, Frame, useEnvValue } from "./Frame";
import {
	presetFor,
	type Session,
	type SessionApi,
	SessionContext,
	STATES,
	type StateName,
	type VariantId,
} from "./fake";
import { useP } from "./strings";
import { VariantA } from "./VariantA";
import { VariantB } from "./VariantB";
import { VariantC } from "./VariantC";

document.documentElement.dataset.platform = "web";
const query = new URLSearchParams(location.search);
// The production hook reads ?shell= / ?input= once: a prototype is always the phone shell on touch.
if (!query.has("shell")) query.set("shell", "phone");
if (!query.has("input")) query.set("input", "touch");
history.replaceState(null, "", `${location.pathname}?${query}`);
applyTheme(query.get("theme") === "dark" ? "dark" : "light");
applyFontSize(15);

const STATE_NAMES: readonly string[] = STATES;
const FOCUS_STATES: readonly StateName[] = ["typing", "multiline", "keyboard", "menu-slash", "running-draft"];

const VARIANT_VIEWS: Record<VariantId, () => React.JSX.Element> = { a: VariantA, b: VariantB, c: VariantC };

function Proto({ variant, state }: { variant: VariantId; state: StateName }) {
	useShellMode();
	const p = useP();
	const fieldRef = useRef<HTMLTextAreaElement | null>(null);
	const [s, setS] = useState<Session>(() =>
		presetFor(
			state,
			{
				sample: p("pp.draftSample"),
				multi: p("pp.draftMulti"),
				running: p("pp.draftRunning"),
				q: [p("pp.q1"), p("pp.q2"), p("pp.q3")],
			},
			query,
		),
	);
	const sessionRef = useRef(s);
	sessionRef.current = s;
	const set = useCallback<SessionApi["set"]>(patch => {
		setS(current => ({ ...current, ...(typeof patch === "function" ? patch(current) : patch) }));
	}, []);
	const act = useCallback<SessionApi["act"]>((name, detail) => {
		window.__proto?.log.push({ name, detail, at: performance.now() });
	}, []);
	window.__proto ??= { log: [], session: () => sessionRef.current, set };
	window.__proto.session = () => sessionRef.current;
	window.__proto.set = set;

	const { env, fakeKb } = useEnvValue(query, state === "keyboard");
	useEffect(() => {
		if (!FOCUS_STATES.includes(state) && query.get("focus") !== "1") return;
		const frame = requestAnimationFrame(() => {
			const el = fieldRef.current;
			if (!el) return;
			el.focus();
			el.setSelectionRange(el.value.length, el.value.length);
		});
		return () => cancelAnimationFrame(frame);
	}, [state]);

	const View = VARIANT_VIEWS[variant];
	return (
		<EnvContext.Provider value={env}>
			<SessionContext.Provider value={{ s, set, act, fieldRef, variant, state }}>
				<Frame fakeKb={fakeKb} hideWorkChip={env.visibleH < 420} running={s.running}>
					<View />
				</Frame>
			</SessionContext.Provider>
		</EnvContext.Provider>
	);
}

/** variant=all: the three prototypes as iframes, each with its own viewport so its media queries see a phone. */
function All() {
	const width = Number(query.get("w") ?? 390);
	const height = Number(query.get("h") ?? 844);
	const scale = Number(query.get("scale") ?? 1);
	return (
		<div className="flex min-h-screen items-start justify-center gap-6 bg-(--sc-surface-3) p-6">
			{(["a", "b", "c"] as const).map(variant => {
				const next = new URLSearchParams(query);
				next.set("variant", variant);
				return (
					<figure className="flex flex-col items-center gap-2" key={variant}>
						<figcaption className="text-sc-md font-semibold text-(--sc-text)">{variant.toUpperCase()}</figcaption>
						<div style={{ width: width * scale, height: height * scale }}>
							<iframe
								className="rounded-(--sc-radius-xl) border border-(--sc-border) bg-(--sc-bg)"
								height={height}
								src={`${location.pathname}?${next}`}
								style={{ transform: `scale(${scale})`, transformOrigin: "top left" }}
								title={`variant ${variant}`}
								width={width}
							/>
						</div>
					</figure>
				);
			})}
		</div>
	);
}

function Root() {
	const variantParam = query.get("variant") ?? "a";
	if (variantParam === "all") return <All />;
	const variant: VariantId = variantParam === "b" || variantParam === "c" ? variantParam : "a";
	const stateParam = query.get("state") ?? "idle";
	const state = (STATE_NAMES.includes(stateParam) ? stateParam : "idle") as StateName;
	return <Proto state={state} variant={variant} />;
}

const container = document.getElementById("root");
if (!container) throw new Error("#root missing");
const root = createRoot(container);
const render = () =>
	root.render(
		<I18nProvider>
			<Root />
		</I18nProvider>,
	);
void loadLocale(getCurrentLanguage()).then(render, render);
