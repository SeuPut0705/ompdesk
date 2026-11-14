/**
 * The gpu area (`src/main/gpu-fallback.ts`, `gpu-fallback-core.ts`, `launch-guard.ts`, `launch-guard-core.ts`): the pure
 * rules over their inputs, and whole launches as `index.ts` runs them (`startLaunchGuard`, the safe-mode log line,
 * `applyGpuFallbackIfNeeded`, then ready's `recordGpuIdentity`, the 20 s timer, `will-quit`, `child-process-gone`)
 * over real files in a fake profile folder. Each launch is a fresh `gpu-fallback.ts` instance (a query suffix), a fake
 * shell and a fixed clock; the runtime-log reports are taken as `writeRuntimeLog` receives them.
 */
import { mock } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Step } from "../capture-chrome";
import { fakeShell } from "./fake-shell";

const SRC = "../../../src/main";
const T0 = 1_800_000_000_000;
const DAY = 24 * 60 * 60_000;

type Device = Record<string, unknown>;
const iGpu = (driverVersion: string): Device => ({
	active: true,
	vendorId: 0x8086,
	deviceId: 0x9a49,
	driverVersion,
	driverDate: "2021-6-14",
});
const swiftShader: Device = { active: false, vendorId: 0xffff, deviceId: 0xffff, driverVersion: "5.0.0" };
const crash = { type: "GPU", reason: "crashed", exitCode: -1073741819 };

type Event =
	| { kind: "identity"; devices: Device[] | null }
	| { kind: "timer" }
	| { kind: "quit" }
	| { kind: "gone"; type: string; reason: string; exitCode: number | null; now: number; upMs: number };

interface Launch {
	guardOn: boolean;
	headless: boolean;
	switches: string[];
	now: number;
	marker: string | null;
	history: string | null;
	events: Event[];
}

type Files = Pick<Launch, "marker" | "history">;

const reports: Array<{ source: string; message: string; details?: object }> = [];
let launches = 0;

function parse(text: string | null): unknown {
	if (text === null) return null;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function gone(
	now: number,
	upMs: number,
	details: { type: string; reason: string; exitCode: number | null } = crash,
): Event {
	return { kind: "gone", ...details, now, upMs };
}

/** One launch as `index.ts` runs it. Returns the step and the raw files it left (the next launch's seeds). */
async function run(launch: Launch): Promise<{ step: Step; files: Files }> {
	const shell = await fakeShell();
	const clock = { now: launch.now };
	const realNow = Date.now;
	Date.now = () => clock.now;
	const headless = process.env.OMP_GUI_HEADLESS;
	if (launch.headless) process.env.OMP_GUI_HEADLESS = "1";
	else Reflect.deleteProperty(process.env, "OMP_GUI_HEADLESS");
	const markerFile = join(shell.userData, "gpu-fallback.json");
	const historyFile = join(shell.userData, "launch-history.json");
	if (launch.marker !== null) writeFileSync(markerFile, launch.marker);
	if (launch.history !== null) writeFileSync(historyFile, launch.history);
	for (const name of launch.switches) shell.electron.app.commandLine.appendSwitch(name);
	reports.length = 0;
	try {
		const guard = await import(`${SRC}/launch-guard.ts`);
		const guardCore = await import(`${SRC}/launch-guard-core.ts`);
		const gpu = await import(`${SRC}/gpu-fallback.ts?launch=${launches++}`);
		const { writeRuntimeLog } = await import(`${SRC}/runtime-log.ts`);
		// index.ts: the guard starts only with its lock, in a packaged run or when forced; safe mode is logged.
		const safeMode: boolean = launch.guardOn ? guard.startLaunchGuard(historyFile).safeMode : false;
		if (safeMode) {
			writeRuntimeLog({
				source: "launch-guard",
				message: `Safe mode: the last ${guardCore.CRASH_LOOP_LAUNCHES} launches ended within ${guardCore.STABLE_AFTER_MS / 1000} s of starting; software rendering, no automatic relaunch, setup paused`,
			});
		}
		const software: boolean = gpu.applyGpuFallbackIfNeeded(safeMode);
		const relaunches: boolean[] = [];
		for (const event of launch.events) {
			if (event.kind === "identity") {
				shell.answer("app.getGPUInfo", () => {
					if (event.devices === null) throw new Error("no GPU info");
					return { info: { gpuDevice: event.devices }, features: {} };
				});
				await gpu.recordGpuIdentity();
			} else if (event.kind === "timer") {
				if (launch.guardOn) guard.markLaunchStable();
				gpu.confirmHardwareTrial();
			} else if (event.kind === "quit") {
				if (launch.guardOn) guard.markLaunchStable();
			} else {
				clock.now = event.now;
				shell.take();
				gpu.handleGpuProcessGone(
					{ type: event.type, reason: event.reason, exitCode: event.exitCode ?? undefined },
					event.upMs,
				);
				await shell.settle();
				relaunches.push(shell.take().some(frame => frame.method === "app.relaunch"));
			}
		}
		const marker = existsSync(markerFile) ? readFileSync(markerFile, "utf8") : null;
		const history = existsSync(historyFile) ? readFileSync(historyFile, "utf8") : null;
		const { events, ...input } = launch;
		return {
			step: {
				fn: "src/main/gpu-fallback.ts#launch",
				input: { ...input, events },
				output: {
					software,
					safeMode,
					relaunches,
					marker: parse(marker),
					history: parse(history),
					logs: reports.map(r => ({
						source: r.source,
						message: r.message,
						...(r.details ? { details: r.details } : {}),
					})),
				},
			},
			files: { marker, history },
		};
	} finally {
		Date.now = realNow;
		if (headless === undefined) Reflect.deleteProperty(process.env, "OMP_GUI_HEADLESS");
		else process.env.OMP_GUI_HEADLESS = headless;
		shell.close();
	}
}

function launch(over: Partial<Launch> & Pick<Launch, "now">, files: Files = { marker: null, history: null }): Launch {
	return { guardOn: true, headless: false, switches: [], events: [], ...files, ...over };
}

const marker = (fields: Record<string, unknown>, at = T0): string =>
	JSON.stringify({ at: new Date(at).toISOString(), ...fields });

export async function capture(): Promise<Step[]> {
	const steps: Step[] = [];
	mock.module(`${SRC}/runtime-log.ts`, () => ({
		writeRuntimeLog: (report: { source: string; message: string; details?: object }) => reports.push(report),
		runtimeLogPath: () => "",
	}));
	const core = await import(`${SRC}/gpu-fallback-core.ts`);
	const history = await import(`${SRC}/launch-guard-core.ts`);
	const gpu = await import(`${SRC}/gpu-fallback.ts?pure`);

	// ---- pure rules ----
	const markers = [
		"not json",
		"",
		"null",
		"[]",
		"5",
		JSON.stringify({ reason: "crashed", exitCode: -1 }),
		JSON.stringify({ at: "2026-11-13T06:00:00.000Z", reason: "crashed", exitCode: -1, policy: 2 }),
		JSON.stringify({
			at: 1_790_000_000_000,
			reason: "oom",
			exitCode: null,
			gpu: iGpu("1.0"),
			seen: iGpu("2.0"),
			trialAt: 5,
			policy: 2,
		}),
		JSON.stringify({
			at: "yesterday",
			reason: 7,
			exitCode: "x",
			gpu: { vendorId: 0xffff, deviceId: 1 },
			seen: { vendorId: 1 },
			trialAt: "5",
			policy: "2",
		}),
		JSON.stringify({
			at: "2026-10-20",
			gpu: { vendorId: 4318, deviceId: 8, driverVersion: "", driverDate: "2020-1-1" },
		}),
		JSON.stringify({ at: "2026-10-20T03:38:33+02:00", reason: "killed", exitCode: 1073807364, policy: 2 }),
	];
	for (const text of markers) {
		steps.push({
			fn: "src/main/gpu-fallback-core.ts#parseGpuMarker",
			input: { text },
			output: core.parseGpuMarker(text),
		});
		steps.push({
			fn: "src/main/gpu-fallback.ts#markerForcesSoftware",
			input: { text },
			output: gpu.markerForcesSoftware(text),
		});
	}
	const decisionMarkers = [
		JSON.stringify({ at: T0, reason: "crashed", policy: 2 }),
		JSON.stringify({ at: T0, reason: "crashed" }),
		JSON.stringify({ at: T0, reason: "crashed", policy: 2, gpu: iGpu("1"), seen: iGpu("1") }),
		JSON.stringify({ at: T0, reason: "crashed", policy: 2, gpu: iGpu("1"), seen: iGpu("2") }),
		JSON.stringify({ at: T0, reason: "crashed", policy: 2, gpu: iGpu("1"), seen: { ...iGpu("1"), deviceId: 9 } }),
		JSON.stringify({ at: T0, trialAt: T0 + 3 * DAY, reason: "crashed", policy: 2 }),
		JSON.stringify({ at: T0, reason: "crashed", policy: 2, trialAt: T0 + DAY }),
	];
	for (const text of decisionMarkers) {
		for (const now of [T0, T0 + 6 * DAY, T0 + 7 * DAY - 1, T0 + 7 * DAY, T0 + 9 * DAY, T0 + 10 * DAY + 1]) {
			steps.push({
				fn: "src/main/gpu-fallback-core.ts#gpuMarkerDecision",
				input: { text, now },
				output: core.gpuMarkerDecision(core.parseGpuMarker(text), now),
			});
		}
		steps.push({
			fn: "src/main/gpu-fallback-core.ts#markerForTrial",
			input: { text, now: T0 + 8 * DAY },
			output: core.markerForTrial(core.parseGpuMarker(text), T0 + 8 * DAY),
		});
	}
	const deviceLists: unknown[] = [
		[],
		[swiftShader, iGpu("1")],
		[iGpu("1"), { ...iGpu("2"), active: false }],
		[
			{ ...iGpu("1"), active: false },
			{ ...iGpu("2"), vendorId: 0x10de, active: true },
		],
		[
			{ ...iGpu("1"), active: false },
			{ ...iGpu("2"), deviceId: 3, active: false },
		],
		[swiftShader],
		[
			{ vendorId: "x", deviceId: 1 },
			{ vendorId: 1, deviceId: 2, driverVersion: "", driverDate: "" },
		],
		[null, 5, "x", [], { active: true }],
		{},
		null,
		"gpu",
	];
	for (const devices of deviceLists) {
		steps.push({
			fn: "src/main/gpu-fallback-core.ts#gpuIdentityOf",
			input: { devices },
			output: core.gpuIdentityOf(devices) ?? null,
		});
	}
	const pairs: Array<[Device, Device]> = [
		[iGpu("1"), iGpu("1")],
		[iGpu("1"), iGpu("2")],
		[iGpu("1"), { ...iGpu("1"), deviceId: 4 }],
		[iGpu("1"), { ...iGpu("1"), vendorId: 4318 }],
		[iGpu("1"), { vendorId: 0x8086, deviceId: 0x9a49 }],
		[{ ...iGpu("1"), driverDate: "2022-1-1" }, iGpu("1")],
	];
	for (const [before, after] of pairs) {
		const identity = (device: Device) => core.gpuIdentityOf([device]);
		steps.push({
			fn: "src/main/gpu-fallback-core.ts#gpuChange",
			input: { before: identity(before), after: identity(after) },
			output: core.gpuChange(identity(before), identity(after)) ?? null,
		});
	}
	for (const type of ["GPU", "Tab", "Utility", "Renderer", ""]) {
		for (const reason of [
			"crashed",
			"oom",
			"launch-failed",
			"clean-exit",
			"killed",
			"abnormal-exit",
			"integrity-failure",
		]) {
			steps.push({
				fn: "src/main/gpu-fallback.ts#isGpuProcessCrash",
				input: { type, reason },
				output: gpu.isGpuProcessCrash({ type, reason }),
			});
		}
	}
	const histories = [
		undefined,
		"",
		"{not json",
		"{}",
		"[]",
		"5",
		JSON.stringify([
			{ at: 1, stable: true },
			5,
			null,
			{ at: "x" },
			{ at: 2, gpuRelaunchAt: 3, safeMode: true },
			{ at: 4, stable: 1 },
			{ at: Number.MAX_SAFE_INTEGER, gpuRelaunchAt: "x" },
		]),
		JSON.stringify([
			{ at: T0 },
			{ at: T0 + 1000, stable: true },
			{ at: T0 + 2000, gpuRelaunchAt: T0 + 2500, safeMode: true },
		]),
	];
	for (const text of histories) {
		steps.push({
			fn: "src/main/launch-guard-core.ts#parseLaunchHistory",
			input: { text: text ?? null },
			output: history.parseLaunchHistory(text),
		});
	}
	const at = (offset: number, extra: object = {}) => ({ at: T0 + offset, ...extra });
	const loops: Array<[string, unknown[]]> = [
		["none", []],
		["two", [at(0), at(1000)]],
		["three", [at(0), at(1000), at(2000)]],
		["one stable", [at(0), at(1000, { stable: true }), at(2000)]],
		["four, the last three", [at(0, { stable: true }), at(1000), at(2000), at(3000)]],
		["old", [at(0), at(1000), at(2000)]],
		["safe launches count too", [at(0, { safeMode: true }), at(1000, { safeMode: true }), at(2000)]],
	];
	for (const [name, previous] of loops) {
		for (const now of [
			T0 + 3000,
			T0 + 2000 + history.CRASH_LOOP_WINDOW_MS,
			T0 + 2001 + history.CRASH_LOOP_WINDOW_MS,
			T0 - 5000,
		]) {
			steps.push({
				fn: "src/main/launch-guard-core.ts#crashLoopDetected",
				input: { previous, now, name },
				output: history.crashLoopDetected(previous, now),
			});
		}
	}
	const now = T0 + 5 * DAY;
	const histories2: Array<[string, unknown[]]> = [
		["empty", []],
		["no relaunch", [at(0), at(10)]],
		["old relaunch", [at(0, { gpuRelaunchAt: now - history.GPU_RELAUNCH_COOLDOWN_MS })]],
		["recent relaunch", [at(0, { gpuRelaunchAt: now - 1000 })]],
		[
			"latest of several",
			[at(0, { gpuRelaunchAt: now - 20 * 60_000 }), at(5, { gpuRelaunchAt: now - 60_000 }), at(6)],
		],
	];
	for (const [name, list] of histories2) {
		for (const software of [false, true]) {
			for (const safeMode of [false, true]) {
				for (const testLaunch of [false, true]) {
					for (const upMs of [
						undefined,
						3000,
						history.GPU_CRASH_SETTLED_MS - 1,
						history.GPU_CRASH_SETTLED_MS,
						40 * 60_000,
					]) {
						for (const crashedBefore of [undefined, now - 30_000, now - history.GPU_RELAUNCH_COOLDOWN_MS]) {
							const input = { software, safeMode, testLaunch, history: list, now, upMs, crashedBefore };
							steps.push({
								fn: "src/main/launch-guard-core.ts#gpuRelaunchDecision",
								input: { ...input, name },
								output: history.gpuRelaunchDecision(input),
							});
						}
					}
				}
			}
		}
	}

	// ---- launches: dev runs first (the guard module's state is process-wide: nothing may have started it yet) ----
	const record = async (input: Launch): Promise<Files> => {
		const { step, files } = await run(input);
		steps.push(step);
		return files;
	};
	await record(launch({ now: T0, guardOn: false, events: [gone(T0 + 1000, 1000)] }));
	await record(launch({ now: T0, guardOn: false, switches: ["disable-gpu"], events: [gone(T0 + 1000, 1000)] }));
	await record(
		launch({
			now: T0,
			guardOn: false,
			marker: marker({ reason: "crashed", exitCode: -1, policy: 2 }, T0 - 1000),
			events: [gone(T0 + 1000, 1000)],
		}),
	);
	await record(
		launch({
			now: T0,
			guardOn: false,
			switches: ["enable-gpu"],
			marker: marker({ reason: "crashed", exitCode: -1, policy: 2 }, T0 - 1000),
			events: [{ kind: "timer" }],
		}),
	);

	// A marker's own launch never relaunches.
	await record(
		launch({
			now: T0,
			marker: marker({ reason: "crashed", exitCode: -1, policy: 2 }, T0),
			events: [gone(T0 + 1000, 1000), gone(T0 + 2000, 2000)],
		}),
	);
	await record(launch({ now: T0, switches: ["disable-gpu"], events: [gone(T0 + 1000, 1000)] }));

	// A hardware launch relaunches once into software, and that launch stays up.
	let files = await record(launch({ now: T0, events: [gone(T0 + 100, 100)] }));
	files = await record(launch({ now: T0 + 1000, events: [gone(T0 + 1100, 100), gone(T0 + 1200, 200)] }, files));
	// At most once per 10 minutes, even with --enable-gpu.
	files = await record(launch({ now: T0 + 2000, switches: ["enable-gpu"], events: [gone(T0 + 2100, 100)] }, files));
	await record(launch({ now: T0 + 3000, events: [{ kind: "quit" }] }, files));
	// ...and after the cooldown the same launch relaunches again.
	files = await record(
		launch({ now: T0 + 2000, events: [gone(T0 + 2100, 100)] }, { marker: null, history: files.history }),
	);
	files = await record(
		launch({ now: T0 + 11 * 60_000, switches: ["enable-gpu"], events: [gone(T0 + 11 * 60_000 + 100, 100)] }, files),
	);

	// Safe mode: three launches that never became stable, then a fourth whatever the switches say.
	files = { marker: null, history: null };
	for (let i = 0; i < 3; i++) files = await record(launch({ now: T0 + i * 1000, switches: ["enable-gpu"] }, files));
	await record(
		launch({ now: T0 + 3000, switches: ["enable-gpu"], events: [gone(T0 + 3100, 100), { kind: "quit" }] }, files),
	);
	// A safe-mode launch that stays up ends safe mode for the next one.
	files = await record(launch({ now: T0 + 3000, events: [{ kind: "timer" }] }, files));
	await record(launch({ now: T0 + 60_000 }, files));
	// Launches long ago are no loop.
	files = { marker: null, history: null };
	for (let i = 0; i < 3; i++) files = await record(launch({ now: T0 + i * 1000 }, files));
	await record(launch({ now: T0 + 2000 + history.CRASH_LOOP_WINDOW_MS + 1000 }, files));
	await record(launch({ now: T0, history: "{not json", events: [gone(T0 + 10, 10)] }));

	// A test launch (OMP_GUI_HEADLESS) never relaunches.
	await record(launch({ now: T0, headless: true, guardOn: false, events: [gone(T0 + 10, 10)] }));
	await record(launch({ now: T0, headless: true, events: [gone(T0 + 10, 10)] }));

	// Hardware comes back by itself.
	const launchWith = (device: Device, over: Partial<Launch> & Pick<Launch, "now">, seeds: Files): Promise<Files> =>
		record(
			launch(
				{
					...over,
					events: [{ kind: "identity", devices: [swiftShader, device] }, { kind: "quit" }, ...(over.events ?? [])],
				},
				seeds,
			),
		);
	files = { marker: null, history: null };
	files = await launchWith(iGpu("27.20.100.9466"), { now: T0, events: [gone(T0 + 5, 5)] }, files);
	files = await launchWith(iGpu("27.20.100.9466"), { now: T0 + 60_000 }, files);
	files = await launchWith(iGpu("27.20.100.9466"), { now: T0 + 120_000 }, files);
	// The driver changed: the software launch sees it, the next one tries hardware once.
	files = await launchWith(iGpu("31.0.101.5186"), { now: T0 + 180_000 }, files);
	const seen = files;
	files = await launchWith(iGpu("31.0.101.5186"), { now: T0 + 240_000, events: [{ kind: "timer" }] }, files);
	files = await launchWith(iGpu("31.0.101.5186"), { now: T0 + 300_000 }, files);
	// A trial that ends without a verdict leaves the next one in software.
	files = await launchWith(iGpu("31.0.101.5186"), { now: T0 + 240_000 }, seen);
	files = await launchWith(iGpu("31.0.101.5186"), { now: T0 + 300_000 }, files);
	// A crash in the trial goes back to software without a second relaunch inside the cap.
	files = await launchWith(iGpu("31.0.101.5186"), { now: T0 + 240_000, events: [gone(T0 + 245_000, 5000)] }, seen);
	files = await launchWith(iGpu("31.0.101.5186"), { now: T0 + 300_000 }, files);
	await launchWith(iGpu("31.0.101.5186"), { now: T0 + 360_000 }, files);
	// A different GPU, a GPU info that cannot be read, a software launch with nothing named.
	await launchWith(
		{ ...iGpu("27.20.100.9466"), vendorId: 0x10de, deviceId: 5 },
		{ now: T0 + 60_000 },
		{ marker: seen.marker, history: null },
	);
	await record(
		launch(
			{ now: T0 + 60_000, events: [{ kind: "identity", devices: null }] },
			{ marker: seen.marker, history: null },
		),
	);
	await record(
		launch(
			{ now: T0 + 60_000, events: [{ kind: "identity", devices: [swiftShader] }] },
			{ marker: seen.marker, history: null },
		),
	);
	// Seven days later (cool-off), then confirmed.
	const eightDaysAgo = marker({ reason: "crashed", exitCode: -1, policy: 2 }, T0 - 8 * DAY);
	files = await launchWith(
		iGpu("27.20.100.9466"),
		{ now: T0, events: [{ kind: "timer" }] },
		{ marker: eightDaysAgo, history: null },
	);
	await launchWith(iGpu("27.20.100.9466"), { now: T0 + 60_000 }, files);
	// An older build's marker (no policy) gets one hardware trial; one that cannot be removed... is not simulated here.
	const older = JSON.stringify({
		at: new Date(T0).toISOString(),
		reason: "crashed",
		exitCode: 34,
		gpu: iGpu("32.0.16.2101"),
	});
	files = await launchWith(
		iGpu("32.0.16.2101"),
		{ now: T0 + 1, events: [{ kind: "timer" }] },
		{ marker: older, history: null },
	);
	await launchWith(iGpu("32.0.16.2101"), { now: T0 + 60_000 }, files);
	// A killed marker is stale and goes; an unreadable one still forces software.
	await record(launch({ now: T0, marker: marker({ reason: "killed", exitCode: 1073807364 }) }));
	await record(launch({ now: T0, marker: "not json", events: [gone(T0 + 10, 10)] }));
	await record(launch({ now: T0, marker: "", events: [{ kind: "timer" }] }));

	// A crash in a launch that has run for a while.
	const settled = 40 * 60_000;
	files = await launchWith(
		iGpu("27.20.100.9466"),
		{ now: T0, events: [gone(T0 + settled, settled)] },
		{ marker: null, history: null },
	);
	await launchWith(iGpu("27.20.100.9466"), { now: T0 + 60_000 }, files);
	await launchWith(
		iGpu("27.20.100.9466"),
		{ now: T0, events: [gone(T0 + settled, settled), gone(T0 + settled + 30_000, settled + 30_000)] },
		{ marker: null, history: null },
	);
	await launchWith(
		iGpu("27.20.100.9466"),
		{ now: T0, events: [gone(T0 + settled, settled), gone(T0 + settled + 11 * 60_000, settled + 11 * 60_000)] },
		{ marker: null, history: null },
	);
	await launchWith(
		iGpu("27.20.100.9466"),
		{ now: T0, events: [gone(T0 + 3000, 3000)] },
		{ marker: null, history: null },
	);
	// A crash with no exit code, a killed and a clean GPU exit, and a crash of another process.
	await record(
		launch({
			now: T0,
			events: [
				gone(T0 + 10, 10, { type: "GPU", reason: "killed", exitCode: 1073807364 }),
				gone(T0 + 20, 20, { type: "GPU", reason: "clean-exit", exitCode: 0 }),
				gone(T0 + 30, 30, { type: "Utility", reason: "crashed", exitCode: 1 }),
			],
		}),
	);
	await record(
		launch({ now: T0, events: [gone(T0 + 10, 10, { type: "GPU", reason: "launch-failed", exitCode: null })] }),
	);
	await record(launch({ now: T0, events: [gone(T0 + 10, 10, { type: "GPU", reason: "oom", exitCode: 7 })] }));
	// A crash in a hardware launch under a marker written in a crash of an unknown GPU keeps the GPU the marker names.
	await record(
		launch({
			now: T0 + 1,
			marker: marker({ reason: "crashed", policy: 1, gpu: iGpu("9.9") }),
			events: [gone(T0 + 50, 50)],
		}),
	);
	return steps;
}
