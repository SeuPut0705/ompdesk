/**
 * F6 / Shift+F6 move the keyboard between the window's regions, as in a browser or an editor: the sidebar, the
 * focused session's transcript, its composer, its work board, the side panel. Tab walks every control on the way; F6
 * skips to the next region. A region not on screen (a folded sidebar, a closed panel, a board in its strip) is passed
 * over, and nothing moves while a dialog or menu is open (it holds the keyboard). Installed by App.
 */
import { isTabbable } from "../components/common/popover-focus";

const FOCUSABLE =
	'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface Region {
	/** The region's element, when it is on screen. */
	root: () => HTMLElement | null;
	/** Where focus lands in it: its own control or element, else its first tab stop. */
	target?: (root: HTMLElement) => HTMLElement | null;
}

const activePane = (): HTMLElement | null =>
	document.querySelector<HTMLElement>('.omp-session-pane[data-active="true"]') ??
	document.querySelector<HTMLElement>(".omp-session-pane");

const REGIONS: Region[] = [
	{
		root: () => document.querySelector<HTMLElement>("aside.omp-session-sidebar"),
		// The row the sidebar's roving focus rests on (the current session), so F6 lands where Tab would.
		target: root => root.querySelector<HTMLElement>('[data-roving-item][tabindex="0"]'),
	},
	{
		root: () => activePane()?.querySelector<HTMLElement>(".omp-transcript-scroll") ?? null,
		target: root => root,
	},
	{
		root: () => activePane()?.querySelector<HTMLElement>(".omp-composer-box") ?? null,
		target: root => root.querySelector<HTMLElement>("textarea[data-composer-input]"),
	},
	{ root: () => activePane()?.querySelector<HTMLElement>("[data-work-board-panel]") ?? null },
	{ root: () => document.querySelector<HTMLElement>("aside.omp-inspector") },
];

function shown(element: HTMLElement): boolean {
	return element.isConnected && element.getClientRects().length > 0 && isTabbable(element);
}

function landingIn(region: Region, root: HTMLElement): HTMLElement | null {
	const own = region.target?.(root);
	if (own && shown(own)) return own;
	return (
		Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).find(
			element => shown(element) && element.getAttribute("tabindex") !== "-1",
		) ?? null
	);
}

/** Whether a dialog, sheet or menu is open: it keeps the keyboard, F6 included. */
function overlayOpen(): boolean {
	return document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]') !== null;
}

/** Move focus to the next region (`1`) or the one before (`-1`); false when nothing moved. */
export function cycleRegion(direction: 1 | -1): boolean {
	if (overlayOpen()) return false;
	const regions = REGIONS.map(region => ({ region, root: region.root() })).filter(
		(entry): entry is { region: Region; root: HTMLElement } => entry.root !== null && shown(entry.root),
	);
	if (regions.length === 0) return false;
	const active = document.activeElement;
	const at = regions.findIndex(entry => active !== null && entry.root.contains(active));
	const n = regions.length;
	const start = at === -1 ? (direction === 1 ? -1 : n) : at;
	for (let step = 1; step <= n; step++) {
		const next = regions[(start + direction * step + 2 * n) % n];
		if (!next) continue;
		const target = landingIn(next.region, next.root);
		if (!target) continue;
		target.focus({ focusVisible: true } as FocusOptions);
		if (document.activeElement === target) return true;
	}
	return false;
}

/** The F6 handler for the window: Shift+F6 goes back. Modified F6 is left to the OS and the keymap. */
export function handleRegionKey(event: KeyboardEvent): void {
	if (event.key !== "F6" || event.ctrlKey || event.altKey || event.metaKey || event.defaultPrevented) return;
	if (cycleRegion(event.shiftKey ? -1 : 1)) event.preventDefault();
}
