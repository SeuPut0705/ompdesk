import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CareDeps, type CareUnit, MemoryCare } from "./care";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const PROJECT = { workspace: "default", project: "app" };

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "care-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function fakeClient() {
	const calls: string[] = [];
	let checkpoint = 0;
	const client: CareDeps["client"] = {
		headCheckpoint: async () => `cp${checkpoint}`,
		page: async ref => ({
			...ref,
			title: `Title of ${ref.path}`,
			markdown: "",
			id: "pg",
			pinned: false,
			createdAt: null,
			updatedAt: null,
			tags: [] as string[],
		}),
		retirePage: async ref => {
			checkpoint += 1;
			calls.push(`retire ${ref.path}`);
			return "retired";
		},
		feedback: async (ref, signal) => {
			calls.push(`${signal} ${ref.path}`);
		},
		restorePage: async (ref, rev) => {
			calls.push(`restore ${ref.path}@${rev}`);
		},
	};
	return { client, calls };
}

function care(units: CareUnit[], client: CareDeps["client"], clock: { now: number }, version = "1.0.0") {
	const logs: string[] = [];
	const worker = new MemoryCare({
		client,
		units,
		version,
		stateFile: join(dir, "care.json"),
		log: message => logs.push(message),
		now: () => clock.now,
	});
	return { worker, logs };
}

const unit = (name: CareUnit["name"], everyMs: number | null, run: CareUnit["run"]): CareUnit => ({
	name,
	everyMs,
	run,
});

describe("MemoryCare", () => {
	it("runs one unit per tick, goes on with an unfinished one, repeats a finished one only after its interval", async () => {
		const clock = { now: Date.parse("2026-10-20T00:00:00Z") };
		const ran: string[] = [];
		let backfillSteps = 0;
		const units = [
			unit("backfill", null, async () => {
				ran.push("backfill");
				backfillSteps += 1;
				return { done: backfillSteps >= 2, written: 10 };
			}),
			unit("curate", DAY, async () => {
				ran.push("curate");
				return { done: true };
			}),
		];
		const { client } = fakeClient();
		const { worker } = care(units, client, clock);
		for (let i = 0; i < 4; i++) await worker.tick();
		expect(ran).toEqual(["backfill", "backfill", "curate"]);
		clock.now += DAY;
		await worker.tick();
		await worker.tick();
		expect(ran).toEqual(["backfill", "backfill", "curate", "curate"]);
	});

	it("runs every unit again after an update", async () => {
		const clock = { now: Date.parse("2026-10-20T00:00:00Z") };
		const ran: string[] = [];
		const units = [
			unit("backfill", null, async () => {
				ran.push("backfill");
				return { done: true };
			}),
		];
		const { client } = fakeClient();
		await care(units, client, clock, "1.0.0").worker.tick();
		await care(units, client, clock, "1.0.0").worker.tick();
		expect(ran).toEqual(["backfill"]);
		await care(units, client, clock, "1.1.0").worker.tick();
		expect(ran).toEqual(["backfill", "backfill"]);
	});

	it("tries a failed unit again after an hour, not every tick", async () => {
		const clock = { now: Date.parse("2026-10-20T00:00:00Z") };
		let attempts = 0;
		const units = [
			unit("curate", DAY, async () => {
				attempts += 1;
				throw new Error("server busy");
			}),
		];
		const { client } = fakeClient();
		const { worker, logs } = care(units, client, clock);
		await worker.tick();
		await worker.tick();
		expect(attempts).toBe(1);
		expect(logs).toEqual(["care-failed"]);
		clock.now += HOUR;
		await worker.tick();
		expect(attempts).toBe(2);
	});

	it("shows what changed, undoes it through the page's restore and leaves restored pages to the person", async () => {
		const clock = { now: Date.parse("2026-10-20T00:00:00Z") };
		const { client, calls } = fakeClient();
		const units = [
			unit("curate", DAY, async care => {
				await care.retirePage({
					...PROJECT,
					path: "decisions/old.md",
					successor: "decisions/new.md",
					at: new Date(clock.now),
				});
				await care.feedback({ ...PROJECT, path: "gotchas/maybe.md" }, "stale");
				return { done: true };
			}),
			unit("backfill", null, async () => ({ done: true, written: 42 })),
		];
		const { worker } = care(units, client, clock);
		expect(await worker.summary()).toBeNull();
		await worker.tick();
		await worker.tick();
		expect(await worker.summary()).toMatchObject({
			retired: 1,
			flagged: 1,
			backfilled: 42,
			pages: [
				{ path: "decisions/old.md", title: "Title of decisions/old.md" },
				{ path: "gotchas/maybe.md", title: "Title of gotchas/maybe.md" },
			],
		});

		expect(await worker.undo()).toBe(2);
		expect(calls.filter(call => call.startsWith("restore"))).toEqual([
			"restore decisions/old.md@cp0",
			"restore gotchas/maybe.md@cp1",
		]);
		expect(await worker.summary()).toMatchObject({ retired: 0, flagged: 0, pages: [] });

		calls.length = 0;
		clock.now += DAY;
		await worker.tick();
		expect(calls).toEqual([]);
	});

	it("keeps each unit's memo across launches", async () => {
		const clock = { now: Date.parse("2026-10-20T00:00:00Z") };
		const seen: unknown[] = [];
		const units = [
			unit("fresh", null, async (_client, memo) => {
				seen.push(memo.flagged);
				memo.flagged = { "default/app/gotchas/a.md": "pg-1" };
				return { done: false };
			}),
		];
		const { client } = fakeClient();
		await care(units, client, clock).worker.tick();
		await care(units, client, clock).worker.tick();
		expect(seen).toEqual([undefined, { "default/app/gotchas/a.md": "pg-1" }]);
	});

	it("drops changes from the line after a week", async () => {
		const clock = { now: Date.parse("2026-10-20T00:00:00Z") };
		const { client } = fakeClient();
		const units = [
			unit("fresh", null, async care => {
				await care.retirePage({
					...PROJECT,
					path: "gotchas/gone.md",
					reason: "names files that are gone",
					at: new Date(clock.now),
				});
				return { done: true };
			}),
		];
		const { worker } = care(units, client, clock);
		await worker.tick();
		expect(await worker.summary()).toMatchObject({ retired: 1 });
		clock.now += 8 * DAY;
		expect(await worker.summary()).toBeNull();
	});
});
