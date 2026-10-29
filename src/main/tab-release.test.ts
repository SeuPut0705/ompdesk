import { describe, expect, it } from "vitest";
import { closeWindowTab, type TabReleaseDeps } from "./tab-release";
import type { ClientWindow } from "./web/client-window";

const win = (id: number): ClientWindow => ({
	webContents: { id, send: () => undefined },
	isDestroyed: () => false,
	once: () => undefined,
	removeListener: () => undefined,
});

function rig(options: { owns?: boolean; viewer?: boolean; hosted?: boolean; duringExitPolicy?: () => void } = {}) {
	const steps: string[] = [];
	const deps: TabReleaseDeps = {
		sidecarPool: {
			sidecarForTab: (_win, tabId) => (options.owns === false ? null : ({ tabId } as never)),
			detachViewer: (_win, tabId) => {
				if (options.viewer) steps.push(`detach:${tabId}`);
				return options.viewer === true;
			},
			isHostedView: () => options.hosted === true,
			releaseTab: tabId => {
				steps.push(`release:${tabId}`);
				return true;
			},
		},
		worktreeLifecycle: {
			refreshExitPolicy: async tabId => {
				steps.push(`exit-policy:${tabId}`);
				await Promise.resolve();
				options.duringExitPolicy?.();
			},
		},
		closeTabTerminals: (windowId, tabId) => void steps.push(`terminals:${windowId}:${tabId}`),
	};
	return { deps, steps };
}

describe("closeWindowTab", () => {
	it("refreshes the worktree exit policy, closes the window's terminals, then releases the sidecar", async () => {
		const { deps, steps } = rig();
		expect(await closeWindowTab(deps, win(-1), "t1", -1)).toBe(true);
		expect(steps).toEqual(["exit-policy:t1", "terminals:-1:t1", "release:t1"]);
	});

	it("does nothing for a tab the window does not own", async () => {
		const { deps, steps } = rig({ owns: false });
		expect(await closeWindowTab(deps, win(-1), "t1", -1)).toBe(false);
		expect(steps).toEqual([]);
	});

	it("only leaves a tab another window owns", async () => {
		const { deps, steps } = rig({ viewer: true });
		expect(await closeWindowTab(deps, win(-1), "t1", -1)).toBe(true);
		expect(steps).toEqual(["detach:t1"]);
	});

	it("keeps a paired device's worktree out of it: terminals and release only", async () => {
		const { deps, steps } = rig({ hosted: true });
		expect(await closeWindowTab(deps, win(-1), "t1", -1)).toBe(true);
		expect(steps).toEqual(["terminals:-1:t1", "release:t1"]);
	});

	it("asks stillClosable again after the exit-policy read and keeps the tab when the answer changed meanwhile", async () => {
		let closable = true;
		const kept = rig({ duringExitPolicy: () => (closable = false) });
		expect(await closeWindowTab(kept.deps, win(-1), "t1", -1, () => closable)).toBe(false);
		expect(kept.steps).toEqual(["exit-policy:t1"]);
		const gone = rig();
		expect(await closeWindowTab(gone.deps, win(-1), "t1", -1, () => true)).toBe(true);
		expect(gone.steps).toEqual(["exit-policy:t1", "terminals:-1:t1", "release:t1"]);
	});
});
