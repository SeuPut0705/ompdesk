import { afterEach, describe, expect, it, vi } from "vitest";
import type { UsageReport } from "../../shared/rpc-types";
import { autopilotQuotaBooking, QUOTA_FALLBACK_MS } from "./autopilot-quota";

const NOW = 1_700_000_000_000;
const RATE_LIMIT = "429 usage limit reached";
const base = {
	live: true,
	sessionId: "s1",
	provider: "anthropic",
	booked: undefined,
	errorMessage: RATE_LIMIT,
	stopReason: "error",
	now: NOW,
};

afterEach(() => vi.restoreAllMocks());

function report(resetAt: number | undefined): UsageReport {
	return { provider: "anthropic", resetAt } as UsageReport;
}

describe("autopilotQuotaBooking", () => {
	it("books the provider's reset time for a live run's rate-limit stop", () => {
		expect(autopilotQuotaBooking({ ...base, reports: [report(NOW + 600_000)] })).toBe(NOW + 600_000);
	});

	it("takes the first account to reset", () => {
		expect(autopilotQuotaBooking({ ...base, reports: [report(NOW + 900_000), report(NOW + 300_000)] })).toBe(
			NOW + 300_000,
		);
	});

	it("falls back to a fixed wait when no report names a reset", () => {
		expect(autopilotQuotaBooking({ ...base, reports: [] })).toBe(NOW + QUOTA_FALLBACK_MS);
		expect(autopilotQuotaBooking({ ...base, reports: null })).toBe(NOW + QUOTA_FALLBACK_MS);
		expect(autopilotQuotaBooking({ ...base, reports: [report(undefined)] })).toBe(NOW + QUOTA_FALLBACK_MS);
	});

	it("books nothing for another error, a stop the user asked for, or a session that is no live run", () => {
		expect(autopilotQuotaBooking({ ...base, reports: [], errorMessage: "ECONNRESET" })).toBeNull();
		expect(autopilotQuotaBooking({ ...base, reports: [], stopReason: "aborted" })).toBeNull();
		expect(autopilotQuotaBooking({ ...base, reports: [], live: false })).toBeNull();
		expect(autopilotQuotaBooking({ ...base, reports: [], sessionId: "" })).toBeNull();
	});

	it("keeps an existing booking", () => {
		expect(autopilotQuotaBooking({ ...base, reports: [], booked: NOW + 5_000 })).toBeNull();
	});
});
