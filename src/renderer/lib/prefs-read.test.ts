import { afterEach, describe, expect, it, vi } from "vitest";
import { readPref } from "./prefs-read";

const get = vi.fn(async (_key: string) => null as unknown);
(globalThis as Record<string, unknown>).window = { omp: { prefs: { get } } };

afterEach(() => {
	get.mockReset();
	vi.useRealTimers();
});

describe("readPref", () => {
	it("returns the stored value, including an empty one", async () => {
		get.mockResolvedValueOnce({ a: 1 });
		expect(await readPref("k")).toEqual({ ok: true, value: { a: 1 } });
		get.mockResolvedValueOnce(undefined);
		expect(await readPref("k")).toEqual({ ok: true, value: undefined });
		expect(get).toHaveBeenCalledWith("k");
	});

	it("reports a failed read as unknown, not empty, and makes one attempt without delays", async () => {
		get.mockRejectedValue(new Error("ipc"));
		expect(await readPref("k")).toEqual({ ok: false });
		expect(get).toHaveBeenCalledTimes(1);
	});

	it("retries after each delay, then gives up", async () => {
		vi.useFakeTimers();
		get.mockRejectedValue(new Error("ipc"));
		const read = readPref("k", [100, 200]);
		await vi.advanceTimersByTimeAsync(99);
		expect(get).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(get).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(200);
		expect(get).toHaveBeenCalledTimes(3);
		expect(await read).toEqual({ ok: false });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(get).toHaveBeenCalledTimes(3);
	});

	it("stops retrying at the first success", async () => {
		vi.useFakeTimers();
		get.mockRejectedValueOnce(new Error("ipc")).mockResolvedValueOnce("stored");
		const read = readPref("k", [100, 200]);
		await vi.advanceTimersByTimeAsync(100);
		expect(await read).toEqual({ ok: true, value: "stored" });
		expect(get).toHaveBeenCalledTimes(2);
	});

	it("treats a missing prefs bridge as a failed read", async () => {
		const saved = (globalThis as Record<string, unknown>).window;
		(globalThis as Record<string, unknown>).window = {};
		try {
			expect(await readPref("k")).toEqual({ ok: false });
		} finally {
			(globalThis as Record<string, unknown>).window = saved;
		}
	});
});
