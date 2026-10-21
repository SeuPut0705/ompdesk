import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	reconcileTabs: vi.fn<(options?: { dropUnlisted?: boolean }) => Promise<boolean>>(),
	state: {
		activeTabId: "a" as string | null,
		tabs: [] as { id: string; status: string }[],
	},
	visible: ["a"] as string[],
	hydrateTabSession: vi.fn(async (_tabId: string) => {}),
	settle: vi.fn(),
	restore: vi.fn(),
	loadRemoteState: vi.fn(async () => {}),
	refreshHeldSessionLists: vi.fn(),
	refreshReview: vi.fn(async (_tabId: string) => {}),
}));

vi.mock("../stores/tabs", () => ({
	useTabsStore: { getState: () => ({ ...mocks.state, reconcileTabs: mocks.reconcileTabs }) },
	visibleTabIds: () => mocks.visible,
	settleTabExtensionUiRequests: mocks.settle,
	restoreTabExtensionUiRequests: mocks.restore,
}));
vi.mock("../hooks/session-hydration", () => ({ hydrateTabSession: mocks.hydrateTabSession }));
vi.mock("../stores/remote", () => ({ loadRemoteState: mocks.loadRemoteState }));
vi.mock("../stores/session-list", () => ({ refreshHeldSessionLists: mocks.refreshHeldSessionLists }));
vi.mock("../stores/agent-review", () => ({
	useAgentReviewStore: { getState: () => ({ refresh: mocks.refreshReview }) },
}));

const { resyncPage } = await import("./resync-page");

const openRequests = vi.fn(async () => [{ tabId: "a", request: { id: "ask-1" } }]);
const shownState = vi.fn(async () => [{ tabId: "a", request: { id: "status-1", method: "setStatus" } }]);

beforeEach(() => {
	vi.clearAllMocks();
	(globalThis as { window?: unknown }).window = { omp: { ui: { openRequests, shownState } } };
	mocks.reconcileTabs.mockResolvedValue(true);
	mocks.state.tabs = [
		{ id: "a", status: "running" },
		{ id: "b", status: "ready" },
		{ id: "c", status: "error" },
		{ id: "d", status: "running" },
	];
	mocks.visible = ["a", "b", "c"];
});

describe("resyncPage (one in-place catch-up pass after a reconnect that missed events)", () => {
	it("takes the host's tab list as the whole truth, then re-reads every visible live tab, the asks and the snapshots", async () => {
		expect(await resyncPage()).toBe(true);
		expect(mocks.reconcileTabs).toHaveBeenCalledWith({ dropUnlisted: true });
		// Visible and ready or running: a mid-reply tab merges what it missed; an errored one and a background tab
		// (which reads its own when shown) are left alone.
		expect(mocks.hydrateTabSession.mock.calls.map(call => call[0])).toEqual(["a", "b"]);
		expect(mocks.settle).toHaveBeenCalledWith([{ tabId: "a", request: { id: "ask-1" } }]);
		// The status texts, widgets and title the host's tabs show: the missed frames that set them are not repeated.
		expect(mocks.restore).toHaveBeenCalledWith([{ tabId: "a", request: { id: "status-1", method: "setStatus" } }]);
		expect(mocks.loadRemoteState).toHaveBeenCalledOnce();
		expect(mocks.refreshHeldSessionLists).toHaveBeenCalledOnce();
		// The sessions each shown tab opened: main's pushes of that list went down with the socket.
		expect(mocks.refreshReview.mock.calls.map(call => call[0])).toEqual(["a", "b", "c"]);
	});

	it("fails without reading anything else when the host cannot list the tabs (the link dropped again)", async () => {
		mocks.reconcileTabs.mockResolvedValue(false);
		expect(await resyncPage()).toBe(false);
		expect(mocks.hydrateTabSession).not.toHaveBeenCalled();
		expect(openRequests).not.toHaveBeenCalled();
		expect(mocks.settle).not.toHaveBeenCalled();
	});

	it("fails when a read throws, so the pass is tried again", async () => {
		openRequests.mockRejectedValueOnce(new Error("The link to the computer dropped"));
		await expect(resyncPage()).rejects.toThrow("dropped");
		expect(mocks.settle).not.toHaveBeenCalled();
	});
});
