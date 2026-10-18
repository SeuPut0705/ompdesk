/**
 * The first frame of the app: the real layout as a flat skeleton (sidebar, top bar, transcript, composer), painted
 * from the page's own HTML and CSS before any script runs. It uses the same classes the React layout does
 * (`omp-sidebar-header`, `omp-topbar`, `omp-composer-shell`, …), so the bundle's render-blocking stylesheet gives it
 * the real geometry, and React's first render replaces `#root`'s content without anything moving. Nothing in it
 * animates (a still skeleton, as the rest of the app: AGENTS.md › No loading screens).
 *
 * gen-icons writes `bootShell(variant)` between the `boot-mark` markers of src/renderer/index.html (`desktop`) and
 * web.html (`web`); brand-mark.test.ts checks the pages equal it. pre-paint.js sets what the shell reads before the
 * first paint: the saved scheme, `--boot-sidebar-w` (the sidebar width) and, in the desktop app, `data-platform`.
 */

import { COMPOSER_BOX_PX, SIDEBAR_WIDTH } from "../src/shared/boot-shell-geometry";
import { BRAND_MARK } from "../src/shared/brand-mark";
import { DARK, LIGHT } from "./brand-svgs";

export type BootShellVariant = "desktop" | "web";

/** A skeleton bar: the app's `.omp-skeleton` fill, a size and a radius. */
const bar = (width: string, height: string, extra = "") =>
	`<span class="omp-skeleton block" style="width:${width};height:${height}${extra}"></span>`;

const SIDEBAR_ROWS = [62, 48, 70, 40, 56, 66, 44, 58];

function sidebar(): string {
	const rows = SIDEBAR_ROWS.map(
		width =>
			`<div class="flex h-8 items-center gap-2.5 px-2.5">${bar("14px", "14px", ";border-radius:4px")}${bar(`${width}%`, "10px", ";border-radius:9999px")}</div>`,
	).join("");
	return `<aside class="boot-sidebar omp-session-sidebar relative flex h-full min-h-0 shrink-0 flex-col border-r border-(--sc-border-subtle) bg-(--sc-surface-1)"><div class="omp-sidebar-header flex h-12 shrink-0 items-center gap-1 pr-2"><span class="flex min-w-0 flex-1 items-center gap-2 pl-1.5">${bar("18px", "18px", ";border-radius:5px")}${bar("72px", "10px", ";border-radius:9999px")}</span></div><div class="min-h-0 flex-1 overflow-hidden px-1.5 pt-2">${rows}</div></aside>`;
}

function mark(): string {
	return `<svg class="boot-mark-svg" width="48" height="48" viewBox="${BRAND_MARK.viewBox}" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path class="boot-ink" d="${BRAND_MARK.full.ink}"/><path class="boot-accent" d="${BRAND_MARK.full.accent}"/></svg>`;
}

function main(): string {
	return `<main class="omp-workspace-main relative flex min-w-0 flex-1 flex-col"><div class="flex min-h-0 flex-1 flex-col"><header class="omp-titlebar omp-topbar flex h-12 min-w-0 shrink-0 items-center gap-1 px-3">${bar("160px", "12px", ";border-radius:9999px")}</header><div class="omp-split-workspace relative grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)]"><section class="omp-session-pane relative flex min-h-0 min-w-0 flex-col overflow-hidden"><div class="relative flex min-h-0 flex-1 flex-col"><div class="boot-mark flex min-h-0 flex-1 items-center justify-center">${mark()}</div><div class="omp-composer-region relative shrink-0 bg-transparent pt-2"><div class="omp-composer-shell relative w-full"></div></div></div><div class="omp-composer-region relative shrink-0 bg-transparent pb-3"><div class="omp-composer-shell relative w-full"><div class="boot-composer-box omp-composer-box relative flex flex-col rounded-(--sc-radius-xl) border border-(--sc-border-subtle) bg-(--sc-field)"><div class="px-4 pt-3 pb-1">${bar("38%", "10px", ";margin-top:7px;border-radius:9999px")}</div></div></div></div></section></div></div></main>`;
}

/** The page's own CSS for the shell: what the app's classes cannot say (the width the sidebar was left at, the scheme's mark colours). */
function style(variant: BootShellVariant): string {
	const { min, max, default: initial } = SIDEBAR_WIDTH;
	const web =
		variant === "web"
			? // The web page has no `html[data-shell]` until its boot runs, and the traffic-light room is the desktop's:
				// a phone has no sidebar and a short bar, a narrow window no docked list.
				`.boot-shell .omp-sidebar-header{padding-left:var(--sc-space-3)}.boot-shell .omp-topbar{box-sizing:content-box;padding-top:env(safe-area-inset-top,0px)}@media (max-width:999px){.boot-sidebar{display:none}}@media (max-width:599px),(max-height:499px) and (orientation:landscape){.boot-shell .omp-topbar{height:36px;padding-inline:var(--sc-space-1)}.boot-shell .omp-composer-region.pb-3{padding-bottom:calc(var(--sc-space-1) + env(safe-area-inset-bottom,0px))}.boot-composer-box{height:${COMPOSER_BOX_PX.phone}px}}`
			: "";
	return `<style>.boot-shell{display:flex;position:fixed;inset:0;min-width:0}.boot-sidebar{width:clamp(${min}px,var(--boot-sidebar-w,${initial}px),${max}px)}.boot-shell .omp-workspace-main{background:var(--omp-bg-primary)}.boot-shell .omp-topbar{padding-right:calc(var(--sc-space-2) + var(--sc-caption-buttons))}.boot-composer-box{height:${COMPOSER_BOX_PX.desktop}px}.boot-ink{fill:${LIGHT.ink}}.boot-accent{fill:${LIGHT.accent}}[data-theme="dark"] .boot-ink{fill:${DARK.ink}}[data-theme="dark"] .boot-accent{fill:${DARK.accent}}${web}</style>`;
}

export function bootShell(variant: BootShellVariant): { style: string; html: string } {
	return { style: style(variant), html: `<div class="boot-shell">${sidebar()}${main()}</div>` };
}
