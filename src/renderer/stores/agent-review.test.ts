import { afterEach, expect, it, vi } from "vitest";
import { useAgentReviewStore } from "./agent-review";

afterEach(() => {
	vi.unstubAllGlobals();
	useAgentReviewStore.getState().reset();
});

it("keeps the known list when the read fails (a paired host's link is down), never rejecting into the page", async () => {
	useAgentReviewStore.getState().apply({ tabId: "boss", items: [{ tabId: "kid" } as never] });
	vi.stubGlobal("window", {
		omp: { rpc: { commandForTab: vi.fn(async () => Promise.reject(new Error("The link to the computer dropped"))) } },
	});
	await expect(useAgentReviewStore.getState().refresh("boss")).resolves.toBeUndefined();
	expect(useAgentReviewStore.getState().byTab.boss).toEqual([{ tabId: "kid" }]);
});
