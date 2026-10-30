/**
 * A paired device viewing a session whose four subagents ran for a few minutes and looked at pictures, in wire bytes
 * the host sends (frame header, encryption and deflate included: what the host's `traffic` line counts). The host's
 * omp is the scripted one: it reads each subagent's journal as stock does and serves stock's blob store through its
 * gui-bridge (`read_image_blob`), and each journal keeps its pictures as stock does, as `blob:sha256:` references.
 *
 * The device's minutes, as its renderer asks (`createSubagentTranscripts`): the run's lanes replay the agents while
 * they work, the person opens one agent's view, the agents finish and every lane replays its completion; then the
 * tab's session store starts over (the host's omp restarted, or the person switched sessions and back) and the work
 * card replays the four agents again; then the device relaunches (an update) and does it once more. In every phase a
 * reply's markdown picture (`fs.readImage`) mounts twice, as rows mount again on scroll and re-render, and once the
 * picture's file changed. `OMP_GUI_LINK_TRAFFIC=1` prints each phase.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSubagentTranscripts } from "../../renderer/stores/subagent-transcripts";
import type { IpcFsReadImageResult } from "../../shared/ipc-types";
import type { AgentMessage, RpcCommand, RpcResponse } from "../../shared/rpc-types";
import { closeSessions, openSession, type Session } from "./link-traffic-test-rig";
import { Link, type TrafficHandler } from "./wire";

const PRINT = process.env.OMP_GUI_LINK_TRAFFIC === "1";
const AGENTS = ["Look1", "Look2", "Look3", "Look4"];
/** Turns each agent's journal holds once it settles; half of them while it runs. Every fourth reads a picture. */
const TURNS = 40;
const IMAGE_EVERY = 4;
/** A browser capture's size in a real journal: 35 pictures were 6.9 MB of base64 (CityLook7, 30 Oct 2026). */
const IMAGE_BYTES = 150_000;
/** The markdown picture the session's reply shows: the 1.8 MB `fs.readImage` answers of 30 Oct 2026. */
const SHOT_BYTES = 1_300_000;

afterEach(async () => {
	vi.restoreAllMocks();
	await closeSessions();
});

/** A deterministic byte source as incompressible as a real capture's (SHA-256 in counter mode), so every run writes the same pictures. */
function random(seed: number): (count: number) => Buffer {
	let counter = 0;
	return count => {
		const blocks: Buffer[] = [];
		for (let made = 0; made < count; made += 32)
			blocks.push(createHash("sha256").update(`${seed}:${counter++}`).digest());
		return Buffer.concat(blocks).subarray(0, count);
	};
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Picture bytes as a PNG sniffs: the signature, then incompressible bytes as a real capture's are. */
function picture(bytes: (count: number) => Buffer, size: number): Buffer {
	return Buffer.concat([PNG_SIGNATURE, bytes(size - PNG_SIGNATURE.length)]);
}

const WORDS = Array.from({ length: 240 }, (_, index) => `w${(index * 7919).toString(36)}`);
const words = (count: number, seed: number) =>
	Array.from({ length: count }, (_, index) => WORDS[(seed * 31 + index * 17) % WORDS.length]).join(" ");

/** One turn of a subagent's journal as stock writes it; a picture read keeps its bytes in the blob store. */
function turn(agent: string, index: number, blob: string | null): string {
	const timestamp = 1_760_000_000_000 + index * 4_000;
	const callId = `toolu_${agent}_${index}`;
	const assistant = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: words(160, index) },
			{ type: "toolCall", id: callId, name: "read", arguments: { path: `shots/${agent}-${index}.png` } },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: { input: 1200 + index, output: 380, cacheRead: 41_000, cacheWrite: 900, totalTokens: 43_480 },
		stopReason: "toolUse",
		timestamp,
	};
	const result = {
		role: "toolResult",
		toolCallId: callId,
		toolName: "read",
		content: blob
			? [
					{ type: "text", text: `Read image file [image/png]` },
					{ type: "image", data: blob, mimeType: "image/png" },
				]
			: [{ type: "text", text: words(180, index + 1) }],
		details: blob ? { mediaPath: `/work/shots/${agent}-${index}.png` } : { lines: 180, truncated: false },
		isError: false,
		timestamp: timestamp + 900,
	};
	return [assistant, result]
		.map((message, part) => JSON.stringify({ type: "message", id: `${agent}-${index}-${part}`, message }))
		.join("\n");
}

/** Writes each agent's journal up to `turns`, its pictures into the host's blob store. */
async function writeJournals(workDir: string, turns: number): Promise<void> {
	const journals = path.join(workDir, "subagents");
	const blobs = path.join(workDir, "blobs");
	await mkdir(journals, { recursive: true });
	await mkdir(blobs, { recursive: true });
	for (const [order, agent] of AGENTS.entries()) {
		const bytes = random(order + 1);
		const lines: string[] = [];
		for (let index = 0; index < turns; index++) {
			let ref: string | null = null;
			if (index % IMAGE_EVERY === IMAGE_EVERY - 1) {
				const image = picture(bytes, IMAGE_BYTES);
				const hash = createHash("sha256").update(image).digest("hex");
				await writeFile(path.join(blobs, hash), image);
				ref = `blob:sha256:${hash}`;
			}
			lines.push(turn(agent, index, ref));
		}
		await writeFile(path.join(journals, `${agent}.jsonl`), `${lines.join("\n")}\n`);
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

type Send = (command: RpcCommand) => Promise<RpcResponse>;
type ReadImage = (path: string) => Promise<IpcFsReadImageResult>;

/** How the device reaches the host: the tab's commands and the reply's picture reads. */
interface Device {
	send: Send;
	readImage: ReadImage;
}

function tabSend(session: Session): Send {
	return command => {
		const client = session.sidecar.rpcClient;
		if (!client) throw new Error("the device's tab has no client");
		return client.command(command);
	};
}

function directReadImage(session: Session): ReadImage {
	return file =>
		session.device.devices.request<IpcFsReadImageResult>(session.hostId, "fs.readImage", {
			path: file,
			rtab: "t1",
			cwd: session.workDir,
		});
}

interface Phase {
	name: string;
	sent: number;
	requests: number;
}

/** The scenario's minutes on one device; the bytes and requests the host answered in each phase. */
async function minutes(connect: (session: Session) => Device) {
	// The spy has to be in place before the link exists.
	const wire = countHostWire();
	const session = await openSession({ bridge: true });
	const device = connect(session);
	const shot = path.join(session.workDir, "shot.png");
	const shotBytes = random(99);
	await writeFile(shot, picture(shotBytes, SHOT_BYTES));
	await writeJournals(session.workDir, TURNS / 2);
	const phases: Phase[] = [];
	let transcripts = createSubagentTranscripts(device.send);
	const shown: string[] = [];
	const mountShot = async () => {
		const read = await device.readImage("shot.png");
		if (!read.ok || !read.dataUrl) throw new Error(read.error ?? "the picture did not load");
		shown.push(createHash("sha256").update(read.dataUrl).digest("hex"));
	};
	const phase = async (name: string, run: () => Promise<void>) => {
		wire.tx = 0;
		wire.requests = 0;
		const started = process.cpuUsage();
		await run();
		const cpu = process.cpuUsage(started);
		phases.push({ name, sent: wire.tx, requests: wire.requests });
		if (PRINT)
			console.log(
				`  ${name}: ${(wire.tx / 1000).toFixed(0)} KB in ${wire.requests} requests, ${((cpu.user + cpu.system) / 1000).toFixed(0)} ms CPU`,
			);
	};
	const settled = (id: string) => `completed:${id}`;
	const view = async (id: string, mark?: string) =>
		void (await transcripts.read(id, {
			sessionFile: path.join(session.workDir, "subagents", `${id}.jsonl`),
			settled: mark,
		}));
	await phase("running", async () => {
		for (const id of AGENTS) await transcripts.read(id);
		await view(AGENTS[0]);
		await mountShot();
		await mountShot();
	});
	await phase("completed", async () => {
		await writeJournals(session.workDir, TURNS);
		await view(AGENTS[0]);
		for (const id of AGENTS) await transcripts.read(id, { settled: settled(id) });
		await mountShot();
		await mountShot();
	});
	await phase("store reset", async () => {
		transcripts = createSubagentTranscripts(device.send);
		for (const id of AGENTS) await transcripts.read(id, { settled: settled(id) });
		await view(AGENTS[0], settled(AGENTS[0]));
		await mountShot();
		await mountShot();
	});
	await phase("relaunch", async () => {
		transcripts = createSubagentTranscripts(device.send);
		for (const id of AGENTS) await transcripts.read(id, { settled: settled(id) });
		await view(AGENTS[0], settled(AGENTS[0]));
		await mountShot();
		await mountShot();
	});
	await phase("picture changed", async () => {
		await writeFile(shot, picture(shotBytes, SHOT_BYTES));
		await mountShot();
		await mountShot();
	});
	const held = transcripts.held(AGENTS[0])?.messages ?? [];
	vi.restoreAllMocks();
	await closeSessions();
	return { phases, sent: phases.reduce((sum, p) => sum + p.sent, 0), held, shown };
}

const imageData = (messages: readonly AgentMessage[]) =>
	messages.flatMap(message =>
		message.role === "toolResult"
			? message.content.flatMap(block => (block.type === "image" ? [block.data] : []))
			: [],
	);

describe("pictures over the link", () => {
	it("a device viewing subagents that looked at pictures, and a reply's picture", async () => {
		if (PRINT) console.log("device:");
		const run = await minutes(session => ({ send: tabSend(session), readImage: directReadImage(session) }));
		if (PRINT) console.log(`  total: ${(run.sent / 1000).toFixed(0)} KB`);
		// The view shows the agent's whole transcript with every picture's bytes.
		expect(run.held).toHaveLength(TURNS * 2);
		const pictures = imageData(run.held);
		expect(pictures).toHaveLength(TURNS / IMAGE_EVERY);
		for (const data of pictures) expect(data.startsWith("blob:")).toBe(false);
		expect(new Set(run.shown).size).toBe(2);
	}, 120_000);
});
