/**
 * The hang area (`src/main/hang-watchdog-core.ts`, `hang-watchdog.ts`): the detector over scripted clocks, the step
 * ring, the marker file's reading, and the line the next launch writes for the previous run's stall. The worker
 * (`hang-watchdog-worker.ts`) only wires the detector and the ring to a timer and a port, so it is not captured: its
 * logic (the snapshot taken at the hang, the rewrite as recovered) is `chrome_core::hang::Watch`'s own test.
 */
import { mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Step } from "../capture-chrome";
import { fakeShell } from "./fake-shell";

const SRC = "../../../src/main";
const CHECK = 1_000;
const TIMEOUT = 5_000;

type Op = { op: "step"; beat: boolean; ms?: number } | { op: "jump"; ms: number } | { op: "tick" } | { op: "reset" };

const beats = (beat: boolean, times: number): Op[] => Array.from({ length: times }, () => ({ op: "step", beat }));

const DETECTOR_SCENARIOS: Array<[string, Op[]]> = [
	["quiet while heartbeats come", beats(true, 30)],
	[
		"a hang once, after the timeout",
		[{ op: "step", beat: true }, ...beats(false, 5), ...beats(false, 1), ...beats(false, 10)],
	],
	[
		"a tick gap is a suspend",
		[{ op: "step", beat: true }, { op: "jump", ms: 10 * 60_000 }, { op: "tick" }, ...beats(false, 6)],
	],
	[
		"resolution and a later stall",
		[...beats(false, 8), { op: "step", beat: true }, ...beats(true, 3), ...beats(false, 7)],
	],
	[
		"the first tick after a long stall is no sleep",
		[...beats(false, 20), { op: "step", beat: true }, { op: "step", beat: false }],
	],
	[
		"reset waits for fresh heartbeats",
		[{ op: "step", beat: true }, ...beats(false, 4), { op: "reset" }, ...beats(false, 2)],
	],
	["a reset then a real stall", [{ op: "reset" }, ...beats(false, 7)]],
	[
		"uneven ticks",
		[
			{ op: "step", beat: true, ms: 500 },
			{ op: "step", beat: false, ms: 2500 },
			{ op: "step", beat: false, ms: 2900 },
			{ op: "step", beat: false, ms: 1000 },
			{ op: "step", beat: true, ms: 1000 },
		],
	],
	[
		"a tick gap of exactly three intervals",
		[
			{ op: "step", beat: true },
			{ op: "step", beat: false, ms: 3 * CHECK },
			{ op: "step", beat: false, ms: 3 * CHECK + 1 },
			...beats(false, 7),
		],
	],
	[
		"a hang right at the timeout",
		[
			{ op: "step", beat: true },
			{ op: "step", beat: false, ms: TIMEOUT },
			{ op: "step", beat: false, ms: 1 },
		],
	],
];

const RING_SCENARIOS: Array<[string, Array<{ enter: [string, string] } | { snapshot: true }>]> = [
	["empty", [{ snapshot: true }]],
	[
		"bounded history",
		[
			...Array.from({ length: 11 }, (_, i) => ({ enter: ["startup", `step-${i}`] as [string, string] })),
			{ enter: ["quit", "teardown:sidecars"] },
			{ snapshot: true },
		],
	],
	[
		"the snapshot taken at the hang",
		[
			{ enter: ["update", "quit-and-install"] },
			{ snapshot: true },
			{ enter: ["quit", "will-quit"] },
			{ snapshot: true },
		],
	],
	[
		"every phase",
		[
			{ enter: ["startup", "a"] },
			{ enter: ["running", "b"] },
			{ enter: ["quit", "c"] },
			{ enter: ["update", "d"] },
			{ snapshot: true },
		],
	],
];

const MARKERS: Record<string, string> = {
	plain: JSON.stringify({ detectedAt: 1_700_000_000_000, pid: 4242, unresponsiveMs: 6_100, selfRecovered: false }),
	recovered: JSON.stringify({ detectedAt: 1_700_000_000_000, pid: 4242, unresponsiveMs: 9_000, selfRecovered: true }),
	steps: JSON.stringify({
		detectedAt: 1,
		pid: 7,
		unresponsiveMs: 5_300,
		selfRecovered: true,
		phase: "quit",
		steps: ["update:quit-and-install", "quit:teardown:sidecars"],
	}),
	"long steps": JSON.stringify({
		detectedAt: 1,
		pid: 7,
		unresponsiveMs: 5_300,
		selfRecovered: false,
		phase: "running",
		steps: Array.from({ length: 12 }, (_, i) => `running:s${i}`),
	}),
	"nonsense phase": JSON.stringify({
		detectedAt: 1,
		pid: 7,
		unresponsiveMs: 5_300,
		selfRecovered: true,
		phase: "nonsense",
		steps: [1, 2],
	}),
	"phase without steps": JSON.stringify({
		detectedAt: 1,
		pid: 7,
		unresponsiveMs: 5_300,
		selfRecovered: true,
		phase: "quit",
	}),
	"steps not text": JSON.stringify({
		detectedAt: 1,
		pid: 7,
		unresponsiveMs: 5_300,
		selfRecovered: true,
		phase: "quit",
		steps: ["a", 2],
	}),
	"recovered is not true": JSON.stringify({ detectedAt: 1, pid: 7, unresponsiveMs: 5_300, selfRecovered: "yes" }),
	fraction: JSON.stringify({ detectedAt: 1_700_000_000_000, pid: 12, unresponsiveMs: 5_628.5, selfRecovered: true }),
	"bad pid": JSON.stringify({ detectedAt: 1, pid: -3, unresponsiveMs: 5 }),
	"pid zero": JSON.stringify({ detectedAt: 1, pid: 0, unresponsiveMs: 5 }),
	"pid fraction": JSON.stringify({ detectedAt: 1, pid: 1.5, unresponsiveMs: 5 }),
	"negative time": JSON.stringify({ detectedAt: 1, pid: 3, unresponsiveMs: -1 }),
	"no detectedAt": JSON.stringify({ pid: 3, unresponsiveMs: 1 }),
	"text time": JSON.stringify({ detectedAt: "now", pid: 3, unresponsiveMs: 1 }),
	array: "[]",
	null: "null",
	number: "5",
	corrupt: "{not json",
	empty: "",
	"too big": JSON.stringify({ detectedAt: 1, pid: 3, unresponsiveMs: 1, pad: "x".repeat(70_000) }),
};

const REPORTED = ["plain", "recovered", "steps", "long steps", "fraction"];

export async function capture(): Promise<Step[]> {
	const steps: Step[] = [];
	const reports: object[] = [];
	mock.module(`${SRC}/runtime-log.ts`, () => ({
		writeRuntimeLog: (report: object) => reports.push(report),
		runtimeLogPath: () => "",
	}));
	const core = await import(`${SRC}/hang-watchdog-core.ts`);
	const watchdog = await import(`${SRC}/hang-watchdog.ts`);

	for (const [name, ops] of DETECTOR_SCENARIOS) {
		let now = 0;
		const hangs: number[] = [];
		const resolved: number[] = [];
		const detector = core.createHangDetector({
			timeoutMs: TIMEOUT,
			checkIntervalMs: CHECK,
			now: () => now,
			onHang: (ms: number) => hangs.push(ms),
			onResolved: (ms: number) => resolved.push(ms),
		});
		for (const op of ops) {
			if (op.op === "step") {
				now += op.ms ?? CHECK;
				if (op.beat) detector.heartbeat();
				detector.tick();
			} else if (op.op === "jump") now += op.ms;
			else if (op.op === "tick") detector.tick();
			else detector.reset();
		}
		steps.push({
			fn: "src/main/hang-watchdog-core.ts#createHangDetector",
			input: { name, ops },
			output: { hangs, resolved },
		});
	}

	for (const [name, ops] of RING_SCENARIOS) {
		const ring = core.createStepRing();
		const snapshots: unknown[] = [];
		for (const op of ops) {
			if ("enter" in op) ring.enter(op.enter[0], op.enter[1]);
			else snapshots.push(ring.snapshot());
		}
		steps.push({ fn: "src/main/hang-watchdog-core.ts#createStepRing", input: { name, ops }, output: snapshots });
	}

	const dir = mkdtempSync(join(tmpdir(), "capture-hang-"));
	try {
		for (const [name, raw] of Object.entries(MARKERS)) {
			const file = join(dir, "main-thread-hang.json");
			writeFileSync(file, raw);
			steps.push({
				fn: "src/main/hang-watchdog-core.ts#consumeHangMarker",
				input: { name, raw },
				output: core.consumeHangMarker(file),
			});
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}

	const shell = await fakeShell();
	try {
		for (const name of REPORTED) {
			mkdirSync(join(shell.userData, "logs"), { recursive: true });
			writeFileSync(watchdog.hangMarkerPath(), MARKERS[name] as string);
			reports.length = 0;
			watchdog.reportPreviousHang();
			steps.push({
				fn: "src/main/hang-watchdog.ts#reportPreviousHang",
				input: { name, raw: MARKERS[name] },
				output: reports[0] ?? null,
			});
		}
	} finally {
		shell.close();
	}
	return steps;
}
