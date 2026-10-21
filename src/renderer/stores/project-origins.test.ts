/**
 * A folder's origin lookup that failed (the computer restarting, a dropped link) is asked again by itself and never
 * reads as "git cannot place it", which would show a worktree as a removed folder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectOrigin } from "../../shared/project-origin";
import { RETRY_FAILED_MS, useProjectOrigins } from "./project-origins";

const WORKTREE = "/wt/2026-10-21-c1-tests";
const ORIGIN: ProjectOrigin = {
	project: "app",
	root: "/repo/app",
	worktree: { kind: "autopilot", branch: "autopilot/2026-10-21-c1-tests", slug: "2026-10-21-c1-tests" },
};

const get = vi.fn<(cwds: readonly string[]) => Promise<Record<string, ProjectOrigin | null>>>();

beforeEach(() => {
	vi.useFakeTimers();
	Object.assign(globalThis, { window: { omp: { projectOrigins: { get } } } });
});

afterEach(() => {
	useProjectOrigins.getState().reset();
	get.mockReset();
	vi.useRealTimers();
});

describe("project origins", () => {
	it("asks again by itself after a failed lookup, and never records the folder as unknown meanwhile", async () => {
		get.mockRejectedValueOnce(new Error("remote_offline"));
		get.mockResolvedValueOnce({ [WORKTREE]: ORIGIN });
		useProjectOrigins.getState().request([WORKTREE]);
		await vi.advanceTimersByTimeAsync(0);
		expect(useProjectOrigins.getState().origins[WORKTREE]).toBeUndefined();
		// No render asks again; the retry does.
		await vi.advanceTimersByTimeAsync(RETRY_FAILED_MS);
		expect(get).toHaveBeenCalledTimes(2);
		expect(useProjectOrigins.getState().origins[WORKTREE]).toEqual(ORIGIN);
	});

	it("keeps what it knew when a later lookup fails", async () => {
		get.mockResolvedValueOnce({ [WORKTREE]: ORIGIN });
		useProjectOrigins.getState().request([WORKTREE]);
		await vi.advanceTimersByTimeAsync(0);
		get.mockRejectedValueOnce(new Error("remote_offline"));
		useProjectOrigins.getState().recheck([WORKTREE]);
		await vi.advanceTimersByTimeAsync(0);
		expect(useProjectOrigins.getState().origins[WORKTREE]).toEqual(ORIGIN);
	});
});
