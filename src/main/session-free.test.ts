import { describe, expect, it } from "vitest";
import { SESSION_FREE_WAIT_MS, whenSessionFree } from "./session-free";

function clock() {
	let now = 0;
	const asked: number[] = [];
	return {
		asked,
		now: () => now,
		sleep: async (ms: number) => {
			now += ms;
		},
		owned: (until: number) => async (): Promise<boolean> => {
			asked.push(now);
			return now < until;
		},
	};
}

describe("whenSessionFree", () => {
	it("waits while another omp still owns the session, and opens it as soon as the owner lets go", async () => {
		const c = clock();
		expect(await whenSessionFree("/s/a.jsonl", { owned: c.owned(1_000), now: c.now, sleep: c.sleep })).toBe("free");
		expect(c.asked.at(-1)).toBe(1_000);
	});

	it("opens it anyway once the wait runs out (an omp in a terminal can hold it for good)", async () => {
		const c = clock();
		expect(
			await whenSessionFree("/s/a.jsonl", { owned: c.owned(Number.POSITIVE_INFINITY), now: c.now, sleep: c.sleep }),
		).toBe("timeout");
		expect(c.now()).toBeGreaterThanOrEqual(SESSION_FREE_WAIT_MS);
		expect(c.now()).toBeLessThan(SESSION_FREE_WAIT_MS + 1_000);
	});

	it("does not wait when it cannot tell", async () => {
		const c = clock();
		const owned = async (): Promise<boolean> => {
			throw new Error("no stock helper");
		};
		expect(await whenSessionFree("/s/a.jsonl", { owned, now: c.now, sleep: c.sleep })).toBe("free");
		expect(c.now()).toBe(0);
	});
});
