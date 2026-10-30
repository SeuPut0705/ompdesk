/**
 * Opt-in CPU audit of one busy tab's fan-out (`OMP_GUI_FANOUT_CPU=<dir>`): what main spends turning one tab's event
 * stream into what each receiver gets, with several desktop windows, two paired web pages and two paired computers on
 * the same tab. The stream is recorded once from the scripted omp (`test-traffic-omp.ts`) through a real
 * SidecarManager (`<dir>/stream.json`), then replayed on fake timers through the real SidecarPool (windows), WsRouter
 * (web pages) and LocalHostServices with real Links (computers). Each receiver's bytes are hashed, so a run before and a
 * run after a change can show the same output (`<dir>/<label>.json`, label `OMP_GUI_FANOUT_LABEL`). With
 * `OMP_GUI_FANOUT_PROFILE=1` a CPU profile of one replay is written beside it, and its self time grouped by function.
 */
import type * as NodeCrypto from "node:crypto";
import { createHash, type Hash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { Session as InspectorSession } from "node:inspector/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { serialize } from "node:v8";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent, SubagentFrame } from "../../shared/rpc-types";
import type { MachineServices } from "../machine-services";
import { SidecarManager } from "../sidecar";
import { SidecarPool } from "../sidecar-pool";
import type { SidecarLike } from "../sidecar-types";
import { RM_TEMP, writeFakeOmp } from "../test-fake-omp";
import type { ClientWindow } from "../web/client-window";
import type { WebDevice } from "../web/devices-store";
import { WebWindows } from "../web/web-client-window";
import { type RouterSocket, type Timers, WsRouter } from "../web/ws-router";
import type { HostConnection } from "./host-server";
import { LocalHostServices } from "./host-services";
import { LinkTraffic, type TrafficWindow } from "./link-traffic";
import type { PeerInfo } from "./peers-store";
import { slimOf } from "./protocol";
import { Link } from "./wire";

const OUT = process.env.OMP_GUI_FANOUT_CPU;
const LABEL = process.env.OMP_GUI_FANOUT_LABEL ?? "run";
const ROUNDS = Number(process.env.OMP_GUI_FANOUT_ROUNDS) || 7;
const DESKTOP_WINDOWS = Number(process.env.OMP_GUI_FANOUT_WINDOWS) || 3;
const WEB_PAGES = Number(process.env.OMP_GUI_FANOUT_PAGES ?? 2);
const COMPUTERS = Number(process.env.OMP_GUI_FANOUT_COMPUTERS ?? 2);
/** Where in the stream (a fraction) the last page and the last computer join; unset, everyone is there from the start. */
const JOIN = process.env.OMP_GUI_FANOUT_JOIN ? Number(process.env.OMP_GUI_FANOUT_JOIN) : undefined;

/** Ids the code under test makes (a connection's, an omp's, an encoder's epoch) count from zero each replay. */
const ids = vi.hoisted(() => ({ next: 0 }));
vi.mock("node:crypto", async importOriginal => {
	const crypto = await importOriginal<typeof NodeCrypto>();
	const randomUUID = () => `00000000-0000-4000-8000-${(ids.next++).toString(16).padStart(12, "0")}`;
	return { ...crypto, default: { ...crypto, randomUUID }, randomUUID };
});

/** One recorded item: when it came (ms from the start), and an `events` batch or a subagent frame. */
type Item = [at: number, kind: "e", batch: AgentSessionEvent[]] | [at: number, kind: "f", frame: SubagentFrame];

/** The busy tab: a long reply, four subagents with the work map open, then a tool streaming its output. */
const SCENARIOS = [
	{ kind: "stream", thinkingTokens: 300, textTokens: 900, tokenMs: 6 },
	{ kind: "subagents", count: 4, seconds: 12 },
	{ kind: "tool-wait", seconds: 2, outputLines: 300 },
];

async function record(file: string): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-fanout-"));
	try {
		const bin = await writeFakeOmp(
			dir,
			readFileSync(fileURLToPath(new URL("./test-traffic-omp.ts", import.meta.url)), "utf8"),
		);
		const workDir = path.join(dir, "work");
		await fs.mkdir(workDir);
		const sidecar = new SidecarManager({
			omp: async () => ({
				ok: true,
				runtime: { bin, version: "18.6.1", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
			}),
			cwd: workDir,
			kind: "agent",
			fresh: true,
		});
		const ready = Promise.withResolvers<void>();
		sidecar.on("status", ({ status }: { status: string }) => {
			if (status === "ready") ready.resolve();
		});
		sidecar.start();
		await ready.promise;
		await sidecar.rpcClient?.command({ type: "set_subagent_subscription", level: "events" });
		const items: Item[] = [];
		const startedAt = performance.now();
		sidecar.on("events", (batch: AgentSessionEvent[]) => items.push([performance.now() - startedAt, "e", batch]));
		sidecar.on("subagentFrame", (frame: SubagentFrame) => items.push([performance.now() - startedAt, "f", frame]));
		for (const scenario of SCENARIOS) {
			const settled = Promise.withResolvers<void>();
			const ended = Promise.withResolvers<void>();
			sidecar.once("sessionSettled", () => settled.resolve());
			const onEvents = (events: Array<{ type: string }>) => {
				if (!events.some(event => event.type === "agent_end")) return;
				sidecar.off("events", onEvents);
				ended.resolve();
			};
			sidecar.on("events", onEvents);
			await sidecar.rpcClient?.command({ type: "prompt", message: JSON.stringify(scenario) });
			await Promise.all([settled.promise, ended.promise]);
		}
		sidecar.dispose();
		writeFileSync(file, JSON.stringify(items));
	} finally {
		await fs.rm(dir, RM_TEMP);
	}
}

/** The tab's omp as the pool and the host see it; the replay emits the recorded stream on it. */
class ReplaySidecar extends EventEmitter {
	readonly kind = "agent" as const;
	status = "ready" as const;
	processAlive = true;
	readonly rpcClient = {
		command: async (command: { type: string }) => ({
			type: "response" as const,
			command: command.type,
			success: true,
			data: {},
		}),
	};
	constructor(readonly cwd: string) {
		super();
	}
	get statusPayload() {
		return { status: this.status, cwd: this.cwd };
	}
	start(): void {}
	restart(): void {}
	adoptCwd(): boolean {
		return false;
	}
	kill(): void {}
	dispose(): void {}
	sendSideChannel(): void {}
	whenExited(): Promise<void> {
		return new Promise(() => {});
	}
}

/** A receiver's output from the replayed stream on: bytes and, in the run that checks them, a hash over all of it in order. */
class Sink {
	bytes = 0;
	messages = 0;
	/** A computer's link counter. */
	traffic?: LinkTraffic;
	#hash: Hash | null = null;
	constructor(readonly hashing: boolean) {}
	add(data: string | Uint8Array): void {
		this.bytes += typeof data === "string" ? Buffer.byteLength(data) : data.length;
		this.messages++;
		this.#hash?.update(data);
	}
	/** Forget the setup's output (its batch window): the stream starts here. */
	reset(): void {
		this.bytes = 0;
		this.messages = 0;
		this.#hash = this.hashing ? createHash("sha256") : null;
		this.traffic?.take();
	}
	digest(): string {
		return this.#hash?.digest("hex").slice(0, 16) ?? "";
	}
}

/**
 * A desktop window: Electron structured-clones every push (V8's serializer), so the fake does too. The clone's size is
 * not a stable measure (a number goes as int32 or double as V8 holds it), so the window is counted by the push's JSON,
 * written only in the run that checks the bytes.
 */
function desktopWindow(id: number, sink: Sink): ClientWindow {
	const emitter = new EventEmitter();
	const contents = {
		id,
		send: (channel: string, data: unknown) => {
			serialize(data);
			sink.add(sink.hashing ? `${channel}\n${JSON.stringify(data)}` : "");
		},
	};
	return {
		webContents: contents,
		isDestroyed: () => false,
		once: (event: "closed", listener: () => void) => emitter.once(event, listener),
		removeListener: (event: "closed", listener: () => void) => emitter.removeListener(event, listener),
	} as unknown as ClientWindow;
}

class SinkSocket implements RouterSocket {
	bufferedAmount = 0;
	constructor(readonly sink: Sink) {}
	send(data: string): void {
		this.sink.add(data);
	}
	close(): void {}
	ping(): void {}
	terminate(): void {}
}

/** A computer's link: the host's real Link over a socket that keeps what was written. */
class SinkNetSocket extends EventEmitter {
	constructor(readonly sink: Sink) {
		super();
	}
	setNoDelay(): void {}
	write(frame: Buffer): boolean {
		this.sink.add(frame);
		return true;
	}
	end(): void {}
	destroy(): void {}
}

class Connection implements HostConnection {
	readonly slim = slimOf({
		t: "hello",
		protocol: 1,
		appVersion: "1.0.0",
		name: "device",
		slimEvents: true,
		slimProgress: true,
		slimAutopilot: true,
		slimEnds: true,
		slimReadGroups: true,
		slimToolResults: true,
		slimEndFields: true,
		slimAutopilotReads: true,
		slimListReads: true,
		slimShiftedReads: true,
		slimSettingsReads: true,
		slimRosterReads: true,
		slimJobsReads: true,
		slimToolOutputs: true,
		slimToolArgs: true,
		deflate: true,
		deflateContext: true,
	} as never);
	constructor(
		readonly link: Link,
		readonly peer: PeerInfo,
	) {
		link.deflateSent({ context: this.slim.deflateContext });
	}
	emit(event: string, data: unknown): void {
		this.link.send({ t: "evt", event, data });
	}
	close(): void {}
}

const realTimers: Timers = {
	after: (callback, ms) => {
		const timer = setTimeout(callback, ms);
		return () => clearTimeout(timer);
	},
	// No heartbeat: the replay's pages never answer one.
	every: () => () => {},
};

function webDevice(deviceId: string): WebDevice {
	return {
		deviceId,
		name: deviceId,
		userAgent: "UA",
		tailscaleLogin: null,
		secretSha256: "0".repeat(64),
		publicKeyJwk: null,
		grants: ["sessions", "agent", "files", "desktop-control", "device-self"],
		uiPrefs: {},
		createdAt: 0,
	} as unknown as WebDevice;
}

function hostServices(local: SidecarPool, workDir: string): LocalHostServices {
	// A variable, not a literal: a method the index type does not name (yet) is no error.
	const sessionIndex = {
		list: async () => [],
		relist: () => {},
		searchContent: async () => [],
		kindFor: async () => "agent" as const,
		recordedCwd: async () => null,
		deleteSession: async () => {},
		moveSession: async (file: string) => file,
		sessionsDir: path.join(workDir, "sessions"),
		readMessages: async () => [],
	};
	return new LocalHostServices({
		createSidecar: () => {
			throw new Error("the replay opens views only");
		},
		hostName: () => "Studio",
		sessionIndex,
		renameStoredSession: async () => {},
		defaultWorkspace: () => workDir,
		launchProfiles: { get: () => undefined, set: () => {} },
		machine: { abortBenchmark: async () => true, abortModelSetup: async () => true } as unknown as MachineServices,
		localTabs: {
			sessionOwner: () => null,
			windowSessionFiles: () => new Set<string>(),
			sessionOwnerIsLive: () => true,
			sessionRunning: () => false,
			commandForSession: async () => ({ type: "response", command: "get_state", success: true }),
			closeSessionTab: async () => false,
			allSidecars: () => [],
			viewForDevice: (sessionPath, origin, hostName) => local.viewForDevice(sessionPath, origin, hostName),
			stopSession: async () => {},
			noteTouched: () => {},
			notePrompted: () => {},
			beginMove: () => () => {},
		},
		trashItem: async () => {},
	});
}

interface Receivers {
	windows: Sink[];
	pages: Sink[];
	computers: Sink[];
}

/**
 * Everyone on one busy tab: the owner window and its viewers, the web pages, the computers viewing it. With
 * `OMP_GUI_FANOUT_JOIN` (a fraction of the stream) the last page and the last computer join there instead, as a
 * device that opens the tab mid-run: its encoders start with no baseline while the others' have theirs.
 */
async function rig(
	workDir: string,
	hashing: boolean,
): Promise<{ sidecar: ReplaySidecar; receivers: Receivers; late: Array<() => Promise<void>> }> {
	const sidecar = new ReplaySidecar(workDir);
	const pool = new SidecarPool(() => sidecar as unknown as SidecarLike);
	const sessionPath = path.join(workDir, "busy.jsonl");
	const receivers: Receivers = { windows: [], pages: [], computers: [] };
	for (let index = 0; index < DESKTOP_WINDOWS; index++) {
		const sink = new Sink(hashing);
		receivers.windows.push(sink);
		const win = desktopWindow(index + 1, sink);
		if (index === 0) pool.acquire(workDir, win, "busy", sessionPath);
		else pool.attachViewer(win, "busy");
	}
	const devices = new Map<string, WebDevice>();
	let router: WsRouter | null = null;
	const windows = new WebWindows((deviceId, channel, payload) => router?.deliver(deviceId, channel, payload));
	router = new WsRouter({
		registry: { invoke: async () => undefined, send: () => {} },
		devices: { get: (deviceId: string) => devices.get(deviceId) },
		windows,
		quota: { reserve: () => ({ ok: true as const, refund() {} }), record: () => {} },
		webChannels: {},
		features: () => ({ push: false, preview: false, upload: true, passkey: false }),
		blobs: { addBytes: () => "", addMedia: () => "", mediaUrl: () => "", release: () => {} } as never,
		uploads: { take: async () => Buffer.alloc(0) },
		toModelImage: async (image: unknown) => image,
		timers: realTimers,
	} as never);
	const late: Array<() => Promise<void>> = [];
	for (let index = 0; index < WEB_PAGES; index++) {
		const deviceId = `phone-${index}`;
		devices.set(deviceId, webDevice(deviceId));
		const sink = new Sink(hashing);
		receivers.pages.push(sink);
		const open = async () => {
			router?.attach(deviceId, new SinkSocket(sink));
			pool.attachViewer(windows.windowFor(deviceId), "busy");
		};
		if (JOIN !== undefined && index === WEB_PAGES - 1) late.push(open);
		else await open();
	}
	const services = hostServices(pool, workDir);
	// Fixed keys: a run before and a run after seal the same bytes.
	const key = (seed: number) => createHash("sha256").update(`key-${seed}`).digest();
	for (let index = 0; index < COMPUTERS; index++) {
		const sink = new Sink(hashing);
		receivers.computers.push(sink);
		const link = new Link(new SinkNetSocket(sink) as never);
		link.secure(key(index), key(index + 100));
		// What `logLinkTraffic` counts on every host link, kept here so the report can say what crossed.
		const traffic = new LinkTraffic();
		link.onTraffic((direction, message, bytes) => traffic.record(direction, message, bytes));
		sink.traffic = traffic;
		const peer: PeerInfo = {
			deviceId: `computer-${index}`,
			name: `Computer ${index}`,
			staticPub: "pub",
			nodeId: `n-${index}`,
			login: null,
			pairedAt: 0,
		};
		const conn = new Connection(link, peer);
		const open = async () => {
			await services.call(peer, "tab.open", { rtab: "r1", cwd: workDir, sessionPath }, conn);
		};
		if (JOIN !== undefined && index === COMPUTERS - 1) late.push(open);
		else await open();
	}
	// Let the views' first snapshot (a microtask) go out before the measured stream.
	await Promise.resolve();
	await Promise.resolve();
	return { sidecar, receivers, late };
}

interface Replay {
	cpuMs: number;
	wallMs: number;
	items: number;
	events: number;
	receivers: Record<keyof Receivers, Array<{ bytes: number; messages: number; hash: string }>>;
	/** What the first computer's link carried, by kind. */
	link?: TrafficWindow;
}

/** Replays the stream on fake timers, the recorded gaps included, and measures this thread's CPU over it. */
async function replay(items: Item[], options: { hashing: boolean; profile?: InspectorSession }): Promise<Replay> {
	const { profile } = options;
	// One folder and one clock for every run: the cwd and the times frames carry are the same before and after.
	const workDir = path.join(os.tmpdir(), "omp-gui-fanout-replay");
	mkdirSync(workDir, { recursive: true });
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
	vi.setSystemTime(1_760_000_000_000);
	ids.next = 0;
	try {
		const { sidecar, receivers, late } = await rig(workDir, options.hashing);
		// The setup's pushes leave in their own batch window, before the stream.
		vi.advanceTimersByTime(100);
		for (const sink of [...receivers.windows, ...receivers.pages, ...receivers.computers]) sink.reset();
		// Each run gets its own copy: nothing a run did to the objects reaches the next.
		const stream: Array<Item | undefined> = structuredClone(items);
		let events = 0;
		for (const [, kind, data] of items) events += kind === "e" ? data.length : 1;
		if (profile) await profile.post("Profiler.start");
		const cpu = process.threadCpuUsage();
		const wall = performance.now();
		let clock = 0;
		const joinAt = JOIN === undefined ? -1 : Math.floor(stream.length * JOIN);
		for (let index = 0; index < stream.length; index++) {
			const item = stream[index];
			if (!item) continue;
			// Nothing keeps an item once it was emitted, as nothing keeps a live omp's frame: what main holds on to
			// (and what collecting it costs) is what a live stream costs.
			stream[index] = undefined;
			const [at, kind, data] = item;
			if (at > clock) {
				vi.advanceTimersByTime(at - clock);
				clock = at;
			}
			if (index === joinAt) for (const open of late) await open();
			if (kind === "e") sidecar.emit("events", data);
			else sidecar.emit("subagentFrame", data);
		}
		vi.advanceTimersByTime(1_000);
		const used = process.threadCpuUsage(cpu);
		const wallMs = performance.now() - wall;
		const summary = (sinks: Sink[]) =>
			sinks.map(sink => ({ bytes: sink.bytes, messages: sink.messages, hash: sink.digest() }));
		return {
			cpuMs: (used.user + used.system) / 1000,
			wallMs,
			items: stream.length,
			events,
			receivers: {
				windows: summary(receivers.windows),
				pages: summary(receivers.pages),
				computers: summary(receivers.computers),
			},
			link: receivers.computers[0]?.traffic?.take(),
		};
	} finally {
		vi.useRealTimers();
	}
}

interface ProfileNode {
	id: number;
	callFrame: { functionName: string; url: string; lineNumber: number };
	hitCount?: number;
	children?: number[];
}

interface ProfileReading {
	totalMs: number;
	stages: Record<string, number>;
	top: Array<{ name: string; ms: number }>;
}

/** Self time by function, and the time under each stage's entry point. */
function readProfile(profile: { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] }): ProfileReading {
	const byId = new Map(profile.nodes.map(node => [node.id, node]));
	const selfUs = new Map<number, number>();
	for (const [index, id] of profile.samples.entries())
		selfUs.set(id, (selfUs.get(id) ?? 0) + (profile.timeDeltas[index] ?? 0));
	const label = (node: ProfileNode) =>
		`${node.callFrame.functionName || "(anonymous)"} ${path.basename(node.callFrame.url)}:${node.callFrame.lineNumber + 1}`;
	const self = new Map<string, number>();
	for (const [id, us] of selfUs) {
		const node = byId.get(id);
		if (node) self.set(label(node), (self.get(label(node)) ?? 0) + us);
	}
	const total = [...selfUs.values()].reduce((sum, us) => sum + us, 0);
	const parent = new Map<number, number>();
	for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
	/** Time under the first enclosing frame of each stage, so a stage nested in another counts once, in the inner one. */
	const fromFile = (node: ProfileNode, file: string) => node.callFrame.url.endsWith(file);
	const stages: Array<[name: string, test: (node: ProfileNode) => boolean]> = [
		["link deflate", node => /^deflated/.test(node.callFrame.functionName) && fromFile(node, "wire.ts")],
		["link seal", node => node.callFrame.functionName === "seal" && fromFile(node, "wire.ts")],
		["link send (JSON, frame)", node => node.callFrame.functionName === "send" && fromFile(node, "wire.ts")],
		["link traffic count", node => fromFile(node, "link-traffic.ts")],
		["link encode", node => fromFile(node, "link-events.ts")],
		["web frame (coalesce, JSON)", node => node.callFrame.functionName === "flush" && fromFile(node, "ws-router.ts")],
		["window clone (Electron stand-in)", node => node.callFrame.functionName === "serialize"],
		["message slim (windows, links)", node => fromFile(node, "message-update-slim.ts")],
		// What the harness does around a push (counting a sink, the profiler's own call); never above production code.
		[
			"harness (sinks, profiler)",
			node =>
				(fromFile(node, "fanout-cpu-report.test.ts") &&
					["add", "reset", "digest"].includes(node.callFrame.functionName)) ||
				node.callFrame.functionName === "post",
		],
	];
	const stageUs = new Map<string, number>();
	for (const [id, us] of selfUs) {
		const leaf = byId.get(id);
		// Fake timers' bookkeeping sits above every timer callback, so it counts only as the leaf.
		let stage = leaf && /vitest|vi\.[\w-]+\.js/.test(leaf.callFrame.url) ? "harness (fake timers)" : undefined;
		let at: number | undefined = id;
		while (at !== undefined && !stage) {
			const node = byId.get(at);
			if (!node) break;
			stage = stages.find(([, test]) => test(node))?.[0];
			at = parent.get(at);
		}
		const key = stage ?? "other (pool, host services, router dispatch, GC)";
		stageUs.set(key, (stageUs.get(key) ?? 0) + us);
	}
	const ms = (us: number) => Math.round(us / 100) / 10;
	return {
		totalMs: ms(total),
		stages: Object.fromEntries([...stageUs].sort((a, b) => b[1] - a[1]).map(([name, us]) => [name, ms(us)])),
		top: [...self]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 40)
			.map(([name, us]) => ({ name, ms: ms(us) })),
	};
}

const median = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

describe.skipIf(!OUT)("one busy tab's fan-out", () => {
	it("measures main's CPU per 1,000 events and each receiver's bytes", { timeout: 600_000 }, async () => {
		if (!OUT) return;
		mkdirSync(OUT, { recursive: true });
		const streamFile = path.join(OUT, "stream.json");
		if (!existsSync(streamFile)) await record(streamFile);
		const items = JSON.parse(readFileSync(streamFile, "utf8")) as Item[];
		// The checked run hashes what each receiver got (and warms the JIT on the same work); timed runs only count it.
		const checked = await replay(items, { hashing: true });
		const runs: Replay[] = [];
		for (let round = 0; round < ROUNDS; round++) runs.push(await replay(items, { hashing: false }));
		const first = runs[0];
		if (!first) throw new Error("no run");
		const counted = ({ windows, pages, computers }: Replay["receivers"]) => ({
			windows: windows.map(sink => sink.messages),
			pages: pages.map(({ bytes, messages }) => ({ bytes, messages })),
			computers: computers.map(({ bytes, messages }) => ({ bytes, messages })),
		});
		// Every run of the same stream gives every receiver the same output.
		for (const run of runs) expect(counted(run.receivers)).toEqual(counted(checked.receivers));
		let profile: ProfileReading | undefined;
		if (process.env.OMP_GUI_FANOUT_PROFILE === "1") {
			const session = new InspectorSession();
			session.connect();
			await session.post("Profiler.enable");
			await session.post("Profiler.setSamplingInterval", { interval: 100 });
			await replay(items, { hashing: false, profile: session });
			const { profile: taken } = await session.post("Profiler.stop");
			writeFileSync(path.join(OUT, `${LABEL}.cpuprofile`), JSON.stringify(taken));
			profile = readProfile(taken as never);
			session.disconnect();
		}
		const cpu = runs.map(run => run.cpuMs);
		const report = {
			label: LABEL,
			receivers: { windows: DESKTOP_WINDOWS, pages: WEB_PAGES, computers: COMPUTERS },
			items: first.items,
			events: first.events,
			cpuMs: { median: median(cpu), min: Math.min(...cpu), max: Math.max(...cpu), runs: cpu },
			cpuMsPer1000Events: Math.round((median(cpu) / first.events) * 1000 * 100) / 100,
			wallMsMedian: median(runs.map(run => run.wallMs)),
			bytes: checked.receivers,
			link: checked.link,
			profile,
		};
		writeFileSync(path.join(OUT, `${LABEL}.json`), `${JSON.stringify(report, null, "\t")}\n`);
		console.log(
			JSON.stringify(
				{ ...report, profile: profile && { totalMs: profile.totalMs, stages: profile.stages } },
				null,
				1,
			),
		);
	});
});
