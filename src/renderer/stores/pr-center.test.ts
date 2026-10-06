/**
 * PR Center store contracts (plan/21): probe gates the list on repo
 * availability, select loads detail and clears per-file state, toggleFile
 * lazy-loads diffs per path (expand → loading → ready, collapse removes),
 * checkout routes the result into a worktree-bound openTab.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcResponse } from "../../shared/rpc-types";
import { usePrCenterStore } from "./pr-center";
import { useTabsStore } from "./tabs";

function ok(data: unknown): RpcResponse {
	return { type: "response", command: "test", success: true, data };
}
function fail(error: string, code?: string): RpcResponse {
	return { type: "response", command: "test", success: false, error, code };
}

const REPO = { available: true, repo: "acme/widgets", defaultBranch: "main" };
const LIST_ITEM = {
	number: 42,
	title: "Add widget",
	url: "https://github.com/acme/widgets/pull/42",
	isDraft: false,
	authorLogin: "zach",
	headRefName: "feat/widget",
	baseRefName: "main",
	additions: 10,
	deletions: 2,
	updatedAt: "2026-08-01T00:00:00Z",
	reviewDecision: null,
	checks: { success: 2, failure: 0, pending: 0 },
};

function installMockOmp() {
	const omp = {
		rpc: {
			prRepo: vi.fn(async () => ok(REPO)),
			prList: vi.fn(async () => ok([LIST_ITEM])),
			prGet: vi.fn(async () =>
				ok({
					number: 42,
					title: "Add widget",
					url: LIST_ITEM.url,
					isDraft: false,
					authorLogin: "zach",
					body: "body",
					baseRefName: "main",
					headRefName: "feat/widget",
					mergeStateStatus: "CLEAN",
					additions: 10,
					deletions: 2,
					reviewDecision: null,
					files: [{ path: "src/a.ts", changeType: "modified", additions: 10, deletions: 2 }],
					checks: [],
				}),
			),
			prDiff: vi.fn(async () => ok({ diff: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n" })),
			prCheckout: vi.fn(async () => ok({ path: "/wt/42-deadbeef", branch: "pr-42" })),
		},
		tabs: {
			list: vi.fn(async () => []),
			spawn: vi.fn(async () => ({ tabId: "t9" })),
			close: vi.fn(async () => true),
			setActive: vi.fn(async () => true),
		},
		events: { onTabStatus: vi.fn(() => () => {}) },
	};
	(globalThis as Record<string, unknown>).window = { omp } as unknown as Window;
	return omp;
}

beforeEach(() => {
	installMockOmp();
	usePrCenterStore.getState().reset();
	useTabsStore.setState({ tabs: [], activeTabId: null, bundles: new Map() });
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("pr-center store", () => {
	it("probe stores the repo and loads the list when available", async () => {
		await usePrCenterStore.getState().probe();
		expect(usePrCenterStore.getState().repo).toEqual(REPO);
		expect(usePrCenterStore.getState().list).toHaveLength(1);
	});

	it("probe does not list when the repo is unavailable", async () => {
		const omp = installMockOmp();
		omp.rpc.prRepo.mockResolvedValue(ok({ available: false, reason: "no_github_remote" }));
		await usePrCenterStore.getState().probe();
		const state = usePrCenterStore.getState();
		expect(state.list).toHaveLength(0);
		expect(omp.rpc.prList).not.toHaveBeenCalled();
	});

	it("select loads detail; toggleFile lazy-loads then removes the diff", async () => {
		await usePrCenterStore.getState().probe();
		await usePrCenterStore.getState().select(42);
		expect(usePrCenterStore.getState().detail?.number).toBe(42);

		await usePrCenterStore.getState().toggleFile("src/a.ts");
		const ready = usePrCenterStore.getState().expandedFiles["src/a.ts"];
		expect(ready && "diff" in ready && ready.diff).toContain("diff --git");

		await usePrCenterStore.getState().toggleFile("src/a.ts");
		expect(usePrCenterStore.getState().expandedFiles["src/a.ts"]).toBeUndefined();
	});

	it("select clears a previous selection's expanded files", async () => {
		await usePrCenterStore.getState().probe();
		await usePrCenterStore.getState().select(42);
		await usePrCenterStore.getState().toggleFile("src/a.ts");
		await usePrCenterStore.getState().select(42);
		expect(Object.keys(usePrCenterStore.getState().expandedFiles)).toHaveLength(0);
	});

	it("checkout opens a worktree-bound tab named pr-<N>", async () => {
		const spawn = installMockOmp().tabs.spawn;
		await usePrCenterStore.getState().probe();
		await usePrCenterStore.getState().checkout(42);
		expect(spawn).toHaveBeenCalledWith({
			cwd: "/wt/42-deadbeef",
			sessionPath: undefined,
			kind: "agent",
			worktree: { name: "pr-42", branch: "pr-42", baseCwd: "acme/widgets" },
		});
	});

	it("checkout failure toasts instead of spawning", async () => {
		const omp = installMockOmp();
		omp.rpc.prCheckout.mockResolvedValue(fail("boom", "pr_checkout_failed"));
		await usePrCenterStore.getState().probe();
		await usePrCenterStore.getState().checkout(42);
		expect(omp.tabs.spawn).not.toHaveBeenCalled();
	});
});
