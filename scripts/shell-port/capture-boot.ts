/**
 * Batch SX5 (`boot.*`, PROTOCOL.md §15.3): records what the TypeScript that moves into the shell does, before it is
 * deleted, as `crates/shell/src/boot_core/captured.json`; `cargo test` replays it against `boot_core`. Run once with
 * `bun scripts/shell-port/capture-boot.ts` on the commit named in the file's head.
 *
 * Captured: `fillText` (main's text placeholders), the powercfg readers, the lid policy (`LidAwake`) over a fake
 * backend, the Windows lid backend over a fake powercfg, and `MediaStreams` answering a player's requests.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaStreams } from "../../src/main/media-stream";
import { LidAwake, type LidBackend } from "../../src/main/power/lid-awake";
import {
	type LidMarker,
	parseAcValue,
	parseActiveScheme,
	restoreCommands,
	WindowsLidBackend,
} from "../../src/main/power/lid-backend-windows";
import { fillText } from "../../src/shared/fill-text";

const OUT = join(import.meta.dir, "../../native/ompdesk/crates/shell/src/boot_core/captured.json");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
function attempt<T>(run: () => T): { ok: T } | { error: string } {
	try {
		return { ok: run() };
	} catch (error) {
		return { error: errorText(error) };
	}
}

// --- fillText -------------------------------------------------------------------------------------------------
const fillCases: [string, Record<string, string | number> | undefined][] = [
	["plain", undefined],
	["{name} and {name}", { name: "x" }],
	["{missing} stays", { other: 1 }],
	["{count} session{plural}", { count: 1 }],
	["{count} session{plural}", { count: 2 }],
	["{count} session{plural}", { count: "1,204" }],
	["{count} session{plural}", { count: "1" }],
	["{count} session{plural}", { count: "1+" }],
	["{count} session{plural}", { count: 0 }],
	["{count} session{plural}", { count: 2, plural: "!" }],
	["{tools} tool call{toolsPlural}", { tools: 1 }],
	["{tools} tool call{toolsPlural}", { tools: 3 }],
	["{tools} tool call{toolsPlural}", { tools: " 1 " }],
	["{path}", { path: "C:\\a\\{name}\\$&" }],
	["{name}", { name: "$1 $& $$" }],
	["{a}{b}{a}", { a: "1", b: "two" }],
	["{n}", { n: "1\u00a0000" }],
	["{n}x{nPlural}", { n: "1'000" }],
	["{n}x{nPlural}", { n: "1 " }],
	["{n}x{nPlural}", { n: "abc" }],
	["{ spaced }", { spaced: "x" }],
	["{한}", { 한: "x" }],
	["{under_score}", { under_score: "ok" }],
	["{}", { "": "empty" }],
	["{n}{nPlural}", { n: 1.5 }],
	["{n}{nPlural}", { n: -1 }],
];
const fill = fillCases.map(([template, params]) => ({
	template,
	params: params ?? null,
	out: fillText(template, params),
}));

// --- powercfg -------------------------------------------------------------------------------------------------
const BALANCED = "381b4222-f694-41f0-9685-ff5bb260df2e";
const SUB = "4f971e89-eebd-4455-a8de-9e59040e7347";
const LID = "5ca83367-6e45-459f-a27b-476b1d01c936";

function queryOutput(ac: number, dc: number, korean = false): string {
	const hex = (value: number) => `0x${value.toString(16).padStart(8, "0")}`;
	const [acLabel, dcLabel] = korean
		? ["현재 AC 전원 설정 인덱스", "현재 DC 전원 설정 인덱스"]
		: ["Current AC Power Setting Index", "Current DC Power Setting Index"];
	return [
		`Power Scheme GUID: ${BALANCED}  (Balanced)`,
		"  GUID Alias: SCHEME_BALANCED",
		`  Subgroup GUID: ${SUB}  (Power buttons and lid)`,
		"    GUID Alias: SUB_BUTTONS",
		`    Power Setting GUID: ${LID}  (Lid close action)`,
		"      GUID Alias: LIDACTION",
		"      Possible Setting Index: 000",
		"      Possible Setting Friendly Name: Do nothing",
		"      Possible Setting Index: 001",
		"      Possible Setting Friendly Name: Sleep",
		`    ${acLabel}: ${hex(ac)}`,
		`    ${dcLabel}: ${hex(dc)}`,
		"",
	].join("\r\n");
}

const schemeInputs = [
	`Power Scheme GUID: ${BALANCED}  (Balanced)\r\n`,
	`Power Scheme GUID: ${BALANCED.toUpperCase()}  (Balanced)`,
	`전원 구성표 GUID: ${BALANCED}  (균형 조정)`,
	"no guid here",
	"",
	`x ${BALANCED.slice(0, 35)}`,
];
const acInputs = [
	queryOutput(1, 2),
	queryOutput(3, 0, true),
	queryOutput(0, 1),
	queryOutput(255, 0),
	"nothing here",
	`A: 0x1\r\n`,
	`A: 0x1\r\nB: 0x2\r\nC: 0x3\r\n`,
	"A: 0X0000000A\nB: 0x2\n",
	"A: 0x1   \nB: 0x2\t\n",
];
const markers: LidMarker[] = [
	{ scheme: BALANCED, ac: 1, at: 1 },
	{ scheme: BALANCED, ac: 0, at: 1 },
];
const powercfg = {
	activeScheme: schemeInputs.map(input => ({ input, ...attempt(() => parseActiveScheme(input)) })),
	acValue: acInputs.map(input => ({ input, ...attempt(() => parseAcValue(input)) })),
	restore: markers.flatMap(marker =>
		[queryOutput(0, 1), queryOutput(1, 1), "bad"].map(query => ({
			marker,
			query,
			...attempt(() => restoreCommands(marker, query)),
		})),
	),
};

// --- the lid policy -------------------------------------------------------------------------------------------
interface LidScenario {
	name: string;
	options: { onAc?: boolean; laptop?: boolean; holdFails?: boolean; releaseFails?: number };
	/** `work` / `host`: start a blocker of that label; `stop:<n>`: stop the n-th started (1-based); `ac:on`/`ac:off`;
	 * `dispose`. Every step is followed by the policy settling. */
	steps: string[];
}

const lidScenarios: LidScenario[] = [
	{ name: "work on AC", options: {}, steps: ["work", "stop:1"] },
	{ name: "work and host together", options: {}, steps: ["work", "host", "stop:1", "stop:2"] },
	{ name: "battery then AC then battery", options: { onAc: false }, steps: ["work", "ac:on", "ac:off"] },
	{ name: "no battery", options: { laptop: false }, steps: ["work", "stop:1", "work"] },
	{ name: "hold fails twice", options: { holdFails: true }, steps: ["work", "stop:1", "work"] },
	{ name: "release fails once", options: { releaseFails: 1 }, steps: ["work", "stop:1", "ac:off"] },
	{ name: "quit while held", options: {}, steps: ["work", "dispose"] },
	{ name: "quit after a failed hold", options: { holdFails: true }, steps: ["work", "dispose"] },
	{ name: "quit with nothing held", options: {}, steps: ["dispose"] },
	{ name: "inputs after quit", options: {}, steps: ["dispose", "work", "ac:off", "ac:on"] },
	{ name: "same AC twice", options: {}, steps: ["ac:on", "work", "ac:on", "stop:1"] },
	{ name: "battery without work", options: {}, steps: ["ac:off", "ac:on", "work", "ac:off", "ac:on", "stop:1"] },
	{ name: "stop unknown", options: {}, steps: ["stop:1", "work", "stop:2", "stop:1", "stop:1"] },
];

async function runLid(scenario: LidScenario) {
	let releaseFailures = scenario.options.releaseFails ?? 0;
	const calls: string[] = [];
	const backend: LidBackend = {
		name: "fake",
		isLaptop: async () => {
			calls.push("isLaptop");
			return scenario.options.laptop ?? true;
		},
		recover: async () => {
			calls.push("recover");
			return null;
		},
		hold: async () => {
			calls.push("hold");
			if (scenario.options.holdFails) throw new Error("hold failed");
			return { changed: true, details: { scheme: "s" } };
		},
		release: async () => {
			calls.push("release");
			if (releaseFailures-- > 0) throw new Error("release failed");
		},
		releaseNow: () => {
			calls.push("releaseNow");
		},
	};
	const logs: { message: string; details: Record<string, unknown> }[] = [];
	const lid = new LidAwake({
		backend,
		onAc: scenario.options.onAc ?? true,
		log: (message, details) => logs.push({ message, details }),
	});
	let next = 0;
	const inner = { start: () => ++next, stop: () => {} };
	const blockers = { work: lid.wrap(inner, "work"), host: lid.wrap(inner, "host") };
	const started: { label: "work" | "host"; id: number }[] = [];
	const after: { step: string; held: boolean; calls: number; logs: number }[] = [];
	for (const step of scenario.steps) {
		if (step === "work" || step === "host") started.push({ label: step, id: blockers[step].start() });
		else if (step.startsWith("stop:")) {
			const entry = started[Number(step.slice(5)) - 1];
			if (entry) blockers[entry.label].stop(entry.id);
			else blockers.work.stop(1000 + Number(step.slice(5)));
		} else if (step === "ac:on") lid.setOnAc(true);
		else if (step === "ac:off") lid.setOnAc(false);
		else if (step === "dispose") lid.dispose();
		await lid.settled();
		after.push({ step, held: lid.held, calls: calls.length, logs: logs.length });
	}
	return { ...scenario, calls, logs, after };
}

const lid = [];
for (const scenario of lidScenarios) lid.push(await runLid(scenario));

// --- the Windows lid backend ----------------------------------------------------------------------------------
interface WinScenario {
	name: string;
	initial: { ac: number; dc: number };
	/** `hold`, `release`, `releaseNow`, `recover` (a fresh backend over the same marker), `user:<ac>` (the person
	 * changes the AC value), `fail:<verb>#<n>`, `marker:<text>` (the marker file's content). */
	steps: string[];
}

const winScenarios: WinScenario[] = [
	{ name: "hold and release", initial: { ac: 1, dc: 1 }, steps: ["hold", "release"] },
	{ name: "already do nothing", initial: { ac: 0, dc: 1 }, steps: ["hold", "release"] },
	{ name: "user changed it while held", initial: { ac: 2, dc: 1 }, steps: ["hold", "user:1", "release"] },
	{ name: "quit restores", initial: { ac: 1, dc: 1 }, steps: ["hold", "releaseNow"] },
	{ name: "crash then recover", initial: { ac: 1, dc: 1 }, steps: ["hold", "recover", "recover"] },
	{ name: "recover after user change", initial: { ac: 3, dc: 1 }, steps: ["hold", "user:2", "recover"] },
	{ name: "unreadable marker", initial: { ac: 0, dc: 1 }, steps: ["marker:{not json", "recover"] },
	{ name: "marker of another shape", initial: { ac: 0, dc: 1 }, steps: [`marker:{"scheme":"x","ac":1}`, "recover"] },
	{
		name: "marker with a negative ac",
		initial: { ac: 0, dc: 1 },
		steps: [`marker:{"scheme":"${BALANCED}","ac":-1}`, "recover"],
	},
	{
		name: "marker without at",
		initial: { ac: 0, dc: 1 },
		steps: [`marker:{"scheme":"${BALANCED}","ac":2}`, "recover"],
	},
	{ name: "activation fails", initial: { ac: 1, dc: 1 }, steps: ["fail:/setactive#1", "hold", "release"] },
	{
		name: "activation and rollback fail",
		initial: { ac: 1, dc: 1 },
		steps: ["fail:/setactive#1", "fail:/query#2", "hold", "releaseNow"],
	},
	{
		name: "failed release then hold again",
		initial: { ac: 2, dc: 1 },
		steps: ["hold", "fail:/setacvalueindex#2", "release", "hold", "release"],
	},
	{ name: "query fails on hold", initial: { ac: 1, dc: 1 }, steps: ["fail:/query#1", "hold", "hold", "release"] },
	{ name: "release with nothing held", initial: { ac: 1, dc: 1 }, steps: ["release", "releaseNow"] },
	{ name: "hold twice", initial: { ac: 1, dc: 1 }, steps: ["hold", "hold", "release"] },
];

async function runWin(scenario: WinScenario) {
	const dir = mkdtempSync(join(tmpdir(), "capture-lid-"));
	const markerFile = join(dir, "lid-awake.json");
	const state = { ...scenario.initial, active: BALANCED };
	const commands: string[] = [];
	const fail = new Set<string>();
	const seen = new Map<string, number>();
	const answer = (args: readonly string[]): string => {
		commands.push(args.join(" "));
		const [verb = "", , , , value] = args;
		const nth = (seen.get(verb) ?? 0) + 1;
		seen.set(verb, nth);
		if (fail.delete(`${verb}#${nth}`)) throw new Error(`powercfg ${verb} failed`);
		if (verb === "/getactivescheme") return `Power Scheme GUID: ${state.active}  (Balanced)\r\n`;
		if (verb === "/query") return queryOutput(state.ac, state.dc);
		if (verb === "/setacvalueindex") {
			state.ac = Number(value);
			return "";
		}
		if (verb === "/setactive") return "";
		throw new Error(`unexpected powercfg ${args.join(" ")}`);
	};
	let now = 1000;
	const make = () =>
		new WindowsLidBackend({
			powercfg: { run: async args => answer(args), runSync: answer },
			hasBattery: async () => true,
			markerFile,
			now: () => now,
		});
	let backend = make();
	const steps = [];
	for (const step of scenario.steps) {
		let result: unknown = null;
		let error: string | null = null;
		try {
			if (step === "hold") result = await backend.hold();
			else if (step === "release") await backend.release();
			else if (step === "releaseNow") backend.releaseNow();
			else if (step === "recover") {
				now += 1000;
				backend = make();
				result = await backend.recover();
			} else if (step.startsWith("user:")) state.ac = Number(step.slice(5));
			else if (step.startsWith("fail:")) fail.add(step.slice(5));
			else if (step.startsWith("marker:")) writeFileSync(markerFile, step.slice(7));
		} catch (e) {
			error = errorText(e);
		}
		steps.push({
			step,
			result,
			error,
			commands: commands.splice(0),
			ac: state.ac,
			dc: state.dc,
			marker: existsSync(markerFile) ? readFileSync(markerFile, "utf8") : null,
		});
	}
	rmSync(dir, { recursive: true, force: true });
	return { ...scenario, steps };
}

const windowsLid = [];
for (const scenario of winScenarios) windowsLid.push(await runWin(scenario));

// --- media streams --------------------------------------------------------------------------------------------
const mediaDir = mkdtempSync(join(tmpdir(), "capture-media-"));
const clip = join(mediaDir, "clip.webm");
const empty = join(mediaDir, "empty.webm");
/** The file the Rust replay writes again: byte i is i % 251. */
const SIZE = 1000;
writeFileSync(
	clip,
	Uint8Array.from({ length: SIZE }, (_, i) => i % 251),
);
writeFileSync(empty, new Uint8Array());
const streams = new MediaStreams();
const urls = { clip: streams.open(clip, "video/webm", 1), empty: streams.open(empty, "audio/ogg", 1) };
const ranges = [
	null,
	"bytes=0-",
	"bytes=0-0",
	"bytes=10-19",
	"bytes=990-5000",
	"bytes=-10",
	"bytes=-5000",
	"bytes=999-",
	"bytes=1000-",
	"bytes=20-10",
	"bytes=-0",
	"bytes=-",
	"items=0-1",
	"bytes=0-1,5-6",
	" bytes=5-6 ",
	"bytes= 5-6",
];
const media = [];
for (const file of ["clip", "empty"] as const) {
	for (const method of ["GET", "HEAD", "POST"]) {
		for (const range of ranges) {
			const headers: Record<string, string> = range === null ? {} : { range };
			const response = await streams.handle(new Request(urls[file], { method, headers }));
			const body = response.body ? new Uint8Array(await response.arrayBuffer()) : null;
			media.push({
				file,
				method,
				range,
				status: response.status,
				headers: [...response.headers.entries()].sort(),
				bodyLength: body?.length ?? null,
				bodyFirst: body && body.length > 0 ? body[0] : null,
			});
		}
	}
}
for (const url of [`omp-media://stream/guess`, `${urls.clip}?t=1`, `${urls.clip}#x`]) {
	const response = await streams.handle(new Request(url));
	media.push({
		file: "url",
		method: "GET",
		range: url,
		status: response.status,
		headers: [],
		bodyLength: null,
		bodyFirst: null,
	});
}
rmSync(mediaDir, { recursive: true, force: true });

writeFileSync(
	OUT,
	`${JSON.stringify({ capturedFrom: commit, mediaSize: SIZE, fill, powercfg, lid, windowsLid, media }, null, "\t")}\n`,
);
console.log(
	`wrote ${OUT}: ${fill.length} fill, ${lid.length} lid, ${windowsLid.length} windows lid, ${media.length} media`,
);
