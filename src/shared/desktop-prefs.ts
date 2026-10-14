/**
 * Preference keys main reads for desktop behaviour (Settings › General ›
 * Window), written by the renderer through `prefs.set`.
 */

/** Windows: closing the last window hides it to the tray instead of quitting (default off). */
export const CLOSE_TO_TRAY_PREF = "closeToTray";

/** Hold off system sleep while any tab on this computer runs a turn (default off). */
export const KEEP_AWAKE_WORKING_PREF = "keepAwakeWhileWorking";
