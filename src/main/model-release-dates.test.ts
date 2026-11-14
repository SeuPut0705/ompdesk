import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.resetModules());
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

const catalog = {
	providers: {
		openrouter: {
			models: {
				"lab/exact": { id: "lab/exact", canonical_model_id: "lab/base", release_date: "2026-11-12" },
				"lab/month": { id: "lab/month", canonical_model_id: "lab/month" },
				"lab/invalid": { id: "lab/invalid", canonical_model_id: "lab/invalid" },
				"lab/standalone": { id: "lab/standalone", release_date: "2026-11-12" },
				"lab/wrong": { id: "other", canonical_model_id: "lab/base" },
				"lab/mismatch": { id: "lab/mismatch", canonical_model_id: "lab/mismatch" },
			},
		},
	},
	models: {
		"lab/base": { id: "lab/base", release_date: "2024-02-29" },
		"lab/month": { id: "lab/month", release_date: "2024-02" },
		"lab/invalid": { id: "lab/invalid", release_date: "2023-02-29" },
		"lab/mismatch": { id: "other", release_date: "2024-01-01" },
	},
};

describe("model release dates", () => {
	it("returns only exact canonical model dates, not provider dates or guessed suffix matches", async () => {
		const fetcher = vi.fn(async (_url: string | URL | Request) => Response.json(catalog));
		vi.stubGlobal("fetch", fetcher);
		const { getModelReleaseDates } = await import("./model-release-dates");
		expect(await getModelReleaseDates()).toEqual({ dates: { "lab/exact": Date.UTC(2024, 1, 29) } });
		expect(fetcher.mock.calls[0]?.[0]).toBe("https://models.dev/catalog.json");
	});

	it("shares a lazy fetch and caches the answer for a day", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const { promise, resolve } = Promise.withResolvers<Response>();
		const fetcher = vi.fn(() => promise);
		vi.stubGlobal("fetch", fetcher);
		const { getModelReleaseDates } = await import("./model-release-dates");
		expect(fetcher).not.toHaveBeenCalled();
		const first = getModelReleaseDates();
		const second = getModelReleaseDates();
		expect(fetcher).toHaveBeenCalledTimes(1);
		resolve(Response.json(catalog));
		expect(await first).toEqual(await second);
		await getModelReleaseDates();
		expect(fetcher).toHaveBeenCalledTimes(1);
		fetcher.mockResolvedValueOnce(Response.json(catalog));
		vi.advanceTimersByTime(24 * 60 * 60 * 1_000);
		expect(await getModelReleaseDates()).toEqual({ dates: { "lab/exact": Date.UTC(2024, 1, 29) } });
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it("returns unknown dates and backs off after failure or malformed data", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		const fetcher = vi
			.fn()
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce(Response.json({ providers: {} }));
		vi.stubGlobal("fetch", fetcher);
		const { getModelReleaseDates } = await import("./model-release-dates");
		expect(await getModelReleaseDates()).toEqual({ dates: {} });
		expect(await getModelReleaseDates()).toEqual({ dates: {} });
		expect(fetcher).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(5 * 60 * 1_000);
		expect(await getModelReleaseDates()).toEqual({ dates: {} });
		expect(await getModelReleaseDates()).toEqual({ dates: {} });
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
});
