/**
 * Closing the system notifications a page no longer needs. The host never pushes to a device whose socket is
 * visible, not even a `clear`, so a banner left from earlier (the page was hidden when it came) is closed here:
 * all of them when the page becomes visible, and a tab's (`tab:<id>`, the host's tag, see web-push-notifier.ts)
 * when that tab becomes the active one on a visible page.
 */

export interface ClosableNotification {
	close(): void;
}

export interface NotificationRegistrationLike {
	getNotifications(filter?: { tag?: string }): Promise<readonly ClosableNotification[]>;
}

/** The tag the host puts on a tab's notification. */
export function tabNotificationTag(tabId: string): string {
	return `tab:${tabId}`;
}

/** Close the notifications with `tag`, or every one without it. Never throws (no permission, no worker). */
export async function closeNotifications(
	registration: Promise<NotificationRegistrationLike | null>,
	tag?: string,
): Promise<void> {
	try {
		const target = await registration;
		if (!target) return;
		for (const shown of await target.getNotifications(tag === undefined ? undefined : { tag })) shown.close();
	} catch {
		// A banner that stays is better than a page error.
	}
}

export interface SweepDeps {
	registration: Promise<NotificationRegistrationLike | null>;
	isVisible: () => boolean;
	/** Run on every visibility change of the page. */
	onVisibilityChange: (listener: () => void) => void;
	/** Run with the id of each tab that becomes the active one (not the one active when this is called). */
	onActiveTab: (listener: (tabId: string) => void) => void;
}

/** Wire the two triggers; the page being visible when it starts also sweeps once. */
export function mountNotificationSweep(deps: SweepDeps): void {
	const sweepAll = () => {
		if (deps.isVisible()) void closeNotifications(deps.registration);
	};
	deps.onVisibilityChange(sweepAll);
	deps.onActiveTab(tabId => {
		if (deps.isVisible()) void closeNotifications(deps.registration, tabNotificationTag(tabId));
	});
	sweepAll();
}
