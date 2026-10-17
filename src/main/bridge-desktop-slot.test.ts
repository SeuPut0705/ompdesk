/**
 * The desktop slot's bridge side (resources/gui-bridge/desktop-slot-core.ts) with fake runs, a fake host and fake
 * timers: an acting run needs the slot and returns the stale notice only when its grant waited, a read-only run
 * always passes, and idle, turn end and revoke each abort the in-flight run, revoke the controllers and let go.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DESKTOP_SLOT_IDLE_MS } from "../../resources/gui-bridge/desktop-slot-contracts";
import { type ActingRun, DesktopSlotCore, type SlotFrame } from "../../resources/gui-bridge/desktop-slot-core";

const STALE = "stale";
const REVOKED = "revoked";

interface Harness {
	core: DesktopSlotCore;
	frames: SlotFrame[];
	/** The order revokeControllers and the frames happened in. */
	log: string[];
	revoked: number;
}

function harness(revokeControllers?: () => Promise<void>): Harness {
	const frames: SlotFrame[] = [];
	const log: string[] = [];
	let ids = 0;
	const h: Harness = {
		frames,
		log,
		revoked: 0,
		core: new DesktopSlotCore({
			emit: frame => {
				frames.push(frame);
				log.push(frame.type === "desktop_slot_release" ? `release:${frame.reason}` : frame.type);
			},
			newId: () => `r${++ids}`,
			async revokeControllers() {
				h.revoked++;
				log.push("revoke");
				await revokeControllers?.();
			},
		}),
	};
	return h;
}

const types = (h: Harness) => h.frames.map(frame => frame.type);
const requestIds = (h: Harness) =>
	h.frames.flatMap(frame => (frame.type === "desktop_slot_acquire" ? [frame.requestId] : []));

/** An acting run that records whether it ran, resolving "ran" (or rejecting on its own abort when `hang`). */
function acting(options: { hang?: boolean; signal?: AbortSignal } = {}) {
	const state = { ran: 0, inner: undefined as AbortSignal | undefined };
	const run: ActingRun<string> = {
		signal: options.signal,
		run: signal => {
			state.ran++;
			state.inner = signal;
			if (!options.hang) return Promise.resolve("ran");
			return new Promise<string>((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		},
		stale: () => STALE,
		revoked: () => REVOKED,
	};
	return { state, run };
}

/** Drains the microtask queue so a started run has reached its await. */
const settle = () => vi.advanceTimersByTimeAsync(0);

/** Takes the slot for `h`'s core through an acting run granted with `waited`. */
async function take(h: Harness, waited: boolean): Promise<string> {
	const pending = h.core.runActing(acting().run);
	const [id] = requestIds(h).slice(-1);
	h.core.grant(id, waited);
	return pending;
}

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("desktop slot: read-only runs", () => {
	it("pass without asking for the slot", async () => {
		const h = harness();
		const result = await h.core.runReadOnly(async () => "shot");
		expect(result).toBe("shot");
		expect(h.frames).toEqual([]);
		expect(h.core.holding).toBe(false);
	});

	it("count as progress for the holder and reset its idle timer", async () => {
		const h = harness();
		await take(h, false);
		await vi.advanceTimersByTimeAsync(DESKTOP_SLOT_IDLE_MS - 1_000);
		const touchesBefore = types(h).filter(type => type === "desktop_slot_touch").length;
		await h.core.runReadOnly(async () => "shot");
		expect(types(h).filter(type => type === "desktop_slot_touch").length).toBeGreaterThan(touchesBefore);
		await vi.advanceTimersByTimeAsync(DESKTOP_SLOT_IDLE_MS - 1_000);
		expect(h.core.holding).toBe(true);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(h.core.holding).toBe(false);
	});
});

describe("desktop slot: acting runs", () => {
	it("ask main for the slot and run when the grant did not wait", async () => {
		const h = harness();
		const { run, state } = acting();
		const pending = h.core.runActing(run);
		await settle();
		expect(types(h)).toEqual(["desktop_slot_acquire"]);
		expect(state.ran).toBe(0);
		expect(h.core.grant(requestIds(h)[0], false)).toBe(true);
		await expect(pending).resolves.toBe("ran");
		expect(h.core.holding).toBe(true);
	});

	it("return the stale notice without running when the grant waited, and keep the slot", async () => {
		const h = harness();
		const { run, state } = acting();
		const pending = h.core.runActing(run);
		h.core.grant(requestIds(h)[0], true);
		await expect(pending).resolves.toBe(STALE);
		expect(state.ran).toBe(0);
		expect(h.core.holding).toBe(true);
		// The agent's repeat runs at once: the slot is ours.
		const again = acting();
		await expect(h.core.runActing(again.run)).resolves.toBe("ran");
		expect(again.state.ran).toBe(1);
		expect(requestIds(h)).toHaveLength(1);
	});

	it("run at once while holding, with a touch before and after", async () => {
		const h = harness();
		await take(h, false);
		h.frames.length = 0;
		await expect(h.core.runActing(acting().run)).resolves.toBe("ran");
		expect(types(h)).toEqual(["desktop_slot_touch", "desktop_slot_touch"]);
	});

	it("ignore a grant nobody waits for", () => {
		expect(harness().core.grant("nope", false)).toBe(false);
	});

	it("give up waiting on the stock abort: release with the request id and reject with the abort", async () => {
		const h = harness();
		const stop = new AbortController();
		const { run, state } = acting({ signal: stop.signal });
		const pending = h.core.runActing(run);
		const caught = pending.catch((error: unknown) => error);
		await settle();
		stop.abort(new Error("user stop"));
		expect(((await caught) as Error).message).toBe("user stop");
		expect(h.frames.at(-1)).toEqual({ type: "desktop_slot_release", reason: "abort", requestId: "r1" });
		expect(h.core.waitingCount).toBe(0);
		expect(h.core.grant("r1", false)).toBe(false);
		expect(state.ran).toBe(0);
		expect(h.core.holding).toBe(false);
	});

	it("rethrow the stock abort of an in-flight run and keep the slot", async () => {
		const h = harness();
		await take(h, false);
		const stop = new AbortController();
		const { run } = acting({ hang: true, signal: stop.signal });
		const caught = h.core.runActing(run).catch((error: unknown) => error);
		await settle();
		stop.abort();
		expect(((await caught) as Error).message).toBe("aborted");
		expect(h.core.holding).toBe(true);
	});
});

describe("desktop slot: letting go", () => {
	it("releases an idle holder after DESKTOP_SLOT_IDLE_MS, after revoking the controllers", async () => {
		const h = harness();
		await take(h, false);
		await vi.advanceTimersByTimeAsync(DESKTOP_SLOT_IDLE_MS - 1);
		expect(h.core.holding).toBe(true);
		await vi.advanceTimersByTimeAsync(1);
		expect(h.core.holding).toBe(false);
		expect(h.revoked).toBe(1);
		expect(h.log.slice(-2)).toEqual(["revoke", "release:idle"]);
	});

	it("does not call a run in flight idle", async () => {
		const h = harness();
		await take(h, false);
		const { run } = acting({ hang: true });
		const pending = h.core.runActing(run).catch(() => undefined);
		await settle();
		await vi.advanceTimersByTimeAsync(DESKTOP_SLOT_IDLE_MS * 3);
		expect(h.core.holding).toBe(true);
		await h.core.revoke("stop");
		await pending;
	});

	it("releases at turn end", async () => {
		const h = harness();
		await take(h, false);
		await h.core.turnEnd();
		expect(h.core.holding).toBe(false);
		expect(h.log.slice(-2)).toEqual(["revoke", "release:turn_end"]);
		// Idle timer is gone: no second release.
		await vi.advanceTimersByTimeAsync(DESKTOP_SLOT_IDLE_MS * 2);
		expect(types(h).filter(type => type === "desktop_slot_release")).toHaveLength(1);
	});

	it("does nothing at turn end without the slot", async () => {
		const h = harness();
		await h.core.turnEnd();
		expect(h.frames).toEqual([]);
		expect(h.revoked).toBe(0);
	});

	it("revoke aborts the in-flight run, hands its caller the revoked notice, revokes the controllers and sends no release", async () => {
		const h = harness();
		await take(h, false);
		const { run, state } = acting({ hang: true });
		const pending = h.core.runActing(run);
		await settle();
		expect(state.inner?.aborted).toBe(false);
		await h.core.revoke("stop");
		expect(state.inner?.aborted).toBe(true);
		await expect(pending).resolves.toBe(REVOKED);
		expect(h.core.holding).toBe(false);
		expect(h.revoked).toBe(1);
		expect(types(h).includes("desktop_slot_release")).toBe(false);
	});

	it("revoke answers only after the controllers were revoked", async () => {
		const gate = Promise.withResolvers<void>();
		const h = harness(() => gate.promise);
		await take(h, false);
		let answered = false;
		const revoking = h.core.revoke("stop").then(() => {
			answered = true;
		});
		await settle();
		expect(answered).toBe(false);
		gate.resolve();
		await revoking;
		expect(answered).toBe(true);
	});

	it("an acting run during a let-go waits for it, then asks for the slot again", async () => {
		const gate = Promise.withResolvers<void>();
		const h = harness(() => gate.promise);
		await take(h, false);
		const leaving = h.core.turnEnd();
		const { run, state } = acting();
		const pending = h.core.runActing(run);
		await settle();
		expect(requestIds(h)).toHaveLength(1);
		gate.resolve();
		await leaving;
		await settle();
		expect(requestIds(h)).toHaveLength(2);
		h.core.grant("r2", true);
		await expect(pending).resolves.toBe(STALE);
		expect(state.ran).toBe(0);
	});

	it("revoke without the slot answers at once", async () => {
		const h = harness();
		await h.core.revoke("stop");
		expect(h.revoked).toBe(0);
	});

	describe("a revoke that fails", () => {
		it("rejects, keeps the slot held and sends no release", async () => {
			const h = harness(() => Promise.reject(new Error("Timed out revoking computer control")));
			await take(h, false);
			await expect(h.core.revoke("stop")).rejects.toThrow("Timed out");
			expect(h.core.holding).toBe(true);
			expect(types(h).includes("desktop_slot_release")).toBe(false);
		});

		it("blocks acting runs (they must not run) until a revoke succeeds", async () => {
			let fail = true;
			const h = harness(() => (fail ? Promise.reject(new Error("stuck")) : Promise.resolve()));
			await take(h, false);
			await expect(h.core.revoke("stop")).rejects.toThrow("stuck");
			const { run, state } = acting();
			await expect(h.core.runActing(run)).rejects.toThrow("input is blocked");
			expect(state.ran).toBe(0);
			// Read-only runs still pass.
			await expect(h.core.runReadOnly(() => Promise.resolve("shot"))).resolves.toBe("shot");
			fail = false;
			await h.core.revoke("retry");
			expect(h.core.holding).toBe(false);
			expect(h.revoked).toBe(2);
		});

		it("a failed turn-end revoke sends no release either", async () => {
			const h = harness(() => Promise.reject(new Error("stuck")));
			await take(h, false);
			await expect(h.core.turnEnd()).rejects.toThrow("stuck");
			expect(h.core.holding).toBe(true);
			expect(types(h).includes("desktop_slot_release")).toBe(false);
		});
	});
});
