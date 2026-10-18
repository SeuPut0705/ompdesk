/**
 * Entry of proto-toolbar.html (throwaway): three composer-toolbar prototypes (and `base`, the current production
 * toolbar replayed) over fake state, with the real common components, locale strings and tokens.
 *
 * ?variant=base|a|b|c|all  ?state=idle|typing|running|running-draft|plan-goal  ?width=<px of the composer>
 * ?model=long  ?theme=light|dark  ?lang=en|ko  (and ?shell=tablet-landscape&input=touch for the touch rules).
 */

import { createRoot } from "react-dom/client";
import { getCurrentLanguage, I18nProvider, loadLocale } from "../../../lib/i18n";
import "../../../styles/global.css";
import "../../../styles/tokens.css";
import "../../../styles/theme-dark.css";
import "../../../styles/theme-light.css";
import "../../../styles/components.css";
import "../../../styles/mobile.css";
import "./proto.css";
import { fakeFor, type ProtoProps, STATE_NAMES, type StateName } from "./fake";
import { VariantA } from "./VariantA";
import { VariantB } from "./VariantB";
import { VariantC } from "./VariantC";

type VariantId = "base" | "a" | "b" | "c";
const ALL: readonly VariantId[] = ["base", "a", "b", "c"];

const TITLES: Record<VariantId, string> = {
	base: "base — current production toolbar (reference)",
	a: "A — same structure, fixed (toolbar container ladder, reserved slots, data-active)",
	b: "B — one Run chip, model · effort chip, context ring",
	c: "C — Codex footer: mode on the box outline, permissions chip, one 440 px collapse",
};

const query = new URLSearchParams(location.search);
const variantParam = query.get("variant") ?? "all";
const variants: readonly VariantId[] = ALL.includes(variantParam as VariantId) ? [variantParam as VariantId] : ALL;
const stateParam = query.get("state") ?? "idle";
const state: StateName = STATE_NAMES.includes(stateParam as StateName) ? (stateParam as StateName) : "idle";
const width = Number(query.get("width") ?? 760);
const longModel = query.get("model") === "long";

function Variant({ id, props }: { id: VariantId; props: ProtoProps }) {
	if (id === "base") return <VariantA {...props} legacy />;
	if (id === "a") return <VariantA {...props} />;
	if (id === "b") return <VariantB {...props} />;
	return <VariantC {...props} />;
}

function Sheet() {
	const props: ProtoProps = { width, initial: fakeFor(state, longModel) };
	return (
		<main
			className={variants.length === 1 ? "proto-sheet proto-sheet--single" : "proto-sheet"}
			data-proto-ready
			data-proto-state={state}
			data-proto-width={width}
		>
			{variants.map(id => (
				<section className="proto-variant" data-variant={id} key={`${id}-${state}-${width}-${longModel}`}>
					<h3>{TITLES[id]}</h3>
					<Variant id={id} props={props} />
				</section>
			))}
		</main>
	);
}

const container = document.getElementById("root");
if (!container) throw new Error("#root missing");
const render = () =>
	createRoot(container).render(
		<I18nProvider>
			<Sheet />
		</I18nProvider>,
	);
void loadLocale(getCurrentLanguage()).then(render, render);
