import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ROUTINE_CHAIN_LIMIT,
	SCHEDULE_RUNS_PER_SCHEDULE,
	type Schedule,
	type ScheduleDraft,
	type SchedulesState,
} from "../shared/schedules";
import type { OmpResolution } from "./omp-runtime";
import {
	ompRunLauncher,
	type RunLauncher,
	type RunProcess,
	SCHEDULE_TICK_MS,
	ScheduleService,
	type ScheduleServiceOptions,
	ScheduleSkip,
} from "./schedules";
import { SUPERVISOR_STOPPED_CODE } from "./setup/supervisor";
import { RM_TEMP, writeFakeOmp } from "./test-fake-omp";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "ompdesk-schedules-"));
	dirs.push(dir);
	return dir;
}

afterEach(async () => {
	vi.useRealTimers();
	for (const dir of dirs.splice(0)) await rm(dir, RM_TEMP);
});

/** A launcher whose runs end when the test says so; `launched(n)` settles once `n` runs started. */
function fakeLauncher() {
	const runs: {
		prompt: string;
		finish: (code: number | null) => void;
		stopped: boolean;
		stopSignal: Promise<void>;
	}[] = [];
	const waiters: { count: number; resolve: () => void }[] = [];
	const launch = vi.fn(async (_schedule: Schedule, files: { log: string; prompt: string }): Promise<RunProcess> => {
		const { promise, resolve } = Promise.withResolvers<{ code: number | null }>();
		const stopSignal = Promise.withResolvers<void>();
		const entry = {
			prompt: await readFile(files.prompt, "utf8"),
			finish: (code: number | null) => resolve({ code }),
			stopped: false,
			stopSignal: stopSignal.promise,
		};
		runs.push(entry);
		for (const waiter of waiters.filter(item => runs.length >= item.count)) waiter.resolve();
		return {
			stop: () => {
				entry.stopped = true;
				stopSignal.resolve();
				resolve({ code: SUPERVISOR_STOPPED_CODE });
			},
			done: promise,
		};
	});
	const launched = (count: number): Promise<void> => {
		if (runs.length >= count) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		waiters.push({ count, resolve });
		return promise;
	};
	return { launch, runs, launched };
}

/** A service on `dir` whose `until(predicate)` settles with the first pushed state that matches. */
function harness(dir: string, launch: RunLauncher, reserve?: ScheduleServiceOptions["reserve"]) {
	const listeners = new Set<(state: SchedulesState) => void>();
	const service = new ScheduleService({
		file: join(dir, "schedules.json"),
		logDir: join(dir, "runs"),
		launch,
		...(reserve ? { reserve } : {}),
		onState: state => {
			for (const listener of [...listeners]) listener(state);
		},
	});
	const until = (predicate: (state: SchedulesState) => boolean): Promise<SchedulesState> => {
		const current = service.state();
		if (predicate(current)) return Promise.resolve(current);
		const { promise, resolve } = Promise.withResolvers<SchedulesState>();
		const listener = (state: SchedulesState) => {
			if (!predicate(state)) return;
			listeners.delete(listener);
			resolve(state);
		};
		listeners.add(listener);
		return promise;
	};
	return { service, until };
}

function draft(cwd: string, overrides: Partial<ScheduleDraft> = {}): ScheduleDraft {
	return {
		name: "Tidy",
		prompt: "Tidy the README",
		cwd,
		frequency: { kind: "interval", minutes: 60 },
		model: null,
		autoApprove: false,
		enabled: true,
		...overrides,
	};
}

/** The schedule clock (its tick and `Date`) runs fake; promises and file I/O stay real. */
function fakeClock(now?: Date): void {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], ...(now ? { now } : {}) });
}

describe("ScheduleService", () => {
	it("starts a due schedule, records its outcome, and skips a start while the previous run still goes", async () => {
		fakeClock(new Date(2026, 9, 15, 12, 0));
		const dir = await tempDir();
		const { launch, runs, launched } = fakeLauncher();
		const { service, until } = harness(dir, launch);
		await service.start();
		const saved = await service.command({ action: "save", draft: draft(dir) });
		const id = saved.schedules[0]?.id ?? "";
		expect(saved.nextRuns[id]).toBe(new Date(2026, 9, 15, 13, 0).toISOString());

		await vi.advanceTimersByTimeAsync(60 * 60_000);
		await launched(1);
		expect(runs[0]?.prompt).toBe("Tidy the README");
		expect(service.state().runs[0]).toMatchObject({ scheduleId: id, status: "running", trigger: "schedule" });

		// Still running an hour later: that start is skipped, not stacked.
		await vi.advanceTimersByTimeAsync(60 * 60_000);
		await until(state => state.runs[0]?.status === "skipped");
		expect(launch).toHaveBeenCalledTimes(1);

		runs[0]?.finish(0);
		const finished = await until(state => state.runs.some(run => run.status === "succeeded"));
		expect(finished.runs.find(run => run.status === "succeeded")).toMatchObject({ exitCode: 0, trigger: "schedule" });
		service.dispose();
	});

	it("runs on demand, stops on request, and reports a failing exit", async () => {
		fakeClock();
		const dir = await tempDir();
		const { launch, runs, launched } = fakeLauncher();
		const { service, until } = harness(dir, launch);
		await service.start();
		const id = (await service.command({ action: "save", draft: draft(dir) })).schedules[0]?.id ?? "";

		await service.command({ action: "runNow", id });
		await launched(1);
		await expect(service.command({ action: "runNow", id })).rejects.toThrow("already running");
		const runId = service.state().runs[0]?.id ?? "";
		await service.command({ action: "stop", runId });
		const stopped = await until(state => state.runs[0]?.status === "stopped");
		expect(runs[0]?.stopped).toBe(true);
		expect(stopped.runs[0]).toMatchObject({ id: runId, trigger: "manual", error: null });

		await service.command({ action: "runNow", id });
		await launched(2);
		runs[1]?.finish(2);
		const failed = await until(state => state.runs[0]?.status === "failed");
		expect(failed.runs[0]).toMatchObject({ exitCode: 2, error: "omp exited with code 2" });
		service.dispose();
	});

	it("a missing project folder fails the run without launching omp", async () => {
		fakeClock();
		const dir = await tempDir();
		const { launch } = fakeLauncher();
		const { service, until } = harness(dir, launch);
		await service.start();
		const id = (await service.command({ action: "save", draft: draft(join(dir, "gone")) })).schedules[0]?.id ?? "";
		await service.command({ action: "runNow", id });
		const failed = await until(state => state.runs[0]?.status === "failed");
		expect(launch).not.toHaveBeenCalled();
		expect(failed.runs[0]?.error).toContain("Project folder not found");
		service.dispose();
	});

	it("charges a paired device's schedule to that device's daily model limit and skips a timed run past it", async () => {
		fakeClock(new Date(2026, 9, 15, 12, 0));
		const dir = await tempDir();
		const { launch, runs, launched } = fakeLauncher();
		let left = 1;
		const charged: string[] = [];
		const reserve = (device: string) => {
			if (left === 0) return { ok: false as const, reason: `${device}'s daily model limit is used up` };
			left -= 1;
			charged.push(device);
			return { ok: true as const, refund: () => undefined };
		};
		const { service, until } = harness(dir, launch, reserve);
		await service.start();
		const saved = await service.command({ action: "save", draft: draft(dir) }, "dev-a");
		const id = saved.schedules[0]?.id ?? "";
		expect(saved.schedules[0]?.device).toBe("dev-a");
		// The create route (an agent's `ompdesk_schedule` over the link) makes it the device's the same way.
		const made = await service.create(draft(dir, { name: "Made", enabled: false }), "dev-a");
		expect(made.state.schedules.find(schedule => schedule.id === made.id)?.device).toBe("dev-a");

		await vi.advanceTimersByTimeAsync(60 * 60_000);
		await launched(1);
		expect(charged).toEqual(["dev-a"]);
		runs[0]?.finish(0);
		await until(state => state.runs[0]?.status === "succeeded");

		// The device's limit is used up: the next timed start is skipped with the reason, omp never launched.
		await vi.advanceTimersByTimeAsync(60 * 60_000);
		const skipped = await until(state => state.runs[0]?.status === "skipped");
		expect(skipped.runs[0]?.error).toBe("dev-a's daily model limit is used up");
		expect(launch).toHaveBeenCalledTimes(1);
		// A run now from that device is refused; this computer's own run now is not charged to it.
		await expect(service.command({ action: "runNow", id }, "dev-a")).rejects.toThrow("used up");
		await service.command({ action: "runNow", id });
		await launched(2);
		expect(charged).toEqual(["dev-a"]);
		// Saved again on this computer, it is this computer's schedule.
		const own = await service.command({ action: "save", id, draft: draft(dir) });
		expect(own.schedules[0]?.device).toBeUndefined();
		service.dispose();
	});

	it("gives a device's reserved request back when its run cannot start", async () => {
		fakeClock();
		const dir = await tempDir();
		const { launch } = fakeLauncher();
		const refunds: string[] = [];
		const reserve = (device: string) => ({ ok: true as const, refund: () => refunds.push(device) });
		const { service, until } = harness(dir, launch, reserve);
		await service.start();
		const id =
			(await service.command({ action: "save", draft: draft(join(dir, "gone")) }, "dev-a")).schedules[0]?.id ?? "";
		await service.command({ action: "runNow", id }, "dev-a");
		await until(state => state.runs[0]?.status === "failed");
		expect(refunds).toEqual(["dev-a"]);
		service.dispose();
	});

	it("a disabled schedule or a paused list has no next start", async () => {
		fakeClock();
		const dir = await tempDir();
		const { launch } = fakeLauncher();
		const { service } = harness(dir, launch);
		await service.start();
		const id = (await service.command({ action: "save", draft: draft(dir) })).schedules[0]?.id ?? "";
		expect((await service.command({ action: "setEnabled", id, enabled: false })).nextRuns[id]).toBeNull();
		expect((await service.command({ action: "setEnabled", id, enabled: true })).nextRuns[id]).not.toBeNull();
		expect((await service.command({ action: "setPaused", paused: true })).nextRuns[id]).toBeNull();
		await vi.advanceTimersByTimeAsync(3 * 60 * 60_000 + SCHEDULE_TICK_MS);
		expect(launch).not.toHaveBeenCalled();
		expect(service.state().runs).toEqual([]);
		await expect(service.command({ action: "save", draft: draft("relative") })).rejects.toThrow("cwd");
		service.dispose();
	});

	it("tells each of two concurrent creates the schedule its own save made", async () => {
		fakeClock();
		const dir = await tempDir();
		const { launch } = fakeLauncher();
		const { service } = harness(dir, launch);
		await service.start();
		const [alpha, beta] = await Promise.all([
			service.create(draft(dir, { name: "alpha" })),
			service.create(draft(dir, { name: "beta" })),
		]);
		expect(alpha.id).not.toBe(beta.id);
		expect(beta.state.schedules.map(schedule => schedule.name)).toEqual(["alpha", "beta"]);
		expect(beta.state.schedules.find(schedule => schedule.id === alpha.id)?.name).toBe("alpha");
		expect(beta.state.schedules.find(schedule => schedule.id === beta.id)?.name).toBe("beta");
		await expect(service.create(draft("relative"))).rejects.toThrow("cwd");
		service.dispose();
	});

	it("quitting stops a running omp and records it; a run left running by a crash loads as stopped", async () => {
		fakeClock();
		const dir = await tempDir();
		const file = join(dir, "schedules.json");
		const { launch, runs, launched } = fakeLauncher();
		const { service } = harness(dir, launch);
		await service.start();
		const id = (await service.command({ action: "save", draft: draft(dir) })).schedules[0]?.id ?? "";
		await service.command({ action: "runNow", id });
		await launched(1);
		service.dispose();
		// The launch was still returning when the quit came: the stop follows as soon as it has the process.
		await runs[0]?.stopSignal;
		const saved = JSON.parse(await readFile(file, "utf8")) as { runs: { status: string; error: string }[] };
		expect(saved.runs[0]).toMatchObject({ status: "stopped", error: "OMPdesk closed during the run" });

		const crashed = { ...saved, runs: [{ ...saved.runs[0], status: "running", error: null }] };
		await writeFile(file, JSON.stringify(crashed));
		const { service: reloaded } = harness(dir, launch);
		await reloaded.start();
		expect(reloaded.state().runs[0]).toMatchObject({ status: "stopped" });
		expect(reloaded.state().schedules.map(schedule => schedule.id)).toEqual([id]);
		reloaded.dispose();
	});
});

describe("a session's own wake-up (wakeSession)", () => {
	const SESSION = "/sessions/bot.jsonl";

	/** `turns`: how the woken turn ends, in order (default: it succeeds at once). */
	function wakeHarness(
		dir: string,
		options: Partial<ScheduleServiceOptions> = {},
		turns: { code: number | null; error?: string }[] = [],
	) {
		const { launch } = fakeLauncher();
		const woken: { prompt: string; session: string | undefined; runId: string }[] = [];
		const wake = vi.fn(async (schedule: Schedule, runId: string): Promise<RunProcess> => {
			woken.push({ prompt: schedule.prompt, session: schedule.wakeSession, runId });
			return { stop: () => {}, done: Promise.resolve(turns.shift() ?? { code: 0 }) };
		});
		const service = new ScheduleService({
			file: join(dir, "schedules.json"),
			logDir: join(dir, "runs"),
			launch,
			onState: () => {},
			wake,
			...options,
		});
		return { service, launch, wake, woken };
	}

	async function settled(service: ScheduleService): Promise<void> {
		await vi.waitFor(() => expect(service.state().runs[0]?.status).not.toBe("running"));
	}

	it("hands the prompt to wake when due, spawns no omp, and records a succeeded run with a log line", async () => {
		fakeClock(new Date(2026, 9, 15, 12, 0));
		const dir = await tempDir();
		const { service, launch, woken } = wakeHarness(dir);
		await service.start();
		const saved = await service.command({
			action: "save",
			draft: draft(dir, {
				prompt: "Check the build",
				frequency: { kind: "interval", minutes: 30 },
				wakeSession: SESSION,
			}),
		});
		const id = saved.schedules[0]?.id ?? "";
		expect(saved.schedules[0]?.wakeSession).toBe(SESSION);
		await vi.advanceTimersByTimeAsync(30 * 60_000 + SCHEDULE_TICK_MS);
		await settled(service);
		expect(woken).toEqual([
			{ prompt: "Check the build", session: SESSION, runId: service.state().runs[0]?.id ?? "" },
		]);
		expect(launch).not.toHaveBeenCalled();
		expect(service.state().runs[0]).toMatchObject({ scheduleId: id, status: "succeeded", exitCode: 0, error: null });
		expect(await service.readLog(service.state().runs[0]?.id ?? "")).toBe(`Woke ${SESSION}\nCheck the build\n`);
		// It repeats like any schedule, and stays in the list the Schedules panel shows.
		expect(service.state().nextRuns[id]).not.toBeNull();
		service.dispose();
	});

	it("fails the run with the reason when the session cannot be woken, and keeps the schedule", async () => {
		const dir = await tempDir();
		const { service, wake } = wakeHarness(dir);
		wake.mockRejectedValueOnce(new Error("The session to wake is gone (/sessions/bot.jsonl)"));
		await service.start();
		const saved = await service.command({ action: "save", draft: draft(dir, { wakeSession: SESSION }) });
		await service.command({ action: "runNow", id: saved.schedules[0]?.id ?? "" });
		await settled(service);
		expect(service.state().runs[0]).toMatchObject({
			status: "failed",
			trigger: "manual",
			error: "The session to wake is gone (/sessions/bot.jsonl)",
		});
		expect(service.state().schedules).toHaveLength(1);
		service.dispose();
	});

	it("fails its run where nothing delivers wake-ups", async () => {
		const dir = await tempDir();
		const { service, launch } = wakeHarness(dir, { wake: undefined });
		await service.start();
		const saved = await service.command({ action: "save", draft: draft(dir, { wakeSession: SESSION }) });
		await service.command({ action: "runNow", id: saved.schedules[0]?.id ?? "" });
		await settled(service);
		expect(service.state().runs[0]).toMatchObject({
			status: "failed",
			error: "Waking a session is not available here",
		});
		expect(launch).not.toHaveBeenCalled();
		service.dispose();
	});

	it("keeps its session through an edit from Settings, and only this computer's own sessions are woken", async () => {
		const dir = await tempDir();
		const { service } = wakeHarness(dir);
		await service.start();
		const saved = await service.command({ action: "save", draft: draft(dir, { wakeSession: SESSION }) });
		const id = saved.schedules[0]?.id ?? "";
		// The Settings dialog sends no `wakeSession`.
		const edited = await service.command({ action: "save", id, draft: draft(dir, { prompt: "Look again" }) });
		expect(edited.schedules[0]).toMatchObject({ prompt: "Look again", wakeSession: SESSION });
		// A paired device never makes or edits one, and a session path must be absolute.
		await expect(service.command({ action: "save", id, draft: draft(dir) }, "device-1")).rejects.toThrow(
			"only this computer's own sessions",
		);
		await expect(
			service.command({ action: "save", draft: draft(dir, { wakeSession: "bot.jsonl" }) }),
		).rejects.toThrow("Invalid schedule: session");
		service.dispose();
	});

	it("counts a minute by minuteMs and checks every tickMs, so a test launch wakes within moments", async () => {
		const dir = await tempDir();
		const { service, woken } = wakeHarness(dir, { minuteMs: 20, tickMs: 10 });
		await service.start();
		await service.command({
			action: "save",
			draft: draft(dir, { prompt: "Soon", frequency: { kind: "interval", minutes: 5 }, wakeSession: SESSION }),
		});
		await vi.waitFor(() => expect(woken.length).toBeGreaterThanOrEqual(1), { timeout: 3000 });
		expect(woken[0]).toMatchObject({ prompt: "Soon", session: SESSION });
		service.dispose();
	});
});

describe("routines: event triggers, once, run history", () => {
	const SESSION = "/sessions/bot.jsonl";
	const event = (source: "files" | "webhook" = "files"): ScheduleDraft["frequency"] =>
		source === "files"
			? { kind: "event", event: { source: "files", path: "/watched" } }
			: { kind: "event", event: { source: "webhook", key: "" } };

	/** A woken turn per wake, ended by the test (`end(i, result)`); `woke(n)` settles once n wakes came. */
	function routineHarness(dir: string) {
		const { launch } = fakeLauncher();
		const turns: { prompt: string; end: (result: { code: number | null; error?: string }) => void }[] = [];
		const waiters: { count: number; resolve: () => void }[] = [];
		const wake = vi.fn(async (schedule: Schedule): Promise<RunProcess> => {
			const { promise, resolve } = Promise.withResolvers<{ code: number | null; error?: string }>();
			turns.push({ prompt: schedule.prompt, end: resolve });
			for (const waiter of waiters.filter(item => turns.length >= item.count)) waiter.resolve();
			return { stop: () => resolve({ code: SUPERVISOR_STOPPED_CODE }), done: promise };
		});
		const woke = (count: number) => {
			if (turns.length >= count) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.push({ count, resolve });
			return promise;
		};
		const service = new ScheduleService({
			file: join(dir, "schedules.json"),
			logDir: join(dir, "runs"),
			launch,
			onState: () => {},
			wake,
		});
		return { service, turns, woke, wake };
	}

	async function routine(service: ScheduleService, dir: string, overrides: Partial<ScheduleDraft> = {}) {
		const { id } = await service.create(draft(dir, { frequency: event(), wakeSession: SESSION, ...overrides }));
		return id;
	}

	const ended = (service: ScheduleService, count: number) =>
		vi.waitFor(() => expect(service.state().runs.filter(run => run.status !== "running")).toHaveLength(count));

	it("an event starts a run told what fired it; events during it make exactly one more run with all of them", async () => {
		const dir = await tempDir();
		const { service, turns, woke } = routineHarness(dir);
		await service.start();
		const id = await routine(service, dir, { prompt: "Review the change" });
		expect(service.state().nextRuns[id]).toBeNull();
		expect(service.fire(id, "src/a.ts changed")).toBe(true);
		await woke(1);
		expect(turns[0]?.prompt).toBe("Review the change\n\nWhat fired this run:\nsrc/a.ts changed");
		expect(service.state().runs[0]).toMatchObject({
			trigger: "event",
			status: "running",
			detail: "src/a.ts changed",
		});
		expect(service.fire(id, "src/b.ts changed")).toBe(true);
		expect(service.fire(id, "src/c.ts changed")).toBe(true);
		turns[0]?.end({ code: 0 });
		await woke(2);
		expect(turns[1]?.prompt).toBe("Review the change\n\nWhat fired this run:\nsrc/b.ts changed\nsrc/c.ts changed");
		turns[1]?.end({ code: null, error: "The turn ended with an error" });
		await ended(service, 2);
		expect(service.state().runs.map(run => [run.status, run.error])).toEqual([
			["failed", "The turn ended with an error"],
			["succeeded", null],
		]);
		// Nothing else was kept: no third run.
		expect(turns).toHaveLength(2);
		service.dispose();
	});

	it("turns a routine off when its own runs keep firing it, and says why in its history", async () => {
		const dir = await tempDir();
		const { service, turns, woke } = routineHarness(dir);
		await service.start();
		const id = await routine(service, dir);
		service.fire(id, "change 0");
		for (let index = 0; index < ROUTINE_CHAIN_LIMIT; index++) {
			await woke(index + 1);
			// Every run's own work fires the trigger again before it ends.
			service.fire(id, `change ${index + 1}`);
			turns[index]?.end({ code: 0 });
		}
		await vi.waitFor(() => expect(service.state().schedules[0]?.enabled).toBe(false));
		expect(turns).toHaveLength(ROUTINE_CHAIN_LIMIT);
		expect(service.state().runs[0]).toMatchObject({ status: "skipped", trigger: "event" });
		expect(service.state().runs[0]?.error).toContain("its own work probably fires it");
		expect(service.fire(id, "later")).toBe(false);
		service.dispose();
	});

	it("fires nothing for a schedule that is no routine, is off, or while everything is paused", async () => {
		const dir = await tempDir();
		const { service } = routineHarness(dir);
		await service.start();
		const timed = (await service.create(draft(dir))).id;
		const off = await routine(service, dir, { enabled: false });
		const on = await routine(service, dir);
		expect(service.fire(timed, "x")).toBe(false);
		expect(service.fire(off, "x")).toBe(false);
		expect(service.fire("nope", "x")).toBe(false);
		await service.command({ action: "setPaused", paused: true });
		expect(service.fire(on, "x")).toBe(false);
		expect(service.state().runs).toEqual([]);
		service.dispose();
	});

	it("a test run of a routine says no event fired", async () => {
		const dir = await tempDir();
		const { service, turns, woke } = routineHarness(dir);
		await service.start();
		const id = await routine(service, dir, { prompt: "Look" });
		await service.command({ action: "runNow", id });
		await woke(1);
		expect(turns[0]?.prompt).toBe("Look\n\nTest run:\nA test run: no event fired");
		expect(service.state().runs[0]).toMatchObject({ trigger: "manual" });
		service.dispose();
	});

	it("a webhook gets its key on save, keeps it through an edit, and fires only for that key", async () => {
		const dir = await tempDir();
		const { service, woke, turns } = routineHarness(dir);
		await service.start();
		const id = await routine(service, dir, { frequency: event("webhook") });
		const stored = service.state().schedules[0]?.frequency;
		const key = stored?.kind === "event" && stored.event.source === "webhook" ? stored.event.key : "";
		expect(key.length).toBeGreaterThanOrEqual(32);
		await service.command({ action: "save", id, draft: draft(dir, { frequency: event("webhook"), prompt: "New" }) });
		expect(service.state().schedules[0]?.frequency).toEqual({ kind: "event", event: { source: "webhook", key } });
		expect(service.webhook(id, "wrong", "body")).toBe("denied");
		expect(service.webhook(id, `${key}x`, "body")).toBe("denied");
		expect(service.webhook("nope", key, "body")).toBe("unknown");
		expect(service.state().runs).toEqual([]);
		expect(service.webhook(id, key, 'Webhook call: {"ok":true}')).toBe("fired");
		await woke(1);
		expect(turns[0]?.prompt).toContain('Webhook call: {"ok":true}');
		turns[0]?.end({ code: 0 });
		await ended(service, 1);
		await service.command({ action: "setEnabled", id, enabled: false });
		expect(service.webhook(id, key, "x")).toBe("off");
		service.dispose();
	});

	it("a once routine starts at its moment, then is off and done; a moment already past is refused", async () => {
		fakeClock(new Date(2026, 9, 15, 12, 0));
		const dir = await tempDir();
		const { service, turns, woke } = routineHarness(dir);
		await service.start();
		const at = new Date(2026, 9, 15, 12, 30).toISOString();
		const id = await routine(service, dir, { frequency: { kind: "once", at } });
		expect(service.state().nextRuns[id]).toBe(at);
		await vi.advanceTimersByTimeAsync(30 * 60_000 + SCHEDULE_TICK_MS);
		await woke(1);
		expect(service.state().schedules[0]?.enabled).toBe(false);
		expect(service.state().nextRuns[id]).toBeNull();
		turns[0]?.end({ code: 0 });
		await ended(service, 1);
		await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
		expect(turns).toHaveLength(1);
		await expect(
			service.create(draft(dir, { frequency: { kind: "once", at: new Date(2026, 9, 15, 11, 0).toISOString() } })),
		).rejects.toThrow("the moment has passed");
		service.dispose();
	});

	it("a Test before a once routine's moment keeps that moment; moving a spent one to a new moment schedules it again", async () => {
		fakeClock(new Date(2026, 9, 15, 12, 0));
		const dir = await tempDir();
		const { service, turns, woke } = routineHarness(dir);
		await service.start();
		const at = new Date(2026, 9, 15, 12, 30).toISOString();
		const id = await routine(service, dir, { frequency: { kind: "once", at } });

		// Test now: a run, but the real start is still due at its moment.
		await service.command({ action: "runNow", id });
		await woke(1);
		turns[0]?.end({ code: 0 });
		await ended(service, 1);
		expect(service.state().schedules[0]?.enabled).toBe(true);
		expect(service.state().nextRuns[id]).toBe(at);
		await vi.advanceTimersByTimeAsync(30 * 60_000 + SCHEDULE_TICK_MS);
		await woke(2);
		expect(service.state().runs[0]).toMatchObject({ trigger: "schedule" });
		turns[1]?.end({ code: 0 });
		await ended(service, 2);
		expect(service.state().nextRuns[id]).toBeNull();

		// Spent, then moved to a new moment and turned on: it starts again at that moment.
		const later = new Date(2026, 9, 15, 14, 0).toISOString();
		await service.command({
			action: "save",
			id,
			draft: draft(dir, { frequency: { kind: "once", at: later }, wakeSession: SESSION, enabled: true }),
		});
		expect(service.state().nextRuns[id]).toBe(later);
		await vi.advanceTimersByTimeAsync(90 * 60_000 + SCHEDULE_TICK_MS);
		await woke(3);
		expect(service.state().runs[0]).toMatchObject({ trigger: "schedule" });
		service.dispose();
	});

	it("keeps each schedule's newest runs, so a busy routine never pushes out another's history", async () => {
		const dir = await tempDir();
		const { service, turns, woke } = routineHarness(dir);
		await service.start();
		const quiet = await routine(service, dir);
		const busy = await routine(service, dir);
		service.fire(quiet, "once");
		await woke(1);
		turns[0]?.end({ code: 0 });
		await ended(service, 1);
		for (let index = 0; index < SCHEDULE_RUNS_PER_SCHEDULE + 5; index++) {
			service.fire(busy, `event ${index}`);
			await woke(index + 2);
			turns[index + 1]?.end({ code: 0 });
			await ended(service, Math.min(index + 2, SCHEDULE_RUNS_PER_SCHEDULE + 1));
		}
		const runs = service.state().runs;
		expect(runs.filter(run => run.scheduleId === busy)).toHaveLength(SCHEDULE_RUNS_PER_SCHEDULE);
		expect(runs.filter(run => run.scheduleId === busy)[0]?.detail).toBe(`event ${SCHEDULE_RUNS_PER_SCHEDULE + 4}`);
		expect(runs.filter(run => run.scheduleId === quiet)).toHaveLength(1);
		service.dispose();
	});

	it("records a run the wake declines (the bot is paused) as skipped with the reason", async () => {
		const dir = await tempDir();
		const { service, wake } = routineHarness(dir);
		wake.mockRejectedValueOnce(new ScheduleSkip("The bot is paused"));
		await service.start();
		const id = await routine(service, dir);
		service.fire(id, "x");
		await ended(service, 1);
		expect(service.state().runs[0]).toMatchObject({ status: "skipped", error: "The bot is paused" });
		service.dispose();
	});

	it("tells runEnded each run once as it ended, a skipped one included, never a running one", async () => {
		const dir = await tempDir();
		const { launch } = fakeLauncher();
		const ends: [string, string, string | null][] = [];
		const wake = vi
			.fn<(schedule: Schedule) => Promise<RunProcess>>()
			.mockResolvedValueOnce({ stop: () => {}, done: Promise.resolve({ code: null, error: "rate limited" }) })
			.mockRejectedValueOnce(new ScheduleSkip("The bot is paused"));
		const service = new ScheduleService({
			file: join(dir, "schedules.json"),
			logDir: join(dir, "runs"),
			launch,
			onState: () => {},
			wake,
			runEnded: (schedule, run) => ends.push([schedule.name, run.status, run.error]),
		});
		await service.start();
		const id = await routine(service, dir, { name: "[agent] CI watch" });
		service.fire(id, "CI failed");
		await ended(service, 1);
		service.fire(id, "CI failed again");
		await ended(service, 2);
		expect(ends).toEqual([
			["[agent] CI watch", "failed", "rate limited"],
			["[agent] CI watch", "skipped", "The bot is paused"],
		]);
		service.dispose();
	});
});

describe("ompRunLauncher", () => {
	const FAKE = `
const prompt = await Bun.stdin.text();
console.log("args:" + JSON.stringify(process.argv.slice(2)));
console.log("prompt:" + prompt);
console.log("cwd:" + process.cwd());
if (prompt.includes("hang")) {
	await Bun.write(process.env.FAKE_PID_FILE, String(process.pid));
	setInterval(() => {}, 1000);
} else {
	console.error("warning on stderr");
	process.exit(3);
}
`;

	async function launch(
		dir: string,
		prompt: string,
		log = join(dir, "run.log"),
		extensionArgs?: string[],
		asked: string[] = [],
	) {
		const bin = await writeFakeOmp(dir, FAKE);
		const omp: OmpResolution = {
			ok: true,
			runtime: { bin, version: "99.0.0", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
		};
		const files = { log, prompt: join(dir, "run.prompt") };
		await writeFile(files.prompt, prompt);
		const run = await ompRunLauncher({
			omp: async () => omp,
			env: async () => ({ ...process.env, FAKE_PID_FILE: join(dir, "pid") }),
			...(extensionArgs
				? {
						extensionArgs: async (cwd: string) => {
							asked.push(cwd);
							return extensionArgs;
						},
					}
				: {}),
		})(
			{
				...draft(dir, { prompt, model: "anthropic/claude-x", autoApprove: true }),
				id: "s1",
				createdAt: new Date().toISOString(),
			},
			files,
		);
		return { run, files };
	}

	it("runs omp -p in the project folder with the prompt on stdin and both streams in the log", async () => {
		const dir = await tempDir();
		const { run, files } = await launch(dir, "line one\nline two");
		expect(await run.done).toEqual({ code: 3 });
		const log = await readFile(files.log, "utf8");
		expect(log).toContain('args:["-p","--model","anthropic/claude-x","--yolo"]');
		expect(log).toContain("prompt:line one\nline two");
		expect(log).toContain("warning on stderr");
		expect(log).toContain("cwd:");
	});

	it("a run loads ai-memory's extension root while memory is on (the extension flags come from the service)", async () => {
		const dir = await tempDir();
		const asked: string[] = [];
		const { run, files } = await launch(dir, "x", join(dir, "run.log"), ["-e", "/app/ai-memory/omp-ext"], asked);
		await run.done;
		expect(asked).toEqual([dir]);
		expect(await readFile(files.log, "utf8")).toContain(
			'args:["-p","-e","/app/ai-memory/omp-ext","--model","anthropic/claude-x","--yolo"]',
		);
	});

	it("an unwritable log neither crashes main nor stops the run", async () => {
		const dir = await tempDir();
		const unwritable = join(dir, "log-is-a-directory");
		await mkdir(unwritable);
		const uncaught: unknown[] = [];
		const onUncaught = (error: unknown) => uncaught.push(error);
		process.on("uncaughtException", onUncaught);
		try {
			const { run } = await launch(dir, "line one", unwritable);
			expect(await run.done).toEqual({ code: 3 });
			expect(uncaught).toEqual([]);
		} finally {
			process.off("uncaughtException", onUncaught);
		}
	});

	/**
	 * Another process's start and death have no event this process can await,
	 * so this one integration test polls them against the real clock.
	 */
	async function pollUntil(check: () => Promise<boolean> | boolean): Promise<boolean> {
		for (let attempt = 0; attempt < 200; attempt++) {
			if (await check()) return true;
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 25);
			await promise;
		}
		return false;
	}

	it("stop kills omp's process tree through the supervisor", async () => {
		const dir = await tempDir();
		const { run } = await launch(dir, "hang please");
		let pid = 0;
		await pollUntil(async () => {
			pid = Number(await readFile(join(dir, "pid"), "utf8").catch(() => "0"));
			return pid > 0;
		});
		expect(pid).toBeGreaterThan(0);
		run.stop();
		expect(await run.done).toEqual({ code: SUPERVISOR_STOPPED_CODE });
		const gone = await pollUntil(() => {
			try {
				process.kill(pid, 0);
				return false;
			} catch {
				return true;
			}
		});
		expect(gone).toBe(true);
	});
});
