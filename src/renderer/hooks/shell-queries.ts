/**
 * The web shell's breakpoints (hooks/use-shell-mode.ts has the live mode). A module with no imports, so the web page's
 * boot can ask them before the app loads (web/web-boot.ts: whether the first frame has a docked session list).
 */

export type ShellMode = "phone" | "tablet-portrait" | "tablet-landscape";

export const SHELL_MODES: readonly ShellMode[] = ["phone", "tablet-portrait", "tablet-landscape"];

export const PHONE_QUERY = "(max-width: 599px), (max-height: 499px) and (orientation: landscape)";
export const TABLET_PORTRAIT_QUERY = "(max-width: 999px)";
export const TOUCH_QUERY = "(pointer: coarse)";
/** A portrait tablet at least this wide docks the session list instead of a drawer. */
export const TABLET_DOCK_QUERY = "(min-width: 800px)";

/** The mode the two width queries give; pure so the breakpoints are testable. */
export function shellModeFor(phone: boolean, narrow: boolean): ShellMode {
	return phone ? "phone" : narrow ? "tablet-portrait" : "tablet-landscape";
}

/** Phone and tablet portrait keep the session list in a drawer; a landscape tablet docks it. */
export function isDrawerMode(mode: ShellMode | null): boolean {
	return mode === "phone" || mode === "tablet-portrait";
}

/** Whether a web page that `matches` these queries keeps its session list in a drawer (no dev flag asked). */
export function sessionListInDrawer(matches: (query: string) => boolean): boolean {
	const mode = shellModeFor(matches(PHONE_QUERY), matches(TABLET_PORTRAIT_QUERY));
	return isDrawerMode(mode) && !(mode === "tablet-portrait" && matches(TABLET_DOCK_QUERY));
}
