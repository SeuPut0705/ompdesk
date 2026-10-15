import { afterEach, describe, expect, it, vi } from "vitest";
import { PREFS_BOOT_RETRY_MS } from "../lib/prefs-read";
import { STARTER_GUIDE_PREF, useStarterGuideStore } from "./starter-guide";

const get = vi.fn(async (_key: string) => undefined as unknown);
const set = vi.fn(async (_key: string, _value: unknown) => {});
(globalThis as Record<string, unknown>).window = { omp: { prefs: { get, set } } };

afterEach(() => {
	vi.useRealTimers();
	get.mockReset();
	set.mockReset();
	useStarterGuideStore.getState().reset();
});

/** The boot read against a failing prefs bridge, through every bounded retry. */
async function failBootRead(): Promise<void> {
	vi.useFakeTimers();
	get.mockRejectedValue(new Error("io"));
	const loading = useStarterGuideStore.getState().load();
	await vi.advanceTimersByTimeAsync(60_000);
	await loading;
}

describe("starter guide with unreadable prefs", () => {
	it("stays unloaded after a failed read and retries a bounded number of times", async () => {
		await failBootRead();
		expect(useStarterGuideStore.getState().loaded).toBe(false);
		expect(get).toHaveBeenCalledTimes(1 + PREFS_BOOT_RETRY_MS.length);
		expect(set).not.toHaveBeenCalled();

		get.mockResolvedValue({ done: ["model"], dismissed: false });
		await useStarterGuideStore.getState().load();
		expect(useStarterGuideStore.getState().loaded).toBe(true);
		expect(useStarterGuideStore.getState().done).toEqual(["model"]);
	});

	it("never writes a step or a dismissal over the stored guide after a failed read", async () => {
		await failBootRead();

		useStarterGuideStore.getState().dismiss();
		useStarterGuideStore.getState().complete(["prompt"]);
		await vi.advanceTimersByTimeAsync(0);

		expect(set).not.toHaveBeenCalled();
		expect(useStarterGuideStore.getState().loaded).toBe(false);
	});

	it("reads again before writing and saves the change merged with the stored guide", async () => {
		await failBootRead();
		get.mockResolvedValueOnce({ done: ["model", "split"], dismissed: false });

		useStarterGuideStore.getState().dismiss();
		useStarterGuideStore.getState().complete(["prompt"]);
		await vi.advanceTimersByTimeAsync(0);

		expect(useStarterGuideStore.getState().loaded).toBe(true);
		expect(useStarterGuideStore.getState().done).toEqual(["model", "prompt", "split"]);
		expect(set).toHaveBeenCalledTimes(1);
		expect(set).toHaveBeenCalledWith(STARTER_GUIDE_PREF, { done: ["model", "prompt", "split"], dismissed: true });
	});

	it("writes at once once the guide is loaded", async () => {
		get.mockResolvedValue({ done: ["model"], dismissed: false });
		await useStarterGuideStore.getState().load();
		useStarterGuideStore.getState().complete(["prompt"]);
		expect(set).toHaveBeenCalledWith(STARTER_GUIDE_PREF, { done: ["model", "prompt"], dismissed: false });
	});
});
