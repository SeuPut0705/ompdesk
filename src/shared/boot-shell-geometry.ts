/**
 * The numbers the first-paint shell (scripts/boot-shell.ts, written into index.html and web.html) shares with the
 * React layout, in one place so neither drifts: the sidebar's width range and the key its width is mirrored under for
 * pre-paint.js, and the composer box's height.
 */

/** The docked sidebar's width range and its first-run width (Sidebar.tsx drags within it). */
export const SIDEBAR_WIDTH = { min: 220, max: 420, default: 248 } as const;

/** localStorage mirror of the `sidebarWidth` pref: prefs arrive over IPC, this is readable before the first paint. */
export const SIDEBAR_WIDTH_STORAGE_KEY = "omp.sidebarWidth";

/** The idle composer box: 1px border, the input line and the toolbar (measured against the React box by e2e/no-loading.e2e.ts); the phone's always-open box (the field row over its one controls row) is shorter. */
export const COMPOSER_BOX_PX = { desktop: 92, phone: 77 } as const;
