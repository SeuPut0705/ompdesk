import { describe, expect, it, vi } from "vitest";
import {
	closeNotifications,
	mountNotificationSweep,
	type NotificationRegistrationLike,
	tabNotificationTag,
} from "./notification-sweep";

function shown(tags: string[]) {
	const items = tags.map(tag => ({ tag, close: vi.fn() }));
	const registration: NotificationRegistrationLike = {
		getNotifications: vi.fn(async (filter?: { tag?: string }) =>
			items.filter(item => filter?.tag === undefined || item.tag === filter.tag),
		),
	};
	return { items, registration };
}

/** Let the chained promises of `closeNotifications` settle. */
async function flush(): Promise<void> {
	for (let turn = 0; turn < 10; turn++) await Promise.resolve();
}

describe("closeNotifications", () => {
	it("closes only the notifications with the tag, or all without one", async () => {
		const { items, registration } = shown(["tab:t1", "tab:t2", "batch"]);
		await closeNotifications(Promise.resolve(registration), tabNotificationTag("t1"));
		expect(items.map(item => item.close.mock.calls.length)).toEqual([1, 0, 0]);
		await closeNotifications(Promise.resolve(registration));
		expect(items.map(item => item.close.mock.calls.length)).toEqual([2, 1, 1]);
	});

	it("does nothing without a worker and never throws", async () => {
		await expect(closeNotifications(Promise.resolve(null))).resolves.toBeUndefined();
		const broken: NotificationRegistrationLike = {
			getNotifications: async () => {
				throw new Error("denied");
			},
		};
		await expect(closeNotifications(Promise.resolve(broken))).resolves.toBeUndefined();
	});
});

describe("mountNotificationSweep", () => {
	function setup(visible: boolean, tags: string[]) {
		const { items, registration } = shown(tags);
		const state = { visible };
		let onVisibility: () => void = () => {};
		let onActive: (tabId: string) => void = () => {};
		mountNotificationSweep({
			registration: Promise.resolve(registration),
			isVisible: () => state.visible,
			onVisibilityChange: listener => {
				onVisibility = listener;
			},
			onActiveTab: listener => {
				onActive = listener;
			},
		});
		return {
			items,
			closed: () => items.map(item => item.close.mock.calls.length),
			show: async () => {
				state.visible = true;
				onVisibility();
				await flush();
			},
			hide: () => {
				state.visible = false;
				onVisibility();
			},
			activate: async (tabId: string) => {
				onActive(tabId);
				await flush();
			},
		};
	}

	it("closes every notification when the page becomes visible, and not when it hides", async () => {
		const page = setup(false, ["tab:t1", "batch"]);
		await flush();
		expect(page.closed()).toEqual([0, 0]);
		await page.show();
		expect(page.closed()).toEqual([1, 1]);
		page.hide();
		await flush();
		expect(page.closed()).toEqual([1, 1]);
	});

	it("sweeps once when the page starts visible", async () => {
		const page = setup(true, ["tab:t1"]);
		await flush();
		expect(page.closed()).toEqual([1]);
	});

	it("closes a tab's notification when that tab becomes active on a visible page only", async () => {
		const page = setup(false, ["tab:t1", "tab:t2"]);
		await page.activate("t1");
		expect(page.closed()).toEqual([0, 0]);
		const visible = setup(true, ["tab:t1", "tab:t2"]);
		await flush();
		for (const item of visible.items) item.close.mockClear();
		await visible.activate("t2");
		expect(visible.closed()).toEqual([0, 1]);
	});
});
