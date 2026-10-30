/**
 * Real wall-clock phases on purpose: the OS watch, the stock helper's scans and the debounces they feed run on the
 * platform clock, which is what this audit measures.
 *
 * Opt-in audit of what this computer spends keeping every session list current (`OMP_GUI_SESSION_LISTS=<dir>`, label
 * `OMP_GUI_SESSION_LISTS_LABEL`): two desktop windows and two paired computers (one window each) show this computer's
 * sidebar, first idle, then while agents append to their journals. Real parts: the session index over a real sessions
 * tree with its OS watch and the stock helper's `sessions.list`, the host services that answer the paired computers,
 * the sidebar's project list, and the renderer's own session-list feed (`stores/session-list.ts`), one module instance
 * per window, each window's `window` given by an AsyncLocalStorage. What carries a call between them (Electron IPC, the
 * encrypted link) is a direct call here; its bytes are counted as the JSON it would carry, and a link frame also as
 * deflate-raw at level 3 (the link's standalone rule for a frame of 1 KB or more). Writes `<dir>/<label>.json`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import type { IpcSessionsChanged, SessionInfo } from "../shared/ipc-types";
import { initDeletedSessions } from "./deleted-sessions";
import { ompPackageRoot } from "./omp-runtime";
import type { HostConnection } from "./remote/host-server";
import { LocalHostServices } from "./remote/host-services";
import { HostSessionList } from "./remote/host-session-list";
import type { PeerInfo } from "./remote/peers-store";
import { slimOf } from "./remote/protocol";
import { SessionIndex } from "./session-index";
import { SidebarProjects } from "./sidebar-projects";
import type { SidecarLike } from "./sidecar-types";

const counts = vi.hoisted(() => ({ stock: new Map<string, number>() }));
vi.mock("./stock-helper", async importOriginal => {
	const actual = await importOriginal<typeof import("./stock-helper")>();
	return {
		...actual,
		stockHelperRequest: (method: string, params?: unknown, options?: object) => {
			counts.stock.set(method, (counts.stock.get(method) ?? 0) + 1);
			return actual.stockHelperRequest(method, params, options);
		},
	};
});

const OUT = process.env.OMP_GUI_SESSION_LISTS;
const LABEL = process.env.OMP_GUI_SESSION_LISTS_LABEL ?? "run";
const IDLE_S = Number(process.env.OMP_GUI_SESSION_LISTS_IDLE_S) || 30;
const BUSY_S = Number(process.env.OMP_GUI_SESSION_LISTS_BUSY_S) || 60;
const stockRoot = ompPackageRoot(path.join(os.homedir(), ".bun", "bin", "omp"));
const HOST = "host-studio";

/** What one renderer window (a module instance of the feed) is given as `window`. */
interface Win {
	name: string;
	device: string | undefined;
	listeners: Set<(change: IpcSessionsChanged) => void>;
	storage: Map<string, string>;
	omp: unknown;
	setTimeout: typeof setTimeout;
	clearTimeout: typeof clearTimeout;
	feed?: { store: { getState(): { sessions: SessionInfo[] } }; retain(): () => void };
}

const als = new AsyncLocalStorage<Win>();

/** Counters per phase. */
class Meter {
	asks = new Map<string, number>();
	bytes = new Map<string, number>();
	add(kind: string, value: unknown): void {
		this.asks.set(kind, (this.asks.get(kind) ?? 0) + 1);
		const json = JSON.stringify(value ?? null);
		this.bytes.set(`${kind} json`, (this.bytes.get(`${kind} json`) ?? 0) + json.length);
		if (kind.startsWith("link")) {
			const wire =
				json.length >= 1024 ? Math.min(json.length, deflateRawSync(json, { level: 3 }).length) : json.length;
			this.bytes.set(`${kind} wire`, (this.bytes.get(`${kind} wire`) ?? 0) + wire);
		}
	}
}

let meter = new Meter();

function memoryStorage(map: Map<string, string>) {
	return {
		get length() {
			return map.size;
		},
		key: (i: number) => [...map.keys()][i] ?? null,
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => void map.set(k, v),
		removeItem: (k: string) => void map.delete(k),
	};
}

/** CPU seconds the stock helper workers have used (every `host.ts` child of this process). */
function helperCpuMs(): number {
	const out = execFileSync("ps", ["-A", "-o", "ppid=,time=,command="], { encoding: "utf8" });
	let total = 0;
	for (const line of out.split("\n")) {
		const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
		if (!match || Number(match[1]) !== process.pid || !match[3]?.includes("stock-helper/host.ts")) continue;
		const parts = (match[2] ?? "0").split(":").map(Number);
		const seconds = parts.reduce((sum, part) => sum * 60 + part, 0);
		total += seconds * 1000;
	}
	return total;
}

function lcg(seed: number): () => number {
	let state = ((seed + 1) * 2_654_435_761) % 2_147_483_648;
	return () => {
		state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
		return state;
	};
}

/** Four hundred made-up words, the same on every run. */
const VOCABULARY = (() => {
	const next = lcg(0);
	return Array.from({ length: 400 }, () =>
		Array.from({ length: 2 + (next() % 9) }, () => String.fromCharCode(97 + (next() % 26))).join(""),
	);
})();

/**
 * `count` words of {@link VOCABULARY}, the same for a seed on every run: text that deflates about as much as this Mac's
 * real list (128 KB of JSON, 43 KB deflated), where one sentence repeated would deflate 40x.
 */
function words(seed: number, count: number): string {
	const next = lcg(seed);
	return Array.from({ length: count }, () => VOCABULARY[next() % VOCABULARY.length]).join(" ");
}

async function writeTree(root: string): Promise<{ files: string[]; subagentDir: string }> {
	const files: string[] = [];
	const now = Date.now();
	for (let project = 0; project < 12; project++) {
		const cwd = `/work/project-${project}`;
		const dir = path.join(root, `-work-project-${project}`);
		await fs.mkdir(dir, { recursive: true });
		for (let n = 0; n < 5; n++) {
			const id = `p${project}-s${n}-0000-0000-000000000000`;
			const file = path.join(dir, `${id}.jsonl`);
			const at = new Date(now - (project * 5 + n) * 3_600_000).toISOString();
			// Real lists here carry long first prompts (agent briefs): about 2 KB a row on this Mac's 61 sessions.
			const prompt = `<ompdesk-agent-message from="boss">${words(project * 5 + n, 60 + ((project * 7 + n * 13) % 500))}</ompdesk-agent-message>`;
			const lines = [
				{ type: "title", title: "" },
				{ type: "session", version: 3, id, timestamp: at, cwd },
				{
					type: "message",
					id: `${id}-u`,
					timestamp: at,
					message: { role: "user", content: prompt, timestamp: Date.parse(at) },
				},
				{
					type: "message",
					id: `${id}-a`,
					timestamp: at,
					message: {
						role: "assistant",
						stopReason: "stop",
						content: [{ type: "text", text: "Done." }],
						timestamp: Date.parse(at),
					},
				},
			];
			await fs.writeFile(file, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
			files.push(file);
		}
	}
	const subagentDir = path.join(path.dirname(files[0] ?? root), path.basename(files[0] ?? "x", ".jsonl"));
	await fs.mkdir(subagentDir, { recursive: true });
	return { files, subagentDir };
}

function appendEntry(file: string, n: number): Promise<void> {
	const at = new Date().toISOString();
	const entry = {
		type: "message",
		id: `e${n}`,
		timestamp: at,
		message: {
			role: "assistant",
			stopReason: "toolUse",
			content: [{ type: "text", text: `step ${n} `.repeat(40) }],
			timestamp: Date.now(),
		},
	};
	return fs.appendFile(file, `${JSON.stringify(entry)}\n`);
}

function peer(deviceId: string): PeerInfo {
	return { deviceId, name: deviceId, staticPub: "pub", nodeId: `n-${deviceId}`, login: null, pairedAt: 0 };
}

/** A current device's hello (`client.ts`): the link capabilities a device of this build asks for. */
const HELLO = {
	t: "hello",
	protocol: 1,
	appVersion: "audit",
	name: "device",
	slimEvents: true,
	slimProgress: true,
	slimAutopilot: true,
	slimAutopilotReads: true,
	slimListReads: true,
	slimShiftedReads: true,
	slimSettingsReads: true,
	slimRosterReads: true,
	slimJobsReads: true,
	deflate: true,
	slimSessionLists: true,
} as const;

describe.skipIf(!OUT || !stockRoot)("session lists across windows and paired computers", () => {
	it(
		"measures asks, bytes and CPU idle and while agents append",
		async () => {
			const agent = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-session-lists-"));
			const previousAgent = process.env.PI_CODING_AGENT_DIR;
			process.env.PI_CODING_AGENT_DIR = agent;
			const realAgent = path.join(os.homedir(), ".omp", "agent");
			await fs.copyFile(path.join(realAgent, "config.yml"), path.join(agent, "config.yml")).catch(() => {});
			const root = path.join(agent, "sessions");
			const { files, subagentDir } = await writeTree(root);
			initDeletedSessions(null);
			const index = new SessionIndex(root, root, () => false, path.resolve("resources/gui-bridge"));
			const timers: NodeJS.Timeout[] = [];
			try {
				// ---- host: index, the projects list, the paired computers' services
				const services = new LocalHostServices({
					createSidecar: () => {
						throw new Error("no tabs in this audit");
					},
					hostName: () => "Studio",
					sessionIndex: index,
					renameStoredSession: async () => {},
					defaultWorkspace: () => "/work/default",
					launchProfiles: { get: () => undefined, set: () => {} },
					machine: { abortBenchmark: async () => true, abortModelSetup: async () => true } as never,
					localTabs: {
						sessionOwner: () => null,
						windowSessionFiles: () => new Set<string>(),
						sessionOwnerIsLive: () => false,
						sessionRunning: () => false,
						commandForSession: async () => ({ type: "response", command: "get_state", success: true }),
						closeSessionTab: async () => false,
						allSidecars: () => [] as SidecarLike[],
						viewForDevice: () => null,
						stopSession: async () => {},
						noteTouched: () => {},
						notePrompted: () => {},
						beginMove: () => () => {},
					},
					trashItem: async () => {},
				});
				const projects = new SidebarProjects({
					read: () => undefined,
					write: () => {},
					sessions: () => {
						meter.add("projects list", null);
						return index.list("global");
					},
					defaultWorkspace: () => "/work/default",
					projectOf: async cwd => cwd,
					exists: async () => true,
					worktreeKindOf: async () => null,
					autopilotRunOf: async () => null,
					onState: () => {},
				});

				// ---- windows: two desktop windows here, one window on each paired computer
				const windows: Win[] = [];
				const makeWindow = async (name: string, device: string | undefined, omp: (win: Win) => unknown) => {
					const win: Win = {
						name,
						device,
						listeners: new Set(),
						storage: new Map(),
						omp: null,
						setTimeout,
						clearTimeout,
					};
					win.omp = omp(win);
					vi.resetModules();
					const module = await als.run(win, () => import("../renderer/stores/session-list"));
					win.feed = als.run(win, () => module.sessionListFeed("global", device));
					windows.push(win);
					return win;
				};
				const events = (win: Win) => ({
					onSessionsChanged: (callback: (change: IpcSessionsChanged) => void) => {
						win.listeners.add(callback);
						return () => win.listeners.delete(callback);
					},
				});
				const deliver = (win: Win, change: IpcSessionsChanged) => {
					for (const listener of win.listeners) als.run(win, () => listener(change));
				};
				Object.defineProperty(globalThis, "window", {
					configurable: true,
					get: () => als.getStore(),
				});
				Object.defineProperty(globalThis, "localStorage", {
					configurable: true,
					get: () => memoryStorage(als.getStore()?.storage ?? new Map()),
				});

				// ---- What main wires (ipc.ts SESSIONS_LIST and `sessionIndex.onListChange`, devices.ts HostSessionList). The
				// run before the change used main's then wiring: the index's `onChange` pushed `{}` to each window, each
				// window and each device's window then read the whole list (tmp/perf-session-lists/harness-before.test.ts).
				const localWindows: Win[] = [];
				for (const name of ["desktop-1", "desktop-2"])
					localWindows.push(
						await makeWindow(name, undefined, win => ({
							sessions: {
								list: async (scope: "local" | "global") => {
									const rows = await index.list(scope);
									meter.add("ipc answer", rows);
									return rows;
								},
								listShared: async () => {
									const list = await index.listShared();
									meter.add("ipc answer", list);
									return list;
								},
							},
							events: events(win),
						})),
					);
				// Each paired computer: its connection here, its main's copy of this computer's list, its window's asks.
				const conns: Array<HostConnection & { win?: Win; list?: HostSessionList }> = [];
				for (const name of ["device-1", "device-2"]) {
					const conn: HostConnection & { win?: Win; list?: HostSessionList } = {
						peer: peer(name),
						slim: slimOf(HELLO),
						emit: (event, data) => {
							meter.add("link event", { t: "evt", event, data });
							if (event === "sessions.changed") conn.list?.hostChanged(data);
						},
						close: () => {},
					} as HostConnection & { win?: Win; list?: HostSessionList };
					conn.list = new HostSessionList(HOST, {
						read: async params => {
							meter.add("link ask", { t: "req", method: "sessions.list", params });
							const reply = await services.call(conn.peer, "sessions.list", params, conn);
							meter.add("link answer", { t: "res", ok: true, result: reply });
							return reply;
						},
						broadcast: change => {
							meter.add("device ipc push", change);
							if (conn.win) deliver(conn.win, change);
						},
					});
					const list = conn.list;
					conn.win = await makeWindow(`${name}-window`, HOST, win => ({
						sessions: {
							listShared: async () => {
								const shared = await list.current();
								meter.add("device ipc answer", shared);
								return shared;
							},
						},
						events: events(win),
					}));
					conns.push(conn);
				}
				index.onListChange = delta => {
					for (const win of localWindows) {
						const change = delta ? { list: delta } : {};
						meter.add("ipc push", change);
						deliver(win, change);
					}
					services.sessionsChanged();
					projects.schedule();
				};
				const current = async () => index.list("global");
				// ---- end of main's wiring

				const log = (step: string) => console.log(`[session-lists] ${step} ${new Date().toISOString()}`);
				index.start();
				// The OS watch goes live a moment after start: a file it reports proves it.
				const probe = path.join(root, "-work-project-0", "probe.jsonl");
				const live = Promise.withResolvers<void>();
				const before = index.onChange;
				// Slower than the index's 300 ms settle, or each write would hold the last one's report back.
				const poll = setInterval(() => void fs.writeFile(probe, `${Date.now()}\n`), 800);
				const deadline = setTimeout(
					() => live.reject(new Error("the session index never reported a write")),
					20_000,
				);
				index.onChange = changed => {
					if (changed !== probe) return;
					clearInterval(poll);
					clearTimeout(deadline);
					index.onChange = before;
					live.resolve();
				};
				await live.promise;
				log("watch live");
				await fs.rm(probe);
				await new Promise(resolve => setTimeout(resolve, 1_500));
				const releases = windows.map(win => als.run(win, () => win.feed?.retain() ?? (() => {})));
				// Every window shows the list before the phases start.
				await vi.waitFor(
					() => {
						for (const win of windows) expect(win.feed?.store.getState().sessions.length).toBeGreaterThan(0);
					},
					{ timeout: 20_000, interval: 100 },
				);
				log("lists shown");
				await new Promise(resolve => setTimeout(resolve, 3_000));

				const phase = async (name: string, seconds: number, work: () => void) => {
					meter = new Meter();
					counts.stock.clear();
					const cpu = process.cpuUsage();
					const helper = helperCpuMs();
					const started = performance.now();
					work();
					await new Promise(resolve => setTimeout(resolve, seconds * 1000));
					for (const timer of timers.splice(0)) clearInterval(timer);
					// Let the last change settle and reach every window before counting.
					await new Promise(resolve => setTimeout(resolve, 3_000));
					const minutes = (performance.now() - started) / 60_000;
					const used = process.cpuUsage(cpu);
					const perMin = (value: number) => Math.round((value / minutes) * 10) / 10;
					return {
						phase: name,
						minutes: Math.round(minutes * 1000) / 1000,
						stockListPerMin: perMin(counts.stock.get("sessions.list") ?? 0),
						asksPerMin: Object.fromEntries([...meter.asks].map(([kind, n]) => [kind, perMin(n)])),
						kbPerMin: Object.fromEntries([...meter.bytes].map(([kind, n]) => [kind, perMin(n / 1024)])),
						processCpuMsPerMin: perMin((used.user + used.system) / 1000),
						helperCpuMsPerMin: perMin(helperCpuMs() - helper),
					};
				};

				log("idle phase");
				const idle = await phase("idle", IDLE_S, () => {});
				let n = 0;
				log("busy phase");
				const busy = await phase("agents append", BUSY_S, () => {
					// Three agents each commit an entry to their session every 1.5 s, staggered, and one subagent to its own
					// journal every 1.2 s: a busy computer, each write past the index's 300 ms settle.
					for (const [i, file] of [files[0], files[7], files[23]].entries()) {
						const start = setTimeout(() => {
							timers.push(setInterval(() => void appendEntry(file ?? "", n++), 1_500));
						}, i * 500);
						timers.push(start);
					}
					const subagent = path.join(subagentDir, "0-Worker.jsonl");
					timers.push(setInterval(() => void appendEntry(subagent, n++), 1_200));
				});

				// Did it happen: every window shows what the index lists now.
				const expected = (await current()).map(row => `${row.path}:${row.modified}:${row.size}`);
				for (const win of windows)
					expect(
						win.feed?.store.getState().sessions.map(row => `${row.path}:${row.modified}:${row.size}`),
					).toEqual(expected);
				for (const [i, release] of releases.entries()) als.run(windows[i] as Win, release);
				const report = { label: LABEL, rows: expected.length, appended: n, phases: [idle, busy] };
				mkdirSync(OUT ?? ".", { recursive: true });
				writeFileSync(path.join(OUT ?? ".", `${LABEL}.json`), `${JSON.stringify(report, null, 2)}\n`);
				console.log(JSON.stringify(report, null, 2));
			} finally {
				for (const timer of timers) clearInterval(timer);
				index.stop();
				Reflect.deleteProperty(globalThis, "window");
				Reflect.deleteProperty(globalThis, "localStorage");
				if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
				else process.env.PI_CODING_AGENT_DIR = previousAgent;
				await fs.rm(agent, { recursive: true, force: true });
			}
		},
		(IDLE_S + BUSY_S + 120) * 1000,
	);
});
