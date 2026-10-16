/**
 * The shell mode of a web page (mobile web, design §6.1): which of the three layouts the window gets and
 * whether touch is the main input. It only exists in the web build (`html[data-platform="web"]`, set by the
 * page's boot before React mounts) or behind an explicit dev flag; an Electron window keeps `null` — the
 * desktop layout and its compact rules — however narrow it is made.
 *
 *   phone             width < 600, or a short landscape window (height < 500)
 *   tablet-portrait   not a phone, width < 1000 (the old COMPACT_SHELL_QUERY)
 *   tablet-landscape  width ≥ 1000: the docked desktop layout
 *
 * While mounted, `useShellMode()` mirrors the answer onto `<html data-shell data-input>` (and tracks the
 * on-screen keyboard into `--kb-inset`, long presses into `contextmenu`, the back gesture into sheet closing),
 * so CSS and code branch on one source.
 *
 * Dev flag: `?shell=1` (or `localStorage["omp.shell"] = "1"`) turns the mode on in any browser or window;
 * `?shell=phone|tablet-portrait|tablet-landscape` also pins the mode, `?input=touch|mouse` the input.
 */

import { useEffect, useSyncExternalStore } from "react";
import { startBackLayers } from "../lib/back-layer";
import { startKeyboardInset } from "../lib/keyboard-inset";
import { startLongPressMenu } from "../lib/long-press-menu";

export type ShellMode = "phone" | "tablet-portrait" | "tablet-landscape";
export type ShellInput = "touch" | "mouse";

export const SHELL_MODES: readonly ShellMode[] = ["phone", "tablet-portrait", "tablet-landscape"];

export const PHONE_QUERY = "(max-width: 599px), (max-height: 499px) and (orientation: landscape)";
export const TABLET_PORTRAIT_QUERY = "(max-width: 999px)";
export const TOUCH_QUERY = "(pointer: coarse)";
const QUERIES = [PHONE_QUERY, TABLET_PORTRAIT_QUERY, TOUCH_QUERY] as const;

const DEV_KEY = "omp.shell";

/** The mode the two width queries give; pure so the breakpoints are testable. */
export function shellModeFor(phone: boolean, narrow: boolean): ShellMode {
	return phone ? "phone" : narrow ? "tablet-portrait" : "tablet-landscape";
}

interface Snapshot {
	mode: ShellMode | null;
	input: ShellInput | null;
}

const DESKTOP: Snapshot = { mode: null, input: null };

/** The URL and storage do not change under a page: read once (tests call `resetShellModeForTests`). */
let devParams: { shell: string | null; input: string | null } | undefined;

function dev(): { shell: string | null; input: string | null } {
	if (devParams) return devParams;
	try {
		const query = new URLSearchParams(window.location.search);
		devParams = { shell: query.get("shell") ?? window.localStorage.getItem(DEV_KEY), input: query.get("input") };
	} catch {
		devParams = { shell: null, input: null };
	}
	return devParams;
}

/** Whether this window uses the mobile shell at all: the web build, or the dev flag. */
export function shellActive(): boolean {
	if (typeof document === "undefined") return false;
	if (document.documentElement.dataset.platform === "web") return true;
	const flag = dev().shell;
	return flag !== null && flag !== "" && flag !== "0" && flag !== "off";
}

function matches(query: string): boolean {
	return typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

function compute(): Snapshot {
	if (!shellActive()) return DESKTOP;
	const { shell, input } = dev();
	const mode =
		SHELL_MODES.find(candidate => candidate === shell) ??
		shellModeFor(matches(PHONE_QUERY), matches(TABLET_PORTRAIT_QUERY));
	return { mode, input: input === "touch" || input === "mouse" ? input : matches(TOUCH_QUERY) ? "touch" : "mouse" };
}

// One set of media listeners for the whole app, however many components read the mode (tooltips are everywhere).
const listeners = new Set<() => void>();
let attached: Snapshot | null = null;
let detach: (() => void) | null = null;

function refresh(): void {
	const next = compute();
	if (attached && attached.mode === next.mode && attached.input === next.input) return;
	attached = next;
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	if (listeners.size === 1) {
		attached = compute();
		if (typeof window.matchMedia === "function") {
			const lists = QUERIES.map(query => window.matchMedia(query));
			for (const list of lists) list.addEventListener("change", refresh);
			detach = () => {
				for (const list of lists) list.removeEventListener("change", refresh);
			};
		}
	}
	return () => {
		listeners.delete(listener);
		if (listeners.size > 0) return;
		detach?.();
		detach = null;
		attached = null;
	};
}

function snapshot(): Snapshot {
	return attached ?? compute();
}

/** The current mode, read now; null outside the web build. */
export function currentShellMode(): ShellMode | null {
	return snapshot().mode;
}

export function currentShellInput(): ShellInput | null {
	return snapshot().input;
}

/** Most panes a split view may hold: a docked tablet fits two (each ≥ 480 px), a desktop window four. */
export function maxSplitPanes(): number {
	return currentShellMode() === "tablet-landscape" ? 2 : 4;
}

/** The shell's mode, live; null in an Electron window (desktop layout). */
export function useShellMode(): ShellMode | null {
	const mode = useSyncExternalStore(subscribe, currentShellMode, () => null);
	useEffect(retainShell, []);
	return mode;
}

/** `touch` where the primary pointer is coarse; null outside the web build. */
export function useShellInput(): ShellInput | null {
	return useSyncExternalStore(subscribe, currentShellInput, () => null);
}

/**
 * Whether the side panel is a modal sheet instead of docked. In an Electron window this is the old compact
 * rule (narrower than 1000 px); in the web build it follows the mode, so a short landscape phone that is wider
 * than 1000 px still gets the phone's full-screen sheet.
 */
export function useCompactShell(): boolean {
	return useSyncExternalStore(
		subscribe,
		() => {
			const mode = currentShellMode();
			return mode === null ? matches(TABLET_PORTRAIT_QUERY) : mode !== "tablet-landscape";
		},
		() => false,
	);
}

/** Phone and tablet portrait keep the session list in a drawer; a landscape tablet docks it. */
export function isDrawerMode(mode: ShellMode | null): boolean {
	return mode === "phone" || mode === "tablet-portrait";
}

export function applyShellAttributes(root: HTMLElement = document.documentElement): void {
	const { mode, input } = snapshot();
	if (mode === null || input === null) {
		delete root.dataset.shell;
		delete root.dataset.input;
		return;
	}
	if (root.dataset.shell !== mode) root.dataset.shell = mode;
	if (root.dataset.input !== input) root.dataset.input = input;
}

let retained = 0;
let stopAll: (() => void) | null = null;

/** Keep `html[data-shell|data-input]` current while something uses the shell mode; the last release clears them. */
function retainShell(): () => void {
	retained += 1;
	if (retained === 1 && shellActive()) {
		applyShellAttributes();
		const unsubscribe = subscribe(applyAttributes);
		const stops = [startKeyboardInset(), startLongPressMenu(), startBackLayers()];
		stopAll = () => {
			unsubscribe();
			for (const stop of stops) stop();
		};
	}
	return () => {
		retained -= 1;
		if (retained > 0) return;
		stopAll?.();
		stopAll = null;
		const root = document.documentElement;
		delete root.dataset.shell;
		delete root.dataset.input;
	};
}

function applyAttributes(): void {
	applyShellAttributes();
}

/** Tests: forget the cached dev flag and any attached listeners. */
export function resetShellModeForTests(): void {
	devParams = undefined;
	attached = null;
	if (listeners.size === 0) detach = null;
}
