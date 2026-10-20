/**
 * What crosses the remote link, by frame kind, RPC method, tab event name and omp event type, measured on two
 * RemoteDevices over real loopback sockets: the host runs a real LocalHostServices and a real SidecarManager over
 * the scripted fake omp (`test-traffic-omp.ts`), the device a RemoteSidecar. Every `Link.send` is counted at the
 * moment it is serialized (wire bytes = JSON + 4-byte header + 12-byte nonce + 16-byte tag).
 *
 * `OMP_GUI_LINK_TRAFFIC=1 bunx vitest run src/main/remote/link-traffic-report.test.ts` prints the tables (idle seconds from
 * `OMP_GUI_LINK_TRAFFIC_IDLE_S`, default 120); without it the file only pins the regressions below.
 */
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, type MockInstance, vi } from "vitest";
import type { AgentSessionEvent, SubagentFrame } from "../../shared/rpc-types";
import type { MachineServices } from "../machine-services";
import { createMessageUpdateSlimmer } from "../message-update-slim";
import type { OmpResolution } from "../omp-runtime";
import { SidecarManager } from "../sidecar";
import type { SidecarLike } from "../sidecar-types";
import { RM_TEMP, writeFakeOmp } from "../test-fake-omp";
import { LocalHostServices } from "./host-services";
import type { RemoteSidecar } from "./remote-sidecar";
import { DevicesRig } from "./test-devices";
import { Link } from "./wire";

const FRAME_OVERHEAD = 32;
const MEASURE = process.env.OMP_GUI_LINK_TRAFFIC === "1";

/** The scripted omp's task update `partialResult`. */
interface TaskPartial {
	details?: { progress?: Array<{ assignment?: unknown }> };
}

interface Row {
	frames: number;
	bytes: number;
}

/** What the device's hello says: `slimEventsOnly` was built before slim progress, `older` before slim events. */
type DeviceKind = "current" | "slimEventsOnly" | "older";

/** Counts every message a Link sends, split the way the report reads it. */
class LinkRecorder {
	readonly links = new Map<string, Row>();
	readonly inner = new Map<string, Row>();
	readonly #methods = new Map<number, string>();
	#spy: MockInstance | null = null;

	/** The hello goes out as the build `device` sent it; the host answers with the frames that build can read. */
	start(device: DeviceKind = "current"): void {
		const original = Link.prototype.send;
		const record = (message: object): void => this.#record(message as { t: string } & Record<string, unknown>);
		this.#spy = vi.spyOn(Link.prototype, "send").mockImplementation(function (this: Link, message: object) {
			record(message);
			if (device !== "current" && "slimEvents" in message) {
				const {
					slimEvents,
					slimProgress: _progress,
					...older
				} = message as { slimEvents: unknown; slimProgress?: unknown };
				return original.call(this, device === "older" ? older : { ...older, slimEvents });
			}
			return original.call(this, message);
		});
	}

	stop(): void {
		this.#spy?.mockRestore();
		this.#spy = null;
	}

	reset(): void {
		this.links.clear();
		this.inner.clear();
	}

	get totalBytes(): number {
		let total = 0;
		for (const row of this.links.values()) total += row.bytes;
		return total;
	}

	#add(table: Map<string, Row>, key: string, bytes: number): void {
		const row = table.get(key) ?? { frames: 0, bytes: 0 };
		row.frames++;
		row.bytes += bytes;
		table.set(key, row);
	}

	#record(message: { t: string } & Record<string, unknown>): void {
		const json = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
		const bytes = json(message) + FRAME_OVERHEAD;
		let key: string;
		if (message.t === "req") {
			const { id, method } = message as unknown as { id: number; method: string };
			this.#methods.set(id, method);
			key = `A>B req ${method}`;
		} else if (message.t === "res") {
			const { id } = message as unknown as { id: number };
			key = `B>A res ${this.#methods.get(id) ?? "?"}`;
			this.#methods.delete(id);
		} else if (message.t === "evt") {
			const { event, data } = message as unknown as { event: string; data: { name?: string; arg?: unknown } };
			key = `B>A evt ${event}${event === "tab.event" ? ` ${data.name}` : ""}`;
			if (event === "tab.event") this.#splitTabEvent(data.name ?? "?", data.arg, bytes);
		} else {
			key = `both ${message.t}`;
		}
		this.#add(this.links, key, bytes);
	}

	/** The omp event types inside a tab event, sized one by one; the rest is the envelope. */
	#splitTabEvent(name: string, arg: unknown, frameBytes: number): void {
		const sized: Array<[string, number]> = [];
		if (name === "events" && Array.isArray(arg)) {
			for (const event of arg as Array<{ type?: string }>)
				sized.push([`events/${event.type}`, Buffer.byteLength(JSON.stringify(event))]);
		} else if (name === "subagentFrame" || name === "liveFrame" || name === "btwFrame") {
			// A host that batches sends an array of frames in one tab event.
			const frames = (Array.isArray(arg) ? arg : [arg]) as Array<{
				type?: string;
				payload?: { event?: { type?: string } };
			}>;
			for (const frame of frames) {
				const nested = frame.payload?.event?.type;
				sized.push([
					`${name}/${frame.type}${nested ? `/${nested}` : ""}`,
					Buffer.byteLength(JSON.stringify(frame)),
				]);
			}
		} else {
			sized.push([name, Buffer.byteLength(JSON.stringify(arg ?? null))]);
		}
		let inside = 0;
		for (const [key, bytes] of sized) {
			inside += bytes;
			this.#add(this.inner, key, bytes);
		}
		this.#add(this.inner, `(envelope of ${name})`, Math.max(0, frameBytes - inside));
	}

	table(title: string, seconds: number): string {
		const render = (table: Map<string, Row>, heading: string): string[] => {
			const rows = [...table.entries()].sort((x, y) => y[1].bytes - x[1].bytes);
			const total = rows.reduce((sum, [, row]) => sum + row.bytes, 0);
			return [
				`  ${heading}`,
				...rows.map(
					([key, row]) =>
						`    ${key.padEnd(52)} ${String(row.frames).padStart(7)} frames ${String(row.bytes).padStart(10)} B ${(row.bytes / seconds).toFixed(1).padStart(10)} B/s`,
				),
				`    ${"TOTAL".padEnd(52)} ${"".padStart(7)}        ${String(total).padStart(10)} B ${(total / seconds).toFixed(1).padStart(10)} B/s`,
			];
		};
		return [
			`== ${title} (${seconds.toFixed(1)} s)`,
			...render(this.links, "link frames"),
			...render(this.inner, "inside tab.event"),
		].join("\n");
	}
}

const WORK_DIRS: string[] = [];

function ompAt(bin: string): () => Promise<OmpResolution> {
	return async () => ({
		ok: true,
		runtime: { bin, version: "18.6.1", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
	});
}

/** What the host's omp emitted before the host's encoder saw it. */
interface RawTap {
	events: AgentSessionEvent[];
	frames: SubagentFrame[];
}

function hostServices(bin: string, workDir: string, raw: RawTap): LocalHostServices {
	return new LocalHostServices({
		createSidecar: (cwd, kind, fresh) => {
			const sidecar = new SidecarManager({ omp: ompAt(bin), cwd, kind, fresh });
			sidecar.on("events", (batch: AgentSessionEvent[]) => raw.events.push(...batch));
			sidecar.on("subagentFrame", (frame: SubagentFrame) => raw.frames.push(frame));
			return sidecar as unknown as SidecarLike;
		},
		hostName: () => "Studio",
		sessionIndex: {
			list: async () => [],
			searchContent: async () => [],
			kindFor: async () => "chat",
			recordedCwd: async () => null,
			deleteSession: async () => {},
			moveSession: async (file: string) => file,
			sessionsDir: path.join(workDir, "sessions"),
			readMessages: async () => [],
		},
		renameStoredSession: async () => {},
		defaultWorkspace: () => workDir,
		launchProfiles: { get: () => undefined, set: () => {} },
		machine: { abortBenchmark: async () => true, abortModelSetup: async () => true } as unknown as MachineServices,
		localTabs: {
			sessionOwner: () => null,
			sessionOwnerIsLive: () => false,
			sessionRunning: () => false,
			commandForSession: async () => ({ type: "response", command: "get_state", success: true }),
			closeSessionTab: async () => false,
			allSidecars: () => [],
			viewForDevice: () => null,
		},
		trashItem: async () => {},
	});
}

interface Session {
	sidecar: RemoteSidecar;
	recorder: LinkRecorder;
	rig: DevicesRig;
	/** Every omp event and subagent frame the device's sidecar delivered to its pool, in order. */
	events: Array<{ type: string; message?: { content?: unknown }; assistantMessageEvent?: { type: string } }>;
	frames: SubagentFrame[];
	/** What the host's omp emitted, as the host's encoder received it. */
	raw: RawTap;
	/** What the host wrote to its `remote-link` runtime log. */
	hostLog: Array<{ message: string; details: Record<string, unknown> }>;
	/** Runs one scripted turn and resolves when the host's omp settled it. */
	turn(scenario: object): Promise<void>;
	setLevel(level: "off" | "progress" | "events"): Promise<void>;
}

const rigs: DevicesRig[] = [];
const recorders: LinkRecorder[] = [];

async function openSession(options: { device?: DeviceKind } = {}): Promise<Session> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-link-traffic-"));
	WORK_DIRS.push(dir);
	const bin = await writeFakeOmp(
		dir,
		readFileSync(fileURLToPath(new URL("./test-traffic-omp.ts", import.meta.url)), "utf8"),
	);
	const workDir = path.join(dir, "work");
	await fs.mkdir(workDir);
	const rig = new DevicesRig();
	rigs.push(rig);
	const recorder = new LinkRecorder();
	recorders.push(recorder);
	recorder.start(options.device);
	const hostLog: Session["hostLog"] = [];
	const raw: RawTap = { events: [], frames: [] };
	const { a, hostId } = await rig.connected({
		services: hostServices(bin, workDir, raw),
		logLink: (message, details) => hostLog.push({ message, details }),
	});
	const sidecar = a.devices.createSidecar(hostId, "t1", workDir, "agent", true);
	const ready = Promise.withResolvers<void>();
	sidecar.on("status", ({ status }: { status: string }) => {
		if (status === "ready") ready.resolve();
	});
	const events: Session["events"] = [];
	const frames: SubagentFrame[] = [];
	sidecar.on("events", (batch: Session["events"]) => events.push(...batch));
	sidecar.on("subagentFrame", (frame: SubagentFrame) => frames.push(frame));
	sidecar.start();
	await ready.promise;
	recorder.reset();
	return {
		sidecar,
		events,
		frames,
		raw,
		recorder,
		rig,
		hostLog,
		async turn(scenario) {
			const settled = Promise.withResolvers<void>();
			const ended = Promise.withResolvers<void>();
			sidecar.once("sessionSettled", () => settled.resolve());
			// `sessionSettled` is not batched, so it can overtake the last events of the turn (the 32 ms batch).
			const onEvents = (events: Array<{ type: string }>) => {
				if (!events.some(event => event.type === "agent_end")) return;
				sidecar.off("events", onEvents);
				ended.resolve();
			};
			sidecar.on("events", onEvents);
			await sidecar.rpcClient?.command({ type: "prompt", message: JSON.stringify(scenario) });
			await Promise.all([settled.promise, ended.promise]);
		},
		async setLevel(level) {
			await sidecar.rpcClient?.command({ type: "set_subagent_subscription", level });
		},
	};
}

afterEach(async () => {
	for (const recorder of recorders.splice(0)) recorder.stop();
	for (const rig of rigs.splice(0)) await rig.dispose();
	for (const dir of WORK_DIRS.splice(0)) await fs.rm(dir, RM_TEMP);
});

describe.skipIf(!MEASURE)("link traffic report", () => {
	const idleSeconds = Number(process.env.OMP_GUI_LINK_TRAFFIC_IDLE_S) || 120;
	const report = (title: string, recorder: LinkRecorder, ms: number): void => {
		console.log(`\n${recorder.table(title, ms / 1000)}\n`);
	};

	it("idle: an open tab, no turn, no subagent", async () => {
		const { recorder } = await openSession();
		await delay(1_000);
		recorder.reset();
		await delay(idleSeconds * 1000);
		report(`idle tab`, recorder, idleSeconds * 1000);
	}, 400_000);

	it("a turn waiting on a long tool call", async () => {
		const { recorder, turn } = await openSession();
		await delay(500);
		recorder.reset();
		const started = Date.now();
		await turn({ kind: "tool-wait", seconds: 30 });
		report("turn waiting 30 s on a silent bash tool (level off)", recorder, Date.now() - started);
	}, 120_000);

	it("assistant streaming a long message with thinking", async () => {
		const { recorder, turn } = await openSession();
		for (const [thinking, text] of [
			[150, 300],
			[300, 600],
			[600, 1200],
		] as const) {
			await delay(500);
			recorder.reset();
			const started = Date.now();
			await turn({ kind: "stream", thinkingTokens: thinking, textTokens: text, tokenMs: 12 });
			report(
				`stream ${thinking} thinking + ${text} text tokens, one token per 12 ms`,
				recorder,
				Date.now() - started,
			);
		}
	}, 200_000);

	for (const level of ["off", "progress", "events"] as const) {
		it(`a task tool whose subagent works for 20 s (subscription ${level})`, async () => {
			const { recorder, turn, setLevel } = await openSession();
			await setLevel(level);
			await delay(500);
			recorder.reset();
			const started = Date.now();
			await turn({ kind: "subagent", seconds: 20, textTokens: 300, tokenMs: 12 });
			report(`task subagent, subscription ${level}`, recorder, Date.now() - started);
		}, 120_000);
	}
});

describe("link traffic harness", () => {
	it("counts a request, its answer and a tab event by kind", async () => {
		const { sidecar, recorder } = await openSession();
		recorder.reset();
		await sidecar.rpcClient?.command({ type: "get_state" });
		expect([...recorder.links.keys()]).toEqual(["A>B req tab.command", "B>A res tab.command"]);
		expect(recorder.totalBytes).toBeGreaterThan(0);
	}, 30_000);
});

describe("the host's traffic line over the real pipeline", () => {
	it("names the omp event type a streamed reply is made of, and holds none of its text", async () => {
		const { rig, turn, hostLog } = await openSession();
		await turn({ kind: "stream", thinkingTokens: 400, textTokens: 1200, tokenMs: 0 });
		await rig.dispose();

		const traffic = hostLog.filter(line => line.message === "traffic");
		expect(traffic).toHaveLength(1);
		const details = traffic[0]?.details as {
			top: Array<{ kind: string }>;
			events: Record<string, number>;
		};
		expect(details.top[0]?.kind).toBe("tx evt tab.event events");
		expect(details.events.message_update).toBeGreaterThan(1500);
		expect(JSON.stringify(details)).not.toContain("session transcript");
	}, 30_000);
});

/** A scripted turn as the device's sidecar delivers it to its pool (what `use-rpc-events` is fed), and what it cost. */
interface Delivered {
	/** `events` batches' contents, in order. */
	events: Array<{ type: string; message?: { content?: unknown }; assistantMessageEvent?: { type: string } }>;
	frames: SubagentFrame[];
	raw: RawTap;
	/** Wire bytes of the host's `events` frames and of its subagent `message_update` frames. */
	eventBytes: number;
	subagentUpdateBytes: number;
	subagentUpdateFrames: number;
	/** Wire bytes of every `tab.event` the host sent, and how many of them carried subagent frames. */
	tabEventBytes: number;
	subagentEnvelopes: number;
}

/** Runs one scripted turn on a fresh host and device (the device as `device` says, current by default) and tears both down. */
async function delivered(
	scenario: object,
	options: { device?: DeviceKind; level?: "off" | "progress" | "events" } = {},
): Promise<Delivered> {
	const session = await openSession(options);
	if (options.level) await session.setLevel(options.level);
	session.recorder.reset();
	await session.turn(scenario);
	const subagent = session.recorder.inner.get("subagentFrame/subagent_event/message_update");
	const { links } = session.recorder;
	let tabEventBytes = 0;
	for (const [kind, row] of links) if (kind.startsWith("B>A evt tab.event")) tabEventBytes += row.bytes;
	const result: Delivered = {
		events: session.events,
		frames: session.frames,
		raw: session.raw,
		eventBytes: links.get("B>A evt tab.event events")?.bytes ?? 0,
		subagentUpdateBytes: subagent?.bytes ?? 0,
		subagentUpdateFrames: subagent?.frames ?? 0,
		tabEventBytes,
		subagentEnvelopes: links.get("B>A evt tab.event subagentFrame")?.frames ?? 0,
	};
	session.recorder.stop();
	await session.rig.dispose();
	return result;
}

describe("a device that asks for slim events", () => {
	it.each([
		[150, 300],
		[300, 600],
		[600, 1200],
	] as const)(
		"streams a reply of %i thinking + %i text tokens in at most a tenth of the bytes an older device gets",
		async (thinkingTokens, textTokens) => {
			// Unpaced: a byte count needs no wall clock (2 ms a token was 7 of the 1800-token case's 9.5 s), and a burst
			// is what packs an older device's whole updates into frames past the link's cap.
			const scenario = { kind: "stream", thinkingTokens, textTokens, tokenMs: 0 };
			const older = await delivered(scenario, { device: "older" });
			const current = await delivered(scenario);
			const updates = (run: Delivered) => run.events.filter(event => event.type === "message_update").length;
			// Nothing dropped on the way: an older device's batch past the frame cap once lost the turn, end included.
			expect(updates(older)).toBeGreaterThanOrEqual(thinkingTokens + textTokens);
			expect(updates(older)).toBe(updates(current));
			expect(current.eventBytes * 10, `${current.eventBytes} B against ${older.eventBytes} B`).toBeLessThanOrEqual(
				older.eventBytes,
			);
		},
		30_000,
	);

	it("receives a subagent's streamed messages in at most a tenth of the bytes an older device gets", async () => {
		const scenario = { kind: "subagent", messages: 1, textTokens: 300, tokenMs: 0 };
		const older = await delivered(scenario, { device: "older", level: "events" });
		const current = await delivered(scenario, { level: "events" });
		const perFrame = (bytes: number, frames: number): number => bytes / Math.max(1, frames);
		expect(older.subagentUpdateFrames).toBeGreaterThan(100);
		expect(
			perFrame(current.subagentUpdateBytes, current.subagentUpdateFrames) * 10,
			`${current.subagentUpdateBytes} B in ${current.subagentUpdateFrames} frames against ${older.subagentUpdateBytes} B in ${older.subagentUpdateFrames}`,
		).toBeLessThanOrEqual(perFrame(older.subagentUpdateBytes, older.subagentUpdateFrames));
	}, 120_000);

	it("still gets every message_update whole from a host that cannot tell the device is older", async () => {
		const older = await delivered(
			{ kind: "stream", thinkingTokens: 20, textTokens: 40, tokenMs: 0 },
			{ device: "older" },
		);
		const updates = older.events.filter(event => event.type === "message_update");
		expect(updates.length).toBeGreaterThan(60);
		for (const update of updates) expect(Array.isArray(update.message?.content)).toBe(true);
	}, 30_000);

	it("delivers the same stream to the renderer as an older device does", async () => {
		const scenario = { kind: "tool-wait", seconds: 0 };
		const rendered = async (options: { device?: DeviceKind }) => {
			// The pool's per-window slimmer turns what a sidecar delivers into what a window receives.
			const slim = createMessageUpdateSlimmer();
			return slim((await delivered(scenario, options)).events as AgentSessionEvent[]);
		};
		const older = await rendered({ device: "older" });
		const current = await rendered({});
		expect(current).toEqual(older);
	}, 60_000);
});

describe("a device that asks for slim progress", () => {
	const scenario = { kind: "subagent", seconds: 3, textTokens: 300, tokenMs: 2 };
	const results = new Map<string, Delivered>();
	const key = (device: DeviceKind, level: string): string => `${device} ${level}`;
	const run = (device: DeviceKind, level: string): Delivered => results.get(key(device, level)) as Delivered;
	/** The parent's `tool_execution_update`s the omp made: one progress snapshot each. */
	const snapshots = (d: Delivered): number =>
		Math.max(1, d.raw.events.filter(event => event.type === "tool_execution_update").length);
	const perSnapshot = (bytes: number, d: Delivered): number => bytes / snapshots(d);
	const ofKinds = <T extends { type: string }>(items: T[], types: string[]): T[] =>
		items.filter(item => types.includes(item.type));

	beforeAll(async () => {
		for (const level of ["off", "progress", "events"] as const)
			for (const device of ["current", "slimEventsOnly"] as const)
				results.set(key(device, level), await delivered(scenario, { device, level }));
		results.set(key("older", "events"), await delivered(scenario, { device: "older", level: "events" }));
	}, 180_000);

	it("sends the progress it reports, with the subscription off, in at most half the bytes", () => {
		const current = perSnapshot(run("current", "off").tabEventBytes, run("current", "off"));
		const before = perSnapshot(run("slimEventsOnly", "off").tabEventBytes, run("slimEventsOnly", "off"));
		expect(current * 2, `${current.toFixed(0)} B a snapshot against ${before.toFixed(0)} B`).toBeLessThanOrEqual(
			before,
		);
	});

	it("sends the progress it reports, with the progress subscription, in at most a third of the bytes", () => {
		const current = perSnapshot(run("current", "progress").tabEventBytes, run("current", "progress"));
		const before = perSnapshot(run("slimEventsOnly", "progress").tabEventBytes, run("slimEventsOnly", "progress"));
		expect(current * 3, `${current.toFixed(0)} B a snapshot against ${before.toFixed(0)} B`).toBeLessThanOrEqual(
			before,
		);
	});

	it("sends all of a subagent's events but its own messages in at most a third of the bytes", () => {
		const rest = (d: Delivered): number => perSnapshot(d.tabEventBytes - d.subagentUpdateBytes, d);
		const current = rest(run("current", "events"));
		const before = rest(run("slimEventsOnly", "events"));
		expect(current * 3, `${current.toFixed(0)} B a snapshot against ${before.toFixed(0)} B`).toBeLessThanOrEqual(
			before,
		);
	});

	it("sends the frames of one flush in one tab event", () => {
		const current = run("current", "events");
		expect(current.raw.frames.length).toBeGreaterThan(100);
		expect(
			current.subagentEnvelopes * 2,
			`${current.subagentEnvelopes} tab events for ${current.raw.frames.length} frames`,
		).toBeLessThanOrEqual(current.raw.frames.length);
	});

	it("delivers the progress snapshots, lifecycle frames and task updates the host's omp emitted, unchanged", () => {
		for (const level of ["off", "progress", "events"] as const) {
			const current = run("current", level);
			const updates = ofKinds(current.raw.events, ["tool_execution_update"]);
			expect(updates.length).toBeGreaterThan(10);
			expect(ofKinds(current.events as AgentSessionEvent[], ["tool_execution_update"])).toEqual(updates);
			const frames = ofKinds(current.raw.frames, ["subagent_progress", "subagent_lifecycle"]);
			expect(ofKinds(current.frames, ["subagent_progress", "subagent_lifecycle"])).toEqual(frames);
			if (level !== "off") expect(frames.length).toBeGreaterThan(10);
		}
	});

	it("still gets every frame and every snapshot whole, one tab event a frame, when it asked for neither", () => {
		const older = run("older", "events");
		expect(older.subagentEnvelopes).toBe(older.raw.frames.length);
		const updates = ofKinds(older.events as AgentSessionEvent[], ["tool_execution_update"]);
		expect(updates).toEqual(ofKinds(older.raw.events, ["tool_execution_update"]));
		for (const update of updates) {
			expect(update.type).toBe("tool_execution_update");
			// The scripted omp's task update: its `partialResult` is `{ details: { progress: AgentProgress[] } }`.
			const partial: TaskPartial = (update as Extract<AgentSessionEvent, { type: "tool_execution_update" }>)
				.partialResult as TaskPartial;
			expect(typeof partial.details?.progress?.[0]?.assignment).toBe("string");
		}
	});
});
