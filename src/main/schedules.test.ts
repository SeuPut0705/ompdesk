import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Schedule, ScheduleDraft, SchedulesState } from "../shared/schedules";
import type { OmpResolution } from "./omp-runtime";
import {
	ompRunLauncher,
	type RunLauncher,
	type RunProcess,
	SCHEDULE_TICK_MS,
	ScheduleService,
	type ScheduleServiceOptions,
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

	function wakeHarness(dir: string, options: Partial<ScheduleServiceOptions> = {}) {
		const { launch } = fakeLauncher();
		const woken: { prompt: string; session: string | undefined; runId: string }[] = [];
		const wake = vi.fn(async (schedule: Schedule, runId: string) => {
			woken.push({ prompt: schedule.prompt, session: schedule.wakeSession, runId });
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
		expect(await service.readLog(service.state().runs[0]?.id ?? "")).toBe(`Woke ${SESSION}\n`);
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
