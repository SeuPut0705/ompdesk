/**
 * Preference keys main reads for desktop behaviour (Settings › General ›
 * Window, Settings › Projects & launch › Worktrees), written by the renderer
 * through `prefs.set`.
 */

/** Windows: closing the last window hides it to the tray instead of quitting (default off). */
export const CLOSE_TO_TRAY_PREF = "closeToTray";

/** Hold off system sleep while any tab on this computer runs a turn (default off). */
export const KEEP_AWAKE_WORKING_PREF = "keepAwakeWhileWorking";

/** Remove orphaned agent worktrees (stock `omp worktree clear`) at launch and every 6 h (default off). */
export const WORKTREE_AUTO_CLEAN_PREF = "worktreeAutoClean";

/** Continue turns that were running when OMPdesk quit, crashed or restarted for an update (default on; only `false` turns it off). */
export const RESUME_INTERRUPTED_PREF = "resumeInterrupted";
