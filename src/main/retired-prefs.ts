import { TOOLS_AUTO_UPDATE_PREF } from "../shared/desktop-prefs";

/** The prefs store as electron-store offers it: a dotted key names a nested value. */
interface PrefsLike {
	get(key: string): unknown;
	set(key: string, value: unknown): void;
	has(key: string): boolean;
	delete(key: string): void;
}

/**
 * Switches merged into one: the old values decide the new one once, before `RETIRED_PREFS` deletes them. A new
 * value already stored wins, so a later launch changes nothing.
 */
const MERGES: readonly { into: string; from: readonly string[]; value: (old: unknown[]) => unknown }[] = [
	{
		into: TOOLS_AUTO_UPDATE_PREF,
		from: ["ompAutoUpdate", "cliAutoUpdate", "extensionAutoUpdate"],
		// On by default: off only when every one of the three had been turned off.
		value: old => (old.every(value => value === false) ? false : undefined),
	},
	{
		into: "mobileWeb.confirmNewDevices",
		from: ["mobileWeb.confirmNewDevices", "remote.confirmNewDevices"],
		value: old => (old.some(value => value === true) ? true : undefined),
	},
];

/** Prefs whose switch was removed; `migrateRetiredPrefs` deletes them so a stale value never lingers in prefs.json. */
export const RETIRED_PREFS: readonly { key: string; why: string }[] = [
	{
		key: "modelPool",
		why: "The model pool was removed. The journal's `ompdesk.model-pool` entries stay in old sessions and are ignored.",
	},
	{
		key: "worktreeAutoClean",
		why: "Agent worktrees are swept by OMPdesk's own landed rule, always (worktree-orphans.ts); the switch that ran stock's `omp worktree clear` on a timer is gone.",
	},
	{
		key: "batchNotifications",
		why: "Desktop notifications and Web Push always batch (notification-batch.ts); the switch is gone.",
	},
	{
		key: "scheduledRetry",
		why: "The scheduled retry follows stock `retry.enabled` alone (turn-resume.ts); the switch is gone.",
	},
	{
		key: "autopilotShip",
		why: "Autopilot shipping nobody picked is decided per repository at each start (src/main/autopilot.ts); other levels are picked per run in the start sheet.",
	},
	{
		key: "autopilotNotify",
		why: "An Autopilot run notifies its stops, end and releases under the app's own notifications switch, never each cycle.",
	},
	{
		key: "autopilotBranch",
		why: "The Autopilot sheet shows only the folder's own branch (the run cuts its own from it); the remembered choice per repository is gone.",
	},
	...["ompAutoUpdate", "cliAutoUpdate", "extensionAutoUpdate"].map(key => ({
		key,
		why: "One switch, `toolsAutoUpdate`, keeps omp, tool CLIs and extensions up to date (MERGES above).",
	})),
	{
		key: "remote.confirmNewDevices",
		why: "One switch, `mobileWeb.confirmNewDevices`, asks before a new phone or computer connects (MERGES above).",
	},
	{
		key: "displayPreferences.titleState",
		why: "The run state in the window title is always shown.",
	},
	{
		key: "displayPreferences.showProgress",
		why: "Run progress on the Dock or taskbar icon is always shown.",
	},
	{
		key: "workBoard",
		why: "The work board docks whenever the pane has room (`workBoardFits`); its ✕ hides it for that window only.",
	},
];

/**
 * Side panel views the panel no longer holds (21 Oct 2026: they open as sheets, live on the work board, Settings ›
 * Memory or the composer's queue popover). A default view among them is forgotten (the panel opens on Changes) and
 * their `panel.<view>` shortcuts are dropped from `keymapOverrides`. Its keys hold dots, so the object is rewritten
 * whole: a dotted path would name a nested value.
 */
const RETIRED_PANEL_VIEWS = ["jobs", "plan", "logs", "queue", "tree", "work", "memory"];

function retirePanelViews(store: PrefsLike): void {
	if (RETIRED_PANEL_VIEWS.includes(store.get("defaultPanelTab") as string)) store.delete("defaultPanelTab");
	const overrides = store.get("keymapOverrides");
	if (!overrides || typeof overrides !== "object") return;
	const kept = Object.fromEntries(
		Object.entries(overrides).filter(([id]) => !RETIRED_PANEL_VIEWS.some(view => id === `panel.${view}`)),
	);
	if (Object.keys(kept).length !== Object.keys(overrides).length) store.set("keymapOverrides", kept);
}

export function migrateRetiredPrefs(store: PrefsLike): void {
	for (const merge of MERGES) {
		if (store.has(merge.into) && !merge.from.includes(merge.into)) continue;
		const value = merge.value(merge.from.map(key => store.get(key)));
		if (value !== undefined) store.set(merge.into, value);
	}
	for (const { key } of RETIRED_PREFS) store.delete(key);
	retirePanelViews(store);
}
