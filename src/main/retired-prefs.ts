/** Prefs whose switch was removed; `dropRetiredPrefs` deletes them so a stale value never lingers in prefs.json. */
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
];

export function dropRetiredPrefs(store: { delete(key: string): void }): void {
	for (const { key } of RETIRED_PREFS) store.delete(key);
}
