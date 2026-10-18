/** Turns measure.json into the markdown tables of local://composer-proto-toolbar.md (run: bun report.mts). */

import * as fs from "node:fs/promises";
import type { Snap } from "./capture-measure.mts";

const OUT = "/tmp/composer-best/prototypes/toolbar";
const data = JSON.parse(await fs.readFile(`${OUT}/measure.json`, "utf8"));
const VARIANTS = ["base", "a", "b", "c"];
const WIDTHS = [1000, 760, 560, 420, 340];
const STATES = ["idle", "typing", "running", "running-draft", "plan-goal"];

interface Row {
	variant: string;
	state: string;
	width: number;
	lang: string;
	model?: string;
	snap: Snap;
}
const grid: Row[] = data.grid;
const out: string[] = [];
const say = (line = "") => out.push(line);
const pick = (variant: string, state: string, width: number, lang: string, model?: string) =>
	grid.find(r => r.variant === variant && r.state === state && r.width === width && r.lang === lang && r.model === model);

// T1: toolbar height.
say("### T1 · Toolbar height (px, boundingBox of the toolbar row), per state × composer width, en | ko");
for (const variant of VARIANTS) {
	say(`\n**${variant}**\n`);
	say(`| state | ${WIDTHS.join(" | ")} |`);
	say(`|---|${WIDTHS.map(() => "---").join("|")}|`);
	for (const state of STATES) {
		const cells = WIDTHS.map(w => {
			const en = pick(variant, state, w, "en")?.snap.toolbarH;
			const ko = pick(variant, state, w, "ko")?.snap.toolbarH;
			return en === ko ? `${en}` : `${en} \\| ${ko}`;
		});
		say(`| ${state} | ${cells.join(" | ")} |`);
	}
	const longCells = WIDTHS.map(w => `${pick(variant, "plan-goal", w, "en", "long")?.snap.toolbarH}`);
	say(`| plan-goal + long model | ${longCells.join(" | ")} |`);
}

// T2: overflow / clipping.
say("\n### T2 · Overflow, clipping, overlap and truncation (worst case over all 7 states incl. long model, en and ko)");
say("`past pad` = px the rightmost control reaches into the toolbar's 10 px right padding (>0 means it is squeezed against the border); `past box` = px beyond the composer border (clipped/outside); `overlap` = number of control pairs whose boxes intersect; `wraps` = toolbar taller than 44.\n");
say(`| variant | width | worst past pad | worst past box | overlaps | wraps | states with a problem |`);
say("|---|---|---|---|---|---|---|");
for (const variant of VARIANTS) {
	for (const w of WIDTHS) {
		const rows = grid.filter(r => r.variant === variant && r.width === w);
		const worstPad = Math.max(...rows.map(r => r.snap.overflowIntoPadding));
		const worstBox = Math.max(...rows.map(r => r.snap.beyondBox));
		const overlaps = Math.max(...rows.map(r => r.snap.overlaps));
		const wraps = rows.filter(r => r.snap.toolbarH > 44.5).length;
		const bad = rows
			.filter(r => r.snap.overflowIntoPadding > 0.5 || r.snap.beyondBox > 0 || r.snap.overlaps > 0 || r.snap.toolbarH > 44.5)
			.map(r => `${r.state}${r.model ? "+long" : ""}/${r.lang}`);
		say(`| ${variant} | ${w} | ${worstPad} | ${worstBox} | ${overlaps} | ${wraps} | ${bad.length === 0 ? "none" : bad.join(", ")} |`);
	}
}

// T2b: truncated text.
say("\n### T2b · Label truncation (ellipsis in effect), long model name\n");
say("| variant | width | truncated labels (en, plan-goal + long model) |");
say("|---|---|---|");
for (const variant of VARIANTS) {
	for (const w of WIDTHS) {
		const r = pick(variant, "plan-goal", w, "en", "long");
		say(`| ${variant} | ${w} | ${r?.snap.truncated.join(" ; ") || "—"} |`);
	}
}

// T3: C4 transitions.
say("\n### T3 · C4 layout stability: live transitions (real clicks/typing), worst over widths 1000/560/340 × en/ko");
say("`Δh` = change of the toolbar row height; `max Δx/Δy` = largest shift of any control that exists before and after (px, relative to the toolbar); `appears` = controls mounted by the step.\n");
const steps = new Map<string, Map<string, { h: number; dx: number; dy: number; moved: Set<string>; appears: Set<string> }>>();
for (const entry of data.transitions) {
	for (const row of entry.rows) {
		const byVariant = steps.get(entry.variant) ?? new Map();
		steps.set(entry.variant, byVariant);
		const cur = byVariant.get(row.step) ?? { h: 0, dx: 0, dy: 0, moved: new Set<string>(), appears: new Set<string>() };
		cur.h = Math.max(cur.h, Math.abs(row.heightDelta));
		cur.dx = Math.max(cur.dx, row.maxDx);
		cur.dy = Math.max(cur.dy, row.maxDy);
		for (const m of row.moved) cur.moved.add(m.replace(/\(.*/, ""));
		for (const a of [...row.appeared, ...row.vanished]) cur.appears.add(a);
		byVariant.set(row.step, cur);
	}
}
say("| variant | step | Δh | max Δx | max Δy | controls that moved | mounted/unmounted |");
say("|---|---|---|---|---|---|---|");
for (const variant of VARIANTS) {
	for (const [step, v] of steps.get(variant) ?? []) {
		say(`| ${variant} | ${step} | ${v.h} | ${v.dx} | ${v.dy} | ${[...v.moved].join(", ") || "—"} | ${[...v.appears].join(", ") || "—"} |`);
	}
}

// T4: popovers.
say("\n### T4 · Popover open/close (light, plan-goal, composer 760 px)");
say("`toolbar Δ` = shift of any toolbar control while the popover is open / after it closed (px); panel = popover box.\n");
say("| variant | popover | lang | open Δh/Δx/Δy | close Δh/Δx/Δy | panel w×h | fully in viewport |");
say("|---|---|---|---|---|---|---|");
for (const p of data.popovers) {
	if (!p.id) continue;
	say(`| ${p.variant} | ${p.id} | ${p.lang} | ${p.open.heightDelta}/${p.open.maxDx}/${p.open.maxDy} | ${p.close.heightDelta}/${p.close.maxDx}/${p.close.maxDy} | ${p.panel ? `${p.panel.w}×${p.panel.h}` : "?"} | ${p.panel?.inViewport ?? "?"} |`);
}

// T5: hit sizes.
say("\n### T5 · Hit sizes (running-draft, en). `box` = element box; `hit` = real press area measured by elementFromPoint around the centre (tablet touch shell: the 44 px reach, bounded by --hit-gap).");
type Hit = { key: string; w: number; h: number; boxW: number; boxH: number };
const modes: Array<{ name: string; shell: boolean; hitfix: boolean }> = [
	{ name: "desktop (mouse)", shell: false, hitfix: false },
	{ name: "tablet touch shell (?shell=tablet-landscape&input=touch), production --hit-gap 8 px", shell: true, hitfix: false },
	{ name: "tablet touch shell with `--hit-gap-y: 16px` on the toolbar (one CSS line)", shell: true, hitfix: true },
];
for (const mode of modes) {
	say(`\n**${mode.name}**\n`);
	say("| variant | width | min hit w×h | toolbar h | past pad / past box / overlaps | controls: key box→hit |");
	say("|---|---|---|---|---|---|");
	for (const variant of VARIANTS) {
		for (const width of [760, 340]) {
			const h = data.hits.find(
				(x: { variant: string; shell: boolean; width: number; hitfix?: boolean }) =>
					x.variant === variant && x.shell === mode.shell && x.width === width && Boolean(x.hitfix) === mode.hitfix,
			);
			if (!h) continue;
			const controls: Hit[] = h.controls;
			const minW = Math.min(...controls.map(c => c.w));
			const minH = Math.min(...controls.map(c => c.h));
			const cells = controls.map(c => `${c.key} ${Math.round(c.boxW)}×${Math.round(c.boxH)}→${c.w}×${c.h}`);
			say(`| ${variant} | ${width} | ${minW}×${minH} | ${Math.round(h.snap.toolbarH)} | ${h.snap.overflowIntoPadding} / ${h.snap.beyondBox} / ${h.snap.overlaps} | ${cells.join("; ")} |`);
		}
	}
}

// T6: taps.
say("\n### T6 · Taps/clicks per action (each path executed with real clicks at 1000 px; ok = the end state was verified)\n");
const tasks = new Map<string, Map<string, { taps: number; ok: boolean }>>();
for (const entry of data.tasks) for (const t of entry.tasks) {
	const m = tasks.get(t.task) ?? new Map();
	tasks.set(t.task, m);
	m.set(entry.variant, { taps: t.taps, ok: t.ok });
}
say(`| action | ${VARIANTS.join(" | ")} |`);
say(`|---|${VARIANTS.map(() => "---").join("|")}|`);
for (const [task, m] of tasks) say(`| ${task} | ${VARIANTS.map(v => `${m.get(v)?.taps}${m.get(v)?.ok ? "" : " ✗"}`).join(" | ")} |`);

// T7: C2 — visible without opening.
say("\n### T7 · What is on screen without opening anything (en, text of visible controls; icon-only controls listed as key:∅)");
for (const state of ["idle", "plan-goal", "running-draft"]) {
	for (const w of [1000, 560, 340]) {
		say(`\n**${state} @ ${w}**\n`);
		for (const variant of VARIANTS) {
			const r = pick(variant, state, w, "en");
			if (!r) continue;
			const keys = r.snap.controls.filter(c => !c.hidden).map(c => (c.text ? `${c.key}:“${c.text.replace(/\n/g, " ")}”` : `${c.key}:∅`));
			say(`- ${variant}: ${keys.join(" · ")}`);
		}
	}
}

// T8: C3 chrome.
say("\n### T8 · Chrome density (idle, en)\n");
say("| variant | toolbar h | visible controls @1000 | their summed width @1000 | visible controls @340 |");
say("|---|---|---|---|---|");
for (const variant of VARIANTS) {
	const a = pick(variant, "idle", 1000, "en")!;
	const b = pick(variant, "idle", 340, "en")!;
	const vis = (s: Snap) => s.controls.filter(c => !c.hidden);
	say(`| ${variant} | ${a.snap.toolbarH} | ${vis(a.snap).length} | ${Math.round(vis(a.snap).reduce((sum, c) => sum + c.w, 0))} | ${vis(b.snap).length} |`);
}

await fs.writeFile(`${OUT}/tables.md`, out.join("\n"));
console.log(`${OUT}/tables.md written (${out.length} lines)`);
