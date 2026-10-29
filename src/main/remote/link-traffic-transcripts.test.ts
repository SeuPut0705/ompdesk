/**
 * A minute of a paired device showing a run of four subagents, in wire bytes the host sends (frame header, encryption
 * and deflate included: what the host's `traffic` line counts). The host's omp is the scripted one, which reads each
 * subagent's journal as stock does (`get_subagent_messages` from a byte offset); the journals are shaped like stock's
 * (each assistant message carries its request bookkeeping, a thinking block its signature).
 *
 * The same minute twice: as a 0.82.1 device asks (every replay of a lane or work card and every open of the Subagent
 * view read the whole journal again, and an open view kept reading while the window was hidden), and as this build
 * asks (`createSubagentTranscripts`: one cursor per agent, a settled agent not asked again, nothing while hidden).
 * `OMP_GUI_LINK_TRAFFIC=1` prints the bytes a minute of each. Measured 29 Oct 2026: before the host left stock's
 * `entries`, the request bookkeeping and thinking signatures out of its answers, the 0.82.1 device's minute was
 * 2,630 KB in 57 reads (this build's reads 1,497 KB in 14); after it, 293 KB and 167 KB. The relaunch's four replays
 * are most of what is left: a relaunched app holds nothing.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { transcriptPageMessages } from "../../../resources/gui-bridge/transcript-page";
import { createSubagentTranscripts } from "../../renderer/stores/subagent-transcripts";
import type { AgentMessage, RpcCommand, RpcResponse } from "../../shared/rpc-types";
import { closeSessions, openSession } from "./link-traffic-test-rig";
import { Link, type TrafficHandler } from "./wire";

const PRINT = process.env.OMP_GUI_LINK_TRAFFIC === "1";
const AGENTS = ["Scout1", "Scout2", "Scout3", "Scout4"];
/** Turns each agent's journal holds once it settles; half of them while it runs. */
const TURNS = 40;

afterEach(async () => {
	vi.restoreAllMocks();
	await closeSessions();
});

interface Source {
	text(count: number): string;
	bytes(count: number): string;
}

/** A deterministic word and byte source, so every run writes the same journals. */
function random(seed: number): Source {
	let state = seed;
	const next = () => {
		state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
		return state;
	};
	const words = Array.from({ length: 240 }, (_, index) => `w${(index * 7919).toString(36)}`);
	return {
		text: (count: number) => Array.from({ length: count }, () => words[next() % words.length]).join(" "),
		bytes: (count: number) => Buffer.from(Array.from({ length: count }, () => next() % 256)).toString("base64"),
	};
}

/**
 * The tools stock declares to a subagent's provider on every request (`requestControls.tools.declared`): about 25 KB a
 * message in a real journal with a few MCP servers (28 Oct 2026).
 */
const DECLARED = Array.from(
	{ length: 700 },
	(_, index) => `mcp__server_${index % 13}_${["read", "list", "update", "search", "open"][index % 5]}_item_${index}`,
);

/** One turn of a subagent's journal as stock writes it: the assistant's message and its tool call's result. */
function turn(agent: string, index: number, source: Source): string {
	const timestamp = 1_760_000_000_000 + index * 4_000;
	const callId = `toolu_${agent}_${index}`;
	const assistant = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: source.text(160), thinkingSignature: source.bytes(900) },
			{ type: "toolCall", id: callId, name: "read", arguments: { path: `src/main/remote/${source.text(1)}.ts` } },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: { input: 1200 + index, output: 380, cacheRead: 41_000, cacheWrite: 900, totalTokens: 43_480 },
		stopReason: "toolUse",
		timestamp,
		requestControls: { messageIndex: index * 2, tools: { declared: DECLARED }, effort: "medium" },
		inputTransformations: [{ kind: "dropped-thinking", count: index }],
		contextSnapshot: { messages: index * 2, tokens: 41_000 + index * 900 },
	};
	const result = {
		role: "toolResult",
		toolCallId: callId,
		toolName: "read",
		content: [{ type: "text", text: source.text(180) }],
		details: { lines: 180, truncated: false, preview: source.text(120) },
		isError: false,
		timestamp: timestamp + 900,
	};
	return [assistant, result]
		.map((message, part) => JSON.stringify({ type: "message", id: `${agent}-${index}-${part}`, message }))
		.join("\n");
}

async function writeJournals(workDir: string, turns: number): Promise<void> {
	const dir = path.join(workDir, "subagents");
	await mkdir(dir, { recursive: true });
	for (const [order, agent] of AGENTS.entries()) {
		const source = random(order + 1);
		const lines = Array.from({ length: turns }, (_, index) => turn(agent, index, source));
		await writeFile(path.join(dir, `${agent}.jsonl`), `${lines.join("\n")}\n`);
	}
}

/** Counts what the host's links send, and the requests they answer, as its traffic line would. */
function countHostWire() {
	const wire = { tx: 0, requests: 0 };
	const original = Link.prototype.onTraffic;
	vi.spyOn(Link.prototype, "onTraffic").mockImplementation(function (this: Link, handler: TrafficHandler) {
		original.call(this, (direction, message, bytes) => {
			if (direction === "tx") wire.tx += bytes;
			else if ("t" in message && message.t === "req") wire.requests++;
			handler(direction, message, bytes);
		});
	});
	return wire;
}

/** What one device build asks for in the scenario's minute. */
interface DeviceReads {
	/** A lane or work card replays the agent (`hydrateSurface`). */
	replay(id: string, settled?: string): Promise<void>;
	/** The Subagent view opens on the agent. */
	open(id: string, settled?: string): Promise<void>;
	/** A progress frame or the 4 s poll reaches the open view while the window is hidden. */
	followHidden(id: string): Promise<void>;
	/** The window shows again with the view open. */
	shown(id: string): Promise<void>;
	/** The app relaunched (an update): it holds nothing. */
	relaunch(): void;
	/** What the open view shows for the agent. */
	view(id: string): AgentMessage[];
}

type Send = (command: RpcCommand) => Promise<RpcResponse>;

const transcriptOf = (response: RpcResponse) => {
	if (!response.success) throw new Error(response.error);
	return response.data as { messages: AgentMessage[]; nextByte: number };
};

/** 0.82.1: `hydrateSurface` read the whole journal each time; the view read it whole at every open, then followed. */
function olderDevice(send: Send, journal: (id: string) => string): DeviceReads {
	const views = new Map<string, { messages: AgentMessage[]; nextByte: number }>();
	const follow = async (id: string) => {
		const view = views.get(id) ?? { messages: [], nextByte: 0 };
		const read = transcriptOf(
			await send({
				type: "get_subagent_messages",
				subagentId: id,
				sessionFile: journal(id),
				fromByte: view.nextByte,
			}),
		);
		views.set(id, { messages: [...view.messages, ...read.messages], nextByte: read.nextByte });
	};
	return {
		replay: async id => void transcriptOf(await send({ type: "get_subagent_messages", subagentId: id })),
		open: async id => {
			views.delete(id);
			await follow(id);
		},
		followHidden: follow,
		shown: follow,
		relaunch: () => views.clear(),
		view: id => views.get(id)?.messages ?? [],
	};
}

/** This build: one cursor per agent for every view and replay; an open view asks nothing while the window is hidden. */
function currentDevice(send: Send, journal: (id: string) => string): DeviceReads {
	let transcripts = createSubagentTranscripts(send);
	return {
		replay: async (id, settled) => void (await transcripts.read(id, { settled })),
		open: async (id, settled) => void (await transcripts.read(id, { sessionFile: journal(id), settled })),
		followHidden: async () => {},
		shown: async id => void (await transcripts.read(id, { sessionFile: journal(id) })),
		relaunch: () => {
			transcripts = createSubagentTranscripts(send);
		},
		view: id => transcripts.held(id)?.messages ?? [],
	};
}

const DEVICES = { "0.82.1": olderDevice, current: currentDevice };

async function minute(build: keyof typeof DEVICES) {
	// The spy has to be in place before the link exists.
	const wire = countHostWire();
	const session = await openSession();
	const journal = (id: string) => path.join(session.workDir, "subagents", `${id}.jsonl`);
	await writeJournals(session.workDir, TURNS / 2);
	const send: Send = command => {
		const client = session.sidecar.rpcClient;
		if (!client) throw new Error("the device's tab has no client");
		return client.command(command);
	};
	const device = DEVICES[build](send, journal);
	wire.tx = 0;
	wire.requests = 0;
	// The run's lanes replay its four agents while they work.
	for (const id of AGENTS) await device.replay(id);
	// The person opens the first one's view, then the window is hidden for 40 s while they work: ten 4 s polls and
	// 30 progress frames that moved the view's mark reach the view.
	await device.open(AGENTS[0]);
	for (let tick = 0; tick < 40; tick++) await device.followHidden(AGENTS[0]);
	// They finish; the window shows again, and each lane replays its completion.
	await writeJournals(session.workDir, TURNS);
	await device.shown(AGENTS[0]);
	const settled = (id: string) => `completed:${id}`;
	for (const id of AGENTS) await device.replay(id, settled(id));
	// The view is closed and opened again, and the second agent's view opened.
	await device.open(AGENTS[0], settled(AGENTS[0]));
	await device.open(AGENTS[1], settled(AGENTS[1]));
	// The device updates and relaunches: the work card replays the four settled agents.
	device.relaunch();
	for (const id of AGENTS) await device.replay(id, settled(id));
	await device.open(AGENTS[0], settled(AGENTS[0]));
	const shown = device.view(AGENTS[0]);
	const { tx: sent, requests } = wire;
	vi.restoreAllMocks();
	await closeSessions();
	return { sent, requests, shown };
}

describe("subagent transcripts over the link", () => {
	it("a minute of a run's four subagents asks a fraction of what a 0.82.1 device asked, and shows the same", async () => {
		const older = await minute("0.82.1");
		const current = await minute("current");
		if (PRINT)
			for (const [build, run] of Object.entries({ "0.82.1": older, current }))
				console.log(`${build}: ${(run.sent / 1000).toFixed(0)} KB/min in ${run.requests} reads`);
		expect(current.requests).toBeLessThan(older.requests / 3);
		expect(current.sent).toBeLessThan(older.sent * 0.7);
		// Both views show the agent's whole transcript; the host leaves out what no view reads.
		expect(current.shown).toHaveLength(TURNS * 2);
		expect(current.shown).toEqual(transcriptPageMessages(older.shown));
	}, 60_000);
});
