import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	isBillingCap,
	isLimitWording,
	QUOTA_FALLBACK_MS,
	quotaResetAt,
	quotaWaitUntil,
	retryAfterMs,
} from "./quota-reset";
import type { UsageReport } from "./rpc-types";

function report(provider: string, resetAt?: number): UsageReport {
	return { provider, fetchedAt: 0, limits: [], ...(resetAt === undefined ? {} : { resetAt }) };
}

/** The failed reply of the owner's report (12 Nov 2026), word for word but for the request id. */
const WEEKLY_LIMIT =
	'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."},"request_id":"req_011CZ"} retry-after-ms=319918000';

describe("quotaResetAt", () => {
	it("is the first of the provider's accounts to reset, once every account is limited", () => {
		const now = 1_000;
		expect(quotaResetAt([report("anthropic", 9_000), report("anthropic", 5_000)], "anthropic", now)).toBe(5_000);
		expect(quotaResetAt([report("anthropic", 9_000), report("anthropic")], "anthropic", now)).toBeUndefined();
		expect(quotaResetAt([report("openai", 9_000)], "anthropic", now)).toBeUndefined();
		expect(quotaResetAt([report("anthropic", 500)], "anthropic", now)).toBeUndefined();
	});
});

describe("quotaWaitUntil", () => {
	it("is that reset, and the fallback when no report names one", () => {
		expect(quotaWaitUntil([report("anthropic", 9_000)], "anthropic", 1_000)).toBe(9_000);
		expect(quotaWaitUntil([report("anthropic")], "anthropic", 1_000)).toBe(1_000 + QUOTA_FALLBACK_MS);
		expect(quotaWaitUntil([], undefined, 1_000)).toBe(1_000 + QUOTA_FALLBACK_MS);
	});
});

describe("retryAfterMs", () => {
	it("reads the wait stock appends to a failed reply", () => {
		expect(retryAfterMs(WEEKLY_LIMIT)).toBe(319_918_000);
		expect(retryAfterMs("429 Too Many Requests retry-after-ms: 1500")).toBe(1500);
	});

	it("is unknown without one, or for one that names no time", () => {
		expect(retryAfterMs("429 usage limit reached for this account")).toBeUndefined();
		expect(retryAfterMs("429 Too Many Requests retry-after-ms=0")).toBeUndefined();
		expect(retryAfterMs(undefined)).toBeUndefined();
	});
});

describe("isLimitWording and isBillingCap", () => {
	it.each([
		WEEKLY_LIMIT,
		"429 usage limit reached for this account",
		"Rate limit exceeded, 503 try later",
		"429 Too Many Requests",
		"Monthly usage limit reached",
		"GoUsageLimitError: weekly limit",
		"ResourceExhausted: quota exceeded for this project",
	])("%s is a limit that passes with time", message => {
		expect(isLimitWording(message)).toBe(true);
		expect(isBillingCap(message)).toBe(false);
	});

	it.each([
		"402 the organization is out of credit, add more to continue (type=insufficient_quota)",
		"You exceeded your current quota, please check your plan and billing details",
		"insufficient_quota",
		"Your credit balance is too low (insufficient funds)",
		"This request would exceed your available credits given your current in-flight requests",
		"Your prepaid balance is used up: Add funds or enable auto top-up",
		"You have reached your monthly spend limit",
		"Your project has exceeded its monthly spending cap",
		"Usage credits are required for this model",
		"Insufficient Balance",
	])("%s is an account out of money", message => {
		expect(isBillingCap(message)).toBe(true);
	});

	it("reads neither into a plain failure", () => {
		for (const message of [
			"503 Service unavailable",
			"id 1429 was not found",
			"spending capacity reached",
			undefined,
		]) {
			expect(isLimitWording(message)).toBe(false);
			expect(isBillingCap(message)).toBe(false);
		}
	});
});

/**
 * The core keeps a second copy of these rules (`native/ompdesk/crates/core/src/resume/text.rs`: turn resume judges a failed
 * turn with it); both copies answer the rows captured from this one.
 */
describe("the rows the core's copy is held to", () => {
	const rows = JSON.parse(
		readFileSync(
			new URL("../../native/ompdesk/crates/core/src/resume/classifiers-captured.json", import.meta.url),
			"utf8",
		),
	) as Array<{ message?: string; billing: boolean; retryAfter: number | null }>;

	it("answers billing cap and retry-after as the captured rows say", () => {
		expect(rows.length).toBeGreaterThan(60);
		for (const row of rows) {
			expect(isBillingCap(row.message), row.message).toBe(row.billing);
			expect(retryAfterMs(row.message) ?? null, row.message).toBe(row.retryAfter);
		}
	});
});
