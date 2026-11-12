/**
 * `src/shared/quota-reset.ts` holds two copies of stock rules, because main reads a failed turn's text with no omp to
 * ask: what is an account out of money (`isBillingCap`: never waited for) and the wait a failed reply carries
 * (`retryAfterMs`). The installed omp's own functions answer the same messages here.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { isBillingCap, isLimitWording, retryAfterMs } from "../shared/quota-reset";
import { ompPackageRoot } from "./omp-runtime";
import { INSTALLED_OMP } from "./test-bridge-probe";

const stockRoot = ompPackageRoot(INSTALLED_OMP);
const piAi = stockRoot ? path.join(stockRoot, "..", "pi-ai", "src") : "";
const rateLimit = path.join(piAi, "error", "rate-limit.ts");
const retryAfter = path.join(piAi, "utils", "retry-after.ts");

/** Failed replies as stock journals them: the HTTP status, then the provider's body. */
const REPLIES: ReadonlyArray<[status: number, body: string]> = [
	// The owner's report of 12 Nov 2026: a model's weekly limit. It passes with time.
	[
		429,
		'{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."},"request_id":"req_011CZ"}',
	],
	[429, "usage limit reached for this account"],
	[429, "Too Many Requests"],
	[429, "Rate limit exceeded: 50 requests per minute"],
	[429, "Resource exhausted: quota exceeded for this project, it resets tomorrow"],
	// An account out of money.
	[402, "the organization is out of credit, add more to continue (type=insufficient_quota)"],
	[402, "Payment Required"],
	[402, "Insufficient Balance"],
	[
		429,
		'{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota"}}',
	],
	[429, "This request would exceed your available credits given your current in-flight requests"],
	[429, "Insufficient credits"],
	[429, "Your prepaid balance is used up: Add funds or enable auto top-up (usage_pricing_required)"],
	[429, "You have reached your monthly spend limit"],
	[429, "Your project has exceeded its monthly spending cap"],
	[429, "Usage credits are required for this model (credits_required)"],
	[403, "You have run out of credits, top up to continue"],
];

function stock<T>(script: string): T {
	const ran = spawnSync("bun", ["-e", script], { encoding: "utf8", timeout: 60_000 });
	if (ran.status !== 0) throw new Error(`stock probe failed: ${ran.stderr || ran.error}`);
	return JSON.parse(ran.stdout) as T;
}

describe.skipIf(!stockRoot || !existsSync(rateLimit) || !existsSync(retryAfter))(
	"the limit rules main copies from stock (installed omp)",
	() => {
		it("never waits for a failure stock calls a billing cap, and waits for the limits stock lets pass with time", () => {
			const billing = stock<boolean[]>(
				`const { isBillingCapUsageLimit } = await import(${JSON.stringify(rateLimit)});
				console.log(JSON.stringify(${JSON.stringify(REPLIES)}.map(([status, body]) => isBillingCapUsageLimit(status, body))));`,
			);
			const ours = REPLIES.map(([status, body]) => isBillingCap(`${status} ${body}`));
			expect(ours).toEqual(billing);
			// The first five are limits both sides wait for; none of the rest is.
			expect(billing).toEqual(REPLIES.map((_reply, index) => index >= 5));
			for (const [status, body] of REPLIES.slice(0, 5)) expect(isLimitWording(`${status} ${body}`)).toBe(true);
		}, 90_000);

		it("reads the wait stock appends to a failed reply as stock reads it back", () => {
			const headers = [{ "retry-after-ms": "319918000" }, { "retry-after": "120" }, {}];
			const hinted = stock<Array<{ message: string; ms: number | null }>>(
				`const { appendRetryAfterHint, extractProviderRetryHint } = await import(${JSON.stringify(retryAfter)});
				console.log(JSON.stringify(${JSON.stringify(headers)}.map(headers => {
					const message = appendRetryAfterHint("429 Too Many Requests", headers);
					return { message, ms: extractProviderRetryHint("anthropic", message) ?? null };
				})));`,
			);
			expect(hinted.map(({ message }) => retryAfterMs(message) ?? null)).toEqual(hinted.map(({ ms }) => ms));
			expect(hinted[0]?.ms).toBe(319_918_000);
			expect(hinted[2]?.ms).toBeNull();
		}, 90_000);
	},
);
