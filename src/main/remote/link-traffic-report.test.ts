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
import { afterEach, describe, expect, it, type MockInstance, vi } from "vitest";
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
const MEASURE = process.env.OMP_GUI_LINK_TRAFFIC === "1";

interface Row {
	frames: number;
	bytes: number;
}

/** Counts every message a Link sends, split the way the report reads it. */
class LinkRecorder {
	readonly links = new Map<string, Row>();
	readonly inner = new Map<string, Row>();
	readonly #methods = new Map<number, string>();
	#spy: MockInstance | null = null;

	start(): void {
		const original = Link.prototype.send;
		const record = (message: object): void => this.#record(message as { t: string } & Record<string, unknown>);
		this.#spy = vi.spyOn(Link.prototype, "send").mockImplementation(function (this: Link, message: object) {
			record(message);
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
			const frame = arg as { type?: string; payload?: { event?: { type?: string } } };
			const nested = frame.payload?.event?.type;
			sized.push([`${name}/${frame.type}${nested ? `/${nested}` : ""}`, Buffer.byteLength(JSON.stringify(arg))]);
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

function hostServices(bin: string, workDir: string): LocalHostServices {
	return new LocalHostServices({
		createSidecar: (cwd, kind, fresh) =>
			new SidecarManager({ omp: ompAt(bin), cwd, kind, fresh }) as unknown as SidecarLike,
		hostName: () => "Studio",
		sessionIndex: {
			list: async () => [],
			searchContent: async () => [],
			kindFor: async () => "chat",
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
	/** What the host wrote to its `remote-link` runtime log. */
	hostLog: Array<{ message: string; details: Record<string, unknown> }>;
	/** Runs one scripted turn and resolves when the host's omp settled it. */
	turn(scenario: object): Promise<void>;
	setLevel(level: "off" | "progress" | "events"): Promise<void>;
}

const rigs: DevicesRig[] = [];
const recorders: LinkRecorder[] = [];

async function openSession(): Promise<Session> {
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
	const hostLog: Session["hostLog"] = [];
	const { a, hostId } = await rig.connected({
		services: hostServices(bin, workDir),
		logLink: (message, details) => hostLog.push({ message, details }),
	});
	const sidecar = a.devices.createSidecar(hostId, "t1", workDir, "agent", true);
	const ready = Promise.withResolvers<void>();
	sidecar.on("status", ({ status }: { status: string }) => {
		if (status === "ready") ready.resolve();
	});
	sidecar.start();
	await ready.promise;
	const recorder = new LinkRecorder();
	recorders.push(recorder);
	recorder.start();
	return {
		sidecar,
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
		await turn({ kind: "stream", thinkingTokens: 100, textTokens: 300, tokenMs: 0 });
		await rig.dispose();

		const traffic = hostLog.filter(line => line.message === "traffic");
		expect(traffic).toHaveLength(1);
		const details = traffic[0]?.details as {
			top: Array<{ kind: string }>;
			events: Record<string, number>;
		};
		expect(details.top[0]?.kind).toBe("tx evt tab.event events");
		expect(details.events.message_update).toBeGreaterThan(400);
		expect(JSON.stringify(details)).not.toContain("session transcript");
	}, 30_000);
});
