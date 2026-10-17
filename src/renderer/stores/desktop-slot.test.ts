import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopSlotState } from "../../../resources/gui-bridge/desktop-slot-contracts";
import { FREE_SLOT, hydrateDesktopSlot, selectDesktopSlotPosition, useDesktopSlotStore } from "./desktop-slot";

const busy: DesktopSlotState = {
	holder: { tabId: "a", title: "Alpha", since: 1 },
	queue: [
		{ tabId: "b", title: "Beta" },
		{ tabId: "c", title: "Gamma" },
	],
};

function stubGetDesktopSlot(getDesktopSlot: () => Promise<unknown>): void {
	vi.stubGlobal("window", { omp: { rpc: { getDesktopSlot } } });
}

afterEach(() => {
	useDesktopSlotStore.getState().reset();
	vi.unstubAllGlobals();
});

describe("desktop slot store", () => {
	it("starts free and takes a whole state from a frame", () => {
		expect(useDesktopSlotStore.getState().state).toEqual(FREE_SLOT);
		useDesktopSlotStore.getState().apply(busy);
		expect(useDesktopSlotStore.getState().state).toBe(busy);
		expect(useDesktopSlotStore.getState().version).toBe(1);
	});

	it("lets a hydration in only when no frame arrived since it started", () => {
		const store = useDesktopSlotStore.getState();
		const startedAt = store.version;
		store.apply(busy);
		expect(store.hydrateIfCurrent(startedAt, FREE_SLOT)).toBe(false);
		expect(useDesktopSlotStore.getState().state).toBe(busy);
		expect(store.hydrateIfCurrent(useDesktopSlotStore.getState().version, FREE_SLOT)).toBe(true);
		expect(useDesktopSlotStore.getState().state).toBe(FREE_SLOT);
	});

	it("hydrates from the getDesktopSlot response's data", async () => {
		stubGetDesktopSlot(async () => ({ success: true, data: busy }));
		await hydrateDesktopSlot();
		expect(useDesktopSlotStore.getState().state).toBe(busy);
	});

	it("keeps a newer frame over a slow read", async () => {
		const { promise, resolve } = Promise.withResolvers<unknown>();
		stubGetDesktopSlot(() => promise);
		const pending = hydrateDesktopSlot();
		const frame: DesktopSlotState = { holder: { tabId: "z", title: "Zed", since: 2 }, queue: [] };
		useDesktopSlotStore.getState().apply(frame);
		resolve({ success: true, data: busy });
		await pending;
		expect(useDesktopSlotStore.getState().state).toBe(frame);
	});

	it("ignores a failed response and a failed read", async () => {
		stubGetDesktopSlot(async () => ({ success: false, error: "no" }));
		await hydrateDesktopSlot();
		expect(useDesktopSlotStore.getState().state).toEqual(FREE_SLOT);
		stubGetDesktopSlot(async () => {
			throw new Error("offline");
		});
		await hydrateDesktopSlot();
		expect(useDesktopSlotStore.getState().state).toEqual(FREE_SLOT);
	});

	it("reports a tab's 1-based place in the queue", () => {
		useDesktopSlotStore.getState().apply(busy);
		const state = useDesktopSlotStore.getState();
		expect(selectDesktopSlotPosition(state, "b")).toBe(1);
		expect(selectDesktopSlotPosition(state, "c")).toBe(2);
		expect(selectDesktopSlotPosition(state, "a")).toBeNull();
		expect(selectDesktopSlotPosition(state, null)).toBeNull();
	});
});
