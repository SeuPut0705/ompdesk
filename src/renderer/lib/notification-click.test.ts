import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { type SessionTab, useTabsStore } from "../stores/tabs";
import { openNotifiedTab } from "./notification-click";

const tab = (id: string, ghost = false): SessionTab =>
	({ id, title: id, status: "ready", unreadDone: false, ...(ghost ? { ghost: true } : {}) }) as SessionTab;

const initial = useTabsStore.getState();
let switchTab: Mock<(id: string) => Promise<void>>;

beforeEach(() => {
	vi.useFakeTimers();
	switchTab = vi.fn(async (_id: string) => undefined);
	useTabsStore.setState({ tabs: [], activeTabId: null, switchTab });
});

afterEach(() => {
	openNotifiedTab("__reset__", 0);
	vi.runAllTimers();
	vi.useRealTimers();
	useTabsStore.setState(initial, true);
});

describe("openNotifiedTab", () => {
	it("brings a listed tab forward at once", () => {
		useTabsStore.setState({ tabs: [tab("a"), tab("b")], activeTabId: "a" });
		openNotifiedTab("b");
		expect(switchTab).toHaveBeenCalledWith("b");
	});

	it("waits through a cold start's ghost strip for the host's list, then opens the notified tab", () => {
		// The page the worker opened at `/#/open?tab=b`: the last run's ghosts, the old selection first.
		useTabsStore.setState({ tabs: [tab("a", true), tab("b", true)], activeTabId: "a" });
		openNotifiedTab("b");
		expect(switchTab).not.toHaveBeenCalled();
		useTabsStore.setState({ tabs: [tab("a"), tab("b")], activeTabId: "a" });
		expect(switchTab).toHaveBeenCalledTimes(1);
		expect(switchTab).toHaveBeenCalledWith("b");
		// Later list changes do not open it again.
		useTabsStore.setState({ tabs: [tab("a"), tab("b"), tab("c")] });
		expect(switchTab).toHaveBeenCalledTimes(1);
	});

	it("waits for a tab main has just added, which the page's list does not hold yet", () => {
		useTabsStore.setState({ tabs: [tab("a")], activeTabId: "a" });
		openNotifiedTab("new");
		expect(switchTab).not.toHaveBeenCalled();
		useTabsStore.setState({ tabs: [tab("a"), tab("new")] });
		expect(switchTab.mock.calls).toEqual([["new"]]);
	});

	it("drops a waiting click once the person picks another tab themselves", () => {
		useTabsStore.setState({ tabs: [tab("a"), tab("c")], activeTabId: "a" });
		openNotifiedTab("new");
		useTabsStore.setState({ activeTabId: "c" });
		useTabsStore.setState({ tabs: [tab("a"), tab("c"), tab("new")] });
		expect(switchTab).not.toHaveBeenCalled();
	});

	it("lets a later click replace a waiting one", () => {
		openNotifiedTab("a");
		openNotifiedTab("b");
		useTabsStore.setState({ tabs: [tab("a"), tab("b")], activeTabId: null });
		expect(switchTab.mock.calls).toEqual([["b"]]);
	});

	it("gives up when the list never comes", () => {
		openNotifiedTab("b", 1000);
		vi.advanceTimersByTime(1000);
		useTabsStore.setState({ tabs: [tab("b")] });
		expect(switchTab).not.toHaveBeenCalled();
	});
});
