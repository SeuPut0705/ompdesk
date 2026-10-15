import { afterEach, describe, expect, it, vi } from "vitest";
import { PREFS_BOOT_RETRY_MS } from "../lib/prefs-read";
import { QUOTA_RESUME_PREF, useQuotaResumeStore } from "./quota-resume";

const get = vi.fn(async (_key: string) => undefined as unknown);
const set = vi.fn(async (_key: string, _value: unknown) => {});
(globalThis as Record<string, unknown>).window = { omp: { prefs: { get, set } } };

afterEach(() => {
	vi.useRealTimers();
	get.mockReset();
	set.mockReset();
	useQuotaResumeStore.getState().reset();
});

/** The boot read against a failing prefs bridge, through every bounded retry. */
async function failBootRead(): Promise<void> {
	vi.useFakeTimers();
	get.mockRejectedValue(new Error("io"));
	const loading = useQuotaResumeStore.getState().load();
	await vi.advanceTimersByTimeAsync(60_000);
	await loading;
}

describe("quota resume bookings with unreadable prefs", () => {
	it("stays unloaded after a failed read and retries a bounded number of times", async () => {
		await failBootRead();
		expect(useQuotaResumeStore.getState().loaded).toBe(false);
		expect(get).toHaveBeenCalledTimes(1 + PREFS_BOOT_RETRY_MS.length);

		get.mockResolvedValue({ "s-stored": 5_000 });
		await useQuotaResumeStore.getState().load();
		expect(useQuotaResumeStore.getState().loaded).toBe(true);
		expect(useQuotaResumeStore.getState().reservations).toEqual({ "s-stored": 5_000 });
		expect(set).not.toHaveBeenCalled();
	});

	it("never writes a booking over the stored ones after a failed read", async () => {
		await failBootRead();

		useQuotaResumeStore.getState().reserve("s-new", 9_000);
		useQuotaResumeStore.getState().cancel("s-new");
		await vi.advanceTimersByTimeAsync(0);

		expect(set).not.toHaveBeenCalled();
		expect(useQuotaResumeStore.getState().loaded).toBe(false);
	});

	it("reads again before writing and saves the new booking merged with the stored ones", async () => {
		await failBootRead();
		get.mockResolvedValueOnce({ "s-stored": 5_000 });

		useQuotaResumeStore.getState().reserve("s-new", 9_000);
		// The booking is held at once; the write waits for the stored bookings.
		expect(useQuotaResumeStore.getState().reservations).toEqual({ "s-new": 9_000 });
		expect(set).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(0);

		expect(useQuotaResumeStore.getState().reservations).toEqual({ "s-stored": 5_000, "s-new": 9_000 });
		expect(set).toHaveBeenCalledTimes(1);
		expect(set).toHaveBeenCalledWith(QUOTA_RESUME_PREF, { "s-stored": 5_000, "s-new": 9_000 });
	});

	it("keeps a booking cancelled before the read from coming back with the stored ones", async () => {
		await failBootRead();
		get.mockResolvedValueOnce({ "s-gone": 5_000, "s-kept": 6_000 });

		useQuotaResumeStore.setState({ reservations: { "s-gone": 5_000 } });
		useQuotaResumeStore.getState().cancel("s-gone");
		await vi.advanceTimersByTimeAsync(0);

		expect(useQuotaResumeStore.getState().reservations).toEqual({ "s-kept": 6_000 });
		expect(set).toHaveBeenCalledWith(QUOTA_RESUME_PREF, { "s-kept": 6_000 });
	});

	it("writes at once once the bookings are loaded", async () => {
		get.mockResolvedValue({ "s-stored": 5_000 });
		await useQuotaResumeStore.getState().load();
		useQuotaResumeStore.getState().reserve("s-new", 9_000);
		expect(set).toHaveBeenCalledWith(QUOTA_RESUME_PREF, { "s-stored": 5_000, "s-new": 9_000 });
		useQuotaResumeStore.getState().cancel("s-new");
		useQuotaResumeStore.getState().cancel("s-stored");
		expect(set).toHaveBeenLastCalledWith(QUOTA_RESUME_PREF, undefined);
	});
});
