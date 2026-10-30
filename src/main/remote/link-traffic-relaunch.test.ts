/**
 * A paired device's transcript reads over the link and a window's on this computer, for five sessions of four settled
 * subagents each, in wire bytes the host's links send (frame header, encryption and deflate included: what the host's
 * `traffic` line counts) and the JSON a window's reads answer (what crosses the IPC).
 *
 * The device's hours, as its renderer reads (`hydrateTabSession`: `get_state` and the tail page, asked `ifVersion` of
 * the rows a tab holds; the work cards' replays through `createSubagentTranscripts`): each session opened once; 20 tab
 * switches among them; each session switched away and back (the tab's stores start over); the window reloaded (main
 * keeps its link and tabs); one session working on (an agent adds two turns, the session a reply); and the app
 * relaunched (a new `RemoteDevices` on the same user data, each tab restored on its session file: what it kept in
 * memory is gone, what it keeps on disk stays). The window's: the same five sessions opened, 20 switches, a reload.
 * `OMP_GUI_LINK_TRAFFIC=1` prints each phase; `OMP_GUI_TRANSCRIPT_READS_OUT=<prefix>` writes `<prefix>-link.json` and
 * `<prefix>-window.json`. The same file run on the build before (a worktree of it) is the baseline.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { transcriptPageMessages } from "../../../resources/gui-bridge/transcript-page";
import { createSubagentTranscripts, type SubagentTranscripts } from "../../renderer/stores/subagent-transcripts";
import type { AgentMessage, RpcCommand, RpcResponse } from "../../shared/rpc-types";
import { SidecarManager } from "../sidecar";
import { RM_TEMP, writeFakeOmp } from "../test-fake-omp";
import { closeSessions, openSession } from "./link-traffic-test-rig";
import type { RemoteSidecar } from "./remote-sidecar";
import type { Computer } from "./test-devices";
import { Link, type TrafficHandler } from "./wire";

const PRINT = process.env.OMP_GUI_LINK_TRAFFIC === "1";
const OUT = process.env.OMP_GUI_TRANSCRIPT_READS_OUT;
const SESSIONS = 5;
const AGENTS = ["Scout1", "Scout2", "Scout3", "Scout4"];
/** Turns each agent's journal holds. */
const TURNS = 40;
/** Messages in each session's own journal: a tail page of 200 runs past the page budget and is read at 100. */
const SESSION_MESSAGES = 400;
const SWITCHES = 20;
/** The renderer's tail read (`fetchTranscriptTail`, `TRANSCRIPT_TAIL_LIMIT`). */
const TAIL = { type: "get_transcript_page", fromEnd: true, limit: 200 } as const;

afterEach(async () => {
	vi.restoreAllMocks();
	await closeSessions();
});

/** Words drawn by a seeded generator, as varied as a real reply's: a fixed pattern would deflate to nothing. */
const WORDS = Array.from({ length: 4000 }, (_, index) => `w${(index * 7919).toString(36)}`);
function words(count: number, seed: number): string {
	let state = Math.imul(seed, 2_654_435_761) | 0 || 1;
	const picked: string[] = [];
	for (let index = 0; index < count; index++) {
		// xorshift32: every bit varies, so the words are as hard to deflate as a real reply's.
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		picked.push(WORDS[(state >>> 0) % WORDS.length] ?? "w");
	}
	return picked.join(" ");
}
const DECLARED = Array.from({ length: 700 }, (_, index) => `mcp__server_${index % 13}_item_${index}`);

/**
 * One turn of a subagent's journal as stock writes it: the assistant's message, its bookkeeping, the tool's result.
 * `seed` makes each session's and agent's text its own.
 */
function turn(agent: string, index: number, seed: number): string {
	const timestamp = 1_760_000_000_000 + index * 4_000;
	const callId = `toolu_${agent}_${index}`;
	const assistant = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: words(160, seed + index), thinkingSignature: words(200, seed + index + 99) },
			{ type: "toolCall", id: callId, name: "read", arguments: { path: `src/${words(1, index)}.ts` } },
		],
		usage: { input: 1200 + index, output: 380, cacheRead: 41_000, cacheWrite: 900, totalTokens: 43_480 },
		stopReason: "toolUse",
		timestamp,
		requestControls: { messageIndex: index * 2, tools: { declared: DECLARED } },
	};
	const result = {
		role: "toolResult",
		toolCallId: callId,
		toolName: "read",
		content: [{ type: "text", text: words(180, seed + index + 7) }],
		isError: false,
		timestamp: timestamp + 900,
	};
	return [assistant, result]
		.map((message, part) => JSON.stringify({ type: "message", id: `${agent}-${index}-${part}`, message }))
		.join("\n");
}

/** A session's own messages: a prompt, then replies of about 1.4 KB and their tools' results. */
function sessionMessage(index: number, seed: number): string {
	const timestamp = 1_760_000_000_000 + index * 9_000;
	if (index % 40 === 0) return JSON.stringify({ role: "user", content: words(30, seed + index), timestamp });
	if (index % 2 === 1)
		return JSON.stringify({
			role: "assistant",
			content: [
				{ type: "text", text: words(120, seed + index) },
				{ type: "toolCall", id: `call_${index}`, name: "bash", arguments: { command: words(6, index) } },
			],
			stopReason: "toolUse",
			timestamp,
		});
	return JSON.stringify({
		role: "toolResult",
		toolCallId: `call_${index - 1}`,
		toolName: "bash",
		content: [{ type: "text", text: words(110, seed + index) }],
		isError: false,
		timestamp,
	});
}

async function writeWork(workDir: string, session: number): Promise<void> {
	await mkdir(path.join(workDir, "subagents"), { recursive: true });
	for (const [order, agent] of AGENTS.entries()) {
		const lines = Array.from({ length: TURNS }, (_, index) => turn(agent, index, (session * 10 + order) * 100_000));
		await writeFile(path.join(workDir, "subagents", `${agent}.jsonl`), `${lines.join("\n")}\n`);
	}
	const messages = Array.from({ length: SESSION_MESSAGES }, (_, index) => sessionMessage(index, session * 7_000_000));
	await writeFile(path.join(workDir, "transcript.jsonl"), `${messages.join("\n")}\n`);
}

interface Wire {
	tx: number;
	requests: number;
	/** Wire bytes by the tab command they carried (request and answer). */
	byCommand: Map<string, number>;
}

/** Counts what the host's links send, by the tab command each answer is for, as its traffic line would. */
function countWire(): Wire {
	const wire: Wire = { tx: 0, requests: 0, byCommand: new Map() };
	const asked = new Map<number, string>();
	const add = (kind: string, bytes: number) => wire.byCommand.set(kind, (wire.byCommand.get(kind) ?? 0) + bytes);
	const original = Link.prototype.onTraffic;
	vi.spyOn(Link.prototype, "onTraffic").mockImplementation(function (this: Link, handler: TrafficHandler) {
		original.call(this, (direction, message, bytes) => {
			const wireMessage = message as {
				t?: string;
				id?: number;
				method?: string;
				params?: { command?: { type?: string } };
			};
			if (direction === "rx" && wireMessage.t === "req" && typeof wireMessage.id === "number") {
				wire.requests++;
				asked.set(wireMessage.id, wireMessage.params?.command?.type ?? wireMessage.method ?? "?");
			} else if (direction === "tx") {
				wire.tx += bytes;
				if (wireMessage.t === "res" && typeof wireMessage.id === "number")
					add(asked.get(wireMessage.id) ?? "?", bytes);
				else add(wireMessage.t ?? "?", bytes);
			}
			handler(direction, message, bytes);
		});
	});
	return wire;
}

interface Phase {
	name: string;
	sent: number;
	requests: number;
	cpuMs: number;
	byCommand: Record<string, number>;
}

type Send = (command: RpcCommand) => Promise<RpcResponse>;

/** One tab as the device's renderer holds it: its sidecar's commands and the tab's subagent transcripts. */
interface Tab {
	send: Send;
	transcripts: SubagentTranscripts;
	workDir: string;
	/** Messages the tab shows from its tail page, and the page's version (`tailVersion`). */
	shown: AgentMessage[];
	version?: string;
}

/** Each agent's settled mark: a run that settles again gets a new one, so its replays read what it added. */
const marks = new Map<string, string>();
const settled = (id: string) => marks.get(id) ?? `completed:${id}`;

function tabOf(sidecar: RemoteSidecar, workDir: string): Tab {
	const send: Send = command => {
		const client = sidecar.rpcClient;
		if (!client) throw new Error("the device's tab has no client");
		return client.command(command);
	};
	return { send, transcripts: createSubagentTranscripts(send), workDir, shown: [] };
}

/**
 * `hydrateTabSession`'s transcript reads: the state and the tail page, asked `ifVersion` of the rows the tab holds
 * when a build's pages carry a version (`fetchTranscriptTail`); the work cards replay each agent.
 */
async function hydrate(tab: Tab, replay: boolean): Promise<void> {
	const tail = tab.version && tab.shown.length > 0 ? { ...TAIL, ifVersion: tab.version } : TAIL;
	const [, page] = await Promise.all([tab.send({ type: "get_state", brief: true }), tab.send(tail)]);
	if (!page.success) throw new Error(page.error);
	const data = page.data as { messages: AgentMessage[]; version?: string; unchanged?: boolean };
	if (data.unchanged !== true) {
		tab.shown = data.messages;
		tab.version = data.version;
	}
	if (replay) for (const id of AGENTS) await tab.transcripts.read(id, { settled: settled(id) });
}

function startSidecar(device: Computer, hostId: string, rtab: string, workDir: string, resume?: string) {
	const sidecar = device.devices.createSidecar(hostId, rtab, workDir, "agent", !resume);
	const ready = Promise.withResolvers<void>();
	sidecar.on("status", ({ status }: { status: string }) => {
		if (status === "ready") ready.resolve();
	});
	// A restored tab starts on its session file (the pool's `restart` of an asleep tab); a new one starts fresh.
	if (resume) sidecar.restart(workDir, resume);
	else sidecar.start();
	return { sidecar, ready: ready.promise };
}

async function hours() {
	const wire = countWire();
	const first = await openSession({ bridge: true });
	const workDirs = [first.workDir];
	for (let index = 1; index < SESSIONS; index++) {
		const dir = path.join(path.dirname(first.workDir), `work${index}`);
		await mkdir(dir);
		workDirs.push(dir);
	}
	for (const [index, dir] of workDirs.entries()) await writeWork(dir, index + 1);
	let device = first.device;
	const sidecars: RemoteSidecar[] = [first.sidecar];
	for (const [index, dir] of workDirs.entries()) {
		if (index === 0) continue;
		const started = startSidecar(device, first.hostId, `t${index + 1}`, dir);
		await started.ready;
		sidecars.push(started.sidecar);
	}
	let tabs = sidecars.map((sidecar, index) => tabOf(sidecar, workDirs[index] ?? ""));
	const phases: Phase[] = [];
	const phase = async (name: string, run: () => Promise<void>) => {
		wire.tx = 0;
		wire.requests = 0;
		wire.byCommand.clear();
		const started = process.cpuUsage();
		await run();
		const cpu = process.cpuUsage(started);
		phases.push({
			name,
			sent: wire.tx,
			requests: wire.requests,
			cpuMs: (cpu.user + cpu.system) / 1000,
			byCommand: Object.fromEntries([...wire.byCommand].sort((a, b) => b[1] - a[1])),
		});
	};
	await phase("open 5 sessions", async () => {
		for (const tab of tabs) await hydrate(tab, true);
	});
	await phase("20 tab switches", async () => {
		for (let index = 0; index < SWITCHES; index++) await hydrate(tabs[index % SESSIONS] as Tab, false);
	});
	await phase("session switch and back", async () => {
		for (const tab of tabs) {
			// The tab's stores start over: its subagents and its rows.
			tab.transcripts = createSubagentTranscripts(tab.send);
			tab.shown = [];
			tab.version = undefined;
			await hydrate(tab, true);
		}
	});
	await phase("window reload", async () => {
		tabs = tabs.map(tab => tabOf(sidecars[tabs.indexOf(tab)] as RemoteSidecar, tab.workDir));
		for (const tab of tabs) await hydrate(tab, true);
	});
	await phase("one session works on", async () => {
		// The first session's first agent runs two more turns and the session gains a reply: only that crosses.
		const dir = workDirs[0] ?? "";
		const more = [TURNS, TURNS + 1].map(index => turn(AGENTS[0] ?? "", index, 1_000_000));
		await appendFile(path.join(dir, "subagents", `${AGENTS[0]}.jsonl`), `${more.join("\n")}\n`);
		const replies = [SESSION_MESSAGES, SESSION_MESSAGES + 1].map(index => sessionMessage(index, 7_000_000));
		await appendFile(path.join(dir, "transcript.jsonl"), `${replies.join("\n")}\n`);
		marks.set(AGENTS[0] ?? "", "completed:again");
		const tab = tabs[0] as Tab;
		await hydrate(tab, true);
	});
	await phase("device relaunch", async () => {
		const { userData, prefs, fake } = device;
		await device.devices.dispose();
		device = await first.rig.computer("Laptop", fake, { userData, prefs });
		device.devices.start();
		// Each tab reopens the session file its host named (`get_state`), as a restored tab does.
		const files = await Promise.all(workDirs.map(async dir => path.join(await realpath(dir), "session.jsonl")));
		const reopened = workDirs.map((dir, index) =>
			startSidecar(device, first.hostId, `r${index + 1}`, dir, files[index]),
		);
		await Promise.all(reopened.map(started => started.ready));
		sidecars.splice(0, sidecars.length, ...reopened.map(started => started.sidecar));
		tabs = sidecars.map((sidecar, index) => tabOf(sidecar, workDirs[index] ?? ""));
		for (const tab of tabs) await hydrate(tab, true);
	});
	const journal = (await readFile(path.join(workDirs[0] ?? "", "subagents", `${AGENTS[0]}.jsonl`), "utf8"))
		.split("\n")
		.filter(Boolean)
		.map(line => (JSON.parse(line) as { message: AgentMessage }).message);
	const lastLine = (await readFile(path.join(workDirs[0] ?? "", "transcript.jsonl"), "utf8"))
		.trim()
		.split("\n")
		.at(-1);
	const held = tabs[0]?.transcripts.held(AGENTS[0] ?? "")?.messages ?? [];
	const shown = tabs[0]?.shown ?? [];
	vi.restoreAllMocks();
	await device.devices.dispose();
	await closeSessions();
	return { phases, held, shown, journal, last: JSON.parse(lastLine ?? "null") as AgentMessage };
}

const kb = (bytes: number) => `${(bytes / 1000).toFixed(1)} KB`;

/**
 * The same sessions in a window of this computer: five tabs on omps here (`SidecarManager`, the local handlers), the
 * renderer's reads counted as the JSON each answer carries over the IPC.
 */
async function windowHours() {
	const dir = await mkdtemp(path.join(tmpdir(), "omp-gui-window-reads-"));
	const bin = await writeFakeOmp(
		dir,
		readFileSync(fileURLToPath(new URL("./test-traffic-omp.ts", import.meta.url)), "utf8"),
	);
	const ipc = { bytes: 0, requests: 0 };
	const sidecars: SidecarManager[] = [];
	try {
		const tabs: Tab[] = [];
		for (let index = 0; index < SESSIONS; index++) {
			const workDir = path.join(dir, `work${index}`);
			await mkdir(workDir);
			await writeWork(workDir, index + 1);
			const sidecar = new SidecarManager({
				omp: async () => ({
					ok: true,
					runtime: { bin, version: "18.6.1", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
				}),
				cwd: workDir,
				kind: "agent",
				fresh: true,
				bridgeDir: path.join(dir, "bridge"),
			});
			sidecars.push(sidecar);
			const ready = Promise.withResolvers<void>();
			sidecar.on("status", ({ status }: { status: string }) => {
				if (status === "ready") ready.resolve();
			});
			sidecar.start();
			await ready.promise;
			const send: Send = async command => {
				const client = sidecar.rpcClient;
				if (!client) throw new Error("the tab has no client");
				const response = await client.command(command);
				ipc.requests++;
				ipc.bytes += Buffer.byteLength(JSON.stringify(response));
				return response;
			};
			tabs.push({ send, transcripts: createSubagentTranscripts(send), workDir, shown: [] });
		}
		const phases: Phase[] = [];
		const phase = async (name: string, run: () => Promise<void>) => {
			ipc.bytes = 0;
			ipc.requests = 0;
			const started = process.cpuUsage();
			await run();
			const cpu = process.cpuUsage(started);
			phases.push({
				name,
				sent: ipc.bytes,
				requests: ipc.requests,
				cpuMs: (cpu.user + cpu.system) / 1000,
				byCommand: {},
			});
		};
		await phase("open 5 sessions", async () => {
			for (const tab of tabs) await hydrate(tab, true);
		});
		await phase("20 tab switches", async () => {
			for (let index = 0; index < SWITCHES; index++) await hydrate(tabs[index % SESSIONS] as Tab, false);
		});
		await phase("window reload", async () => {
			for (const tab of tabs) {
				tab.transcripts = createSubagentTranscripts(tab.send);
				tab.shown = [];
				tab.version = undefined;
				await hydrate(tab, true);
			}
		});
		return { phases, shown: tabs[0]?.shown ?? [] };
	} finally {
		for (const sidecar of sidecars) sidecar.dispose();
		await rm(dir, RM_TEMP);
	}
}

function report(name: string, phases: Phase[]): void {
	if (PRINT)
		for (const p of phases) {
			console.log(`${name} ${p.name}: ${kb(p.sent)} in ${p.requests} requests, ${p.cpuMs.toFixed(0)} ms CPU`);
			for (const [kind, bytes] of Object.entries(p.byCommand)) console.log(`    ${kind.padEnd(28)} ${kb(bytes)}`);
		}
	if (OUT) writeFileSync(`${OUT}-${name}.json`, `${JSON.stringify(phases, null, 2)}\n`);
}

describe("transcript reads over the link", () => {
	it("a device's sessions, tab switches, reload and relaunch read each transcript once per change", async () => {
		const run = await hours();
		report("link", run.phases);
		// The device shows the first agent's whole journal and the session's newest reply, as the host has them.
		expect(run.held).toHaveLength((TURNS + 2) * 2);
		expect(run.held).toEqual(transcriptPageMessages(run.journal));
		expect(run.shown.at(-1)).toEqual(run.last);
		// Measured 30 Oct 2026, wire bytes (median of 5): a relaunch 1,040 → 4.6 KB, a session switch and back 640 →
		// 2.4 KB, a window reload 639 → 1.4 KB; only the first open reads everything.
		const sent = (name: string) => run.phases.find(p => p.name === name)?.sent ?? Number.POSITIVE_INFINITY;
		const first = sent("open 5 sessions");
		for (const name of ["session switch and back", "window reload", "device relaunch"])
			expect(sent(name)).toBeLessThan(first / 50);
	}, 180_000);
});

describe("transcript reads in a window of this computer", () => {
	it("tab switches and a reload of a window read the same transcripts", async () => {
		const run = await windowHours();
		report("window", run.phases);
		expect(run.shown.length).toBeGreaterThan(0);
		// Measured 30 Oct 2026: 20 switches 3,880 → 12.9 KB of IPC; a reload still reads what the fresh window shows.
		const sent = (name: string) => run.phases.find(p => p.name === name)?.sent ?? Number.POSITIVE_INFINITY;
		expect(sent("20 tab switches")).toBeLessThan(sent("open 5 sessions") / 50);
	}, 180_000);
});
