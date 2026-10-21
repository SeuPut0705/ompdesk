/**
 * Preference keys main reads for desktop behaviour (Settings › General ›
 * Window, Settings › Projects & launch › Worktrees), written by the renderer
 * through `prefs.set`.
 */

/**
 * Closing the last window hides it instead of ending the app: to the tray on Windows, and on
 * macOS to the Dock, which brings the same window back (default on; only `false` keeps the quit on Windows).
 */
export const CLOSE_TO_TRAY_PREF = "closeToTray";

export function closeToTrayEnabled(stored: unknown): boolean {
	return stored !== false;
}

/** Set once the "keeps running in the tray" notice has been shown. */
export const CLOSE_TO_TRAY_NOTICE_PREF = "closeToTrayNoticeShown";

/**
 * Hold off system sleep while any tab on this computer runs a turn, and on a charging laptop keep the work running
 * through a lid close (src/main/power/lid-awake.ts). Default on; only a stored `false` turns it off.
 */
export const KEEP_AWAKE_WORKING_PREF = "keepAwakeWhileWorking";

/** Continue turns that were running when OMPdesk quit, crashed or restarted for an update (default on; only `false` turns it off). */
export const RESUME_INTERRUPTED_PREF = "resumeInterrupted";

/**
 * Install a downloaded OMPdesk update and restart by itself (Settings › Updates & about; default on, only a stored
 * `false` turns it off). With Continue interrupted work on it restarts at the next safe point, running work and all.
 */
export const APP_AUTO_UPDATE_PREF = "appAutoUpdate";

/**
 * Keep tools up to date (Settings › Updates & about; default on, only a stored `false` turns it off): omp itself
 * (`omp-updater.ts`), the tool CLIs of connected accounts (`cli-tools/`) and omp's extensions (`ext-update/`).
 * Replaced the three switches `ompAutoUpdate`, `cliAutoUpdate`, `extensionAutoUpdate` (`retired-prefs.ts`).
 */
export const TOOLS_AUTO_UPDATE_PREF = "toolsAutoUpdate";

/** A dev server's address in a bash result opens the Preview for the focused tab (default off; only `true` turns it on). */
export const AUTO_PREVIEW_DEV_SERVER_PREF = "autoPreviewDevServer";

/** A turn that edited files opens Changes at its end while the side panel is closed (default off; only `true` turns it on). */
export const AUTO_OPEN_CHANGES_PREF = "autoOpenChanges";
