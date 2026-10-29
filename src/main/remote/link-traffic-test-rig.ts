/**
 * The rig the link traffic tests share: two RemoteDevices over real loopback sockets, the host running a real
 * LocalHostServices and a real SidecarManager over the scripted fake omp (`test-traffic-omp.ts`), the device a
 * RemoteSidecar. Every `Link.send` is counted at the moment it is serialized (wire bytes = JSON + 4-byte header +
 * 12-byte nonce + 16-byte tag). The spy is on `Link.prototype`, so one test file runs one session at a time; the tests
 * are split over files (`link-traffic-*.test.ts`) so their sessions run side by side.
 */
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { type MockInstance, vi } from "vitest";
import type { AgentSessionEvent, SubagentFrame } from "../../shared/rpc-types";
import type { MachineServices } from "../machine-services";
import type { OmpResolution } from "../omp-runtime";
import { SidecarManager } from "../sidecar";
import type { SidecarLike } from "../sidecar-types";
import { RM_TEMP, writeFakeOmp } from "../test-fake-omp";
import { LocalHostServices } from "./host-services";
import type { RemoteSidecar } from "./remote-sidecar";
import { DevicesRig } from "./test-devices";
import { Link } from "./wire";

const FRAME_OVERHEAD = 32;

/** The scripted omp's task update `partialResult`. */
export interface TaskPartial {
	details?: { progress?: Array<{ assignment?: unknown }> };
}

interface Row {
	frames: number;
	bytes: number;
}

/**
 * What the device's hello says: `noDeflateContext` was built before frames deflated against the link's context
 * (v0.79.0), `noDeflate` before deflated frames (v0.61.9), `noListReads` before slim list reads (v0.59.1),
 * `slimEventsOnly` before slim progress, `older` before slim events.
 */
export type DeviceKind = "current" | "noDeflateContext" | "noDeflate" | "noListReads" | "slimEventsOnly" | "older";

/** Counts every message a Link sends, split the way the report reads it. */
export class LinkRecorder {
	readonly links = new Map<string, Row>();
	readonly inner = new Map<string, Row>();
	readonly #methods = new Map<number, string>();
	#spy: MockInstance | null = null;

	/** The hello goes out as the build `device` sent it; the host answers with the frames that build can read. */
	start(device: DeviceKind = "current"): void {
		const original = Link.prototype.send;
		const record = (message: object): void => this.#record(message as { t: string } & Record<string, unknown>);
		this.#spy = vi.spyOn(Link.prototype, "send").mockImplementation(function (this: Link, sent: object) {
			record(sent);
			// Every build before the current one predates frames deflated against the context, most also deflated ones.
			let message = sent;
			if (device !== "current" && "deflateContext" in message) {
				const { deflateContext: _context, ...earlier } = message as { deflateContext?: unknown };
				if (device === "noDeflateContext") return original.call(this, earlier);
				message = earlier;
			}
			if (device !== "current" && "deflate" in message) {
				const { deflate: _deflate, ...earlier } = message as { deflate?: unknown };
				if (device === "noDeflate") return original.call(this, earlier);
				message = earlier;
			}
			if (device === "noListReads" && "slimEvents" in message) {
				const {
					slimListReads: _lists,
					slimShiftedReads: _shifts,
					...earlier
				} = message as {
					slimListReads?: unknown;
					slimShiftedReads?: unknown;
				};
				return original.call(this, earlier);
			}
			if (device !== "current" && "slimEvents" in message) {
				const {
					slimEvents,
					slimProgress: _progress,
					slimAutopilot: _autopilot,
					slimEnds: _ends,
					slimReadGroups: _reads,
					slimToolResults: _tools,
					...older
				} = message as {
					slimEvents: unknown;
					slimProgress?: unknown;
					slimAutopilot?: unknown;
					slimEnds?: unknown;
					slimReadGroups?: unknown;
					slimToolResults?: unknown;
				};
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
export interface RawTap {
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
			windowSessionFiles: () => new Set<string>(),
			sessionOwnerIsLive: () => false,
			sessionRunning: () => false,
			commandForSession: async () => ({ type: "response", command: "get_state", success: true }),
			closeSessionTab: async () => false,
			allSidecars: () => [],
			viewForDevice: () => null,
			stopSession: async () => {},
			noteTouched: () => {},
			notePrompted: () => {},
			beginMove: () => () => {},
		},
		trashItem: async () => {},
	});
}

export interface Session {
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
	/** The host omp's working folder (the scripted omp reads subagent journals from its `subagents/`). */
	workDir: string;
	/** Runs one scripted turn and resolves when the host's omp settled it. */
	turn(scenario: object): Promise<void>;
	setLevel(level: "off" | "progress" | "events"): Promise<void>;
}

const rigs: DevicesRig[] = [];
const recorders: LinkRecorder[] = [];

export async function openSession(options: { device?: DeviceKind } = {}): Promise<Session> {
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
		workDir,
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

/** Each test file's `afterEach`: stops the spies, closes the rigs and removes the work folders. */
export async function closeSessions(): Promise<void> {
	for (const recorder of recorders.splice(0)) recorder.stop();
	for (const rig of rigs.splice(0)) await rig.dispose();
	for (const dir of WORK_DIRS.splice(0)) await fs.rm(dir, RM_TEMP);
}

/** A scripted turn as the device's sidecar delivers it to its pool (what `use-rpc-events` is fed), and what it cost. */
export interface Delivered {
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
export async function delivered(
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
