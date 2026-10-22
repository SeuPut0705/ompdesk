import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentMessage, AgentSessionEvent } from "../../shared/rpc-types";
import { withoutFrameBookkeeping } from "../frame-bookkeeping";
import { completeRunMessages } from "../run-messages";
import { createLinkEventDecoder, createLinkEventEncoder } from "./link-events";

/**
 * One run of the installed omp (a scripted loopback provider: a reply that reads a file, then the answer) through what
 * the sidecar does to its frames and the link's encoder and decoder: every message of its `agent_end` crosses as a
 * reference (`slimEndFields`), and the device rebuilds them exactly. Stock stamps a reply's `completedAt` only after its
 * `message_end` (omp 18.12.6), so before that capability no reply of a run matched and each crossed whole twice.
 */
const omp = join(homedir(), ".bun", "bin", "omp");

/** The bridge's `decorateMessages` (stream-metadata.ts, which imports omp's own modules): a read call's group target. */
function decorateMessages(messages: AgentMessage[]): AgentMessage[] {
	return messages.map(message => {
		if (!Array.isArray(message.content)) return message;
		return {
			...message,
			content: message.content.map(block =>
				block.type === "toolCall" && block.name === "read"
					? { ...block, arguments: { ...block.arguments, __ompReadGroup: "f.txt" } }
					: block,
			),
		} as AgentMessage;
	});
}
type Frame = Record<string, unknown> & { type: string; id?: string };

function sse(chunks: unknown[], finish: string): string {
	const frame = (delta: unknown, reason: string | null = null) =>
		`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m1", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
	return `${frame({ role: "assistant", content: "" })}${chunks.map(chunk => frame(chunk)).join("")}${frame({}, finish)}data: [DONE]\n\n`;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup();
});

async function startProvider(): Promise<string> {
	let step = 0;
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", chunk => {
			body += chunk;
		});
		req.on("end", () => {
			const parsed = JSON.parse(body || "{}") as { tools?: Array<{ function?: { name?: string } }> };
			const main = (parsed.tools ?? []).some(tool => tool.function?.name === "read");
			res.writeHead(200, { "content-type": "text/event-stream" });
			if (!main) return res.end(sse([{ content: "side" }], "stop"));
			step++;
			if (step === 1)
				return res.end(
					sse(
						[
							{ content: "Reading it." },
							{
								tool_calls: [
									{
										index: 0,
										id: "call_r",
										type: "function",
										function: { name: "read", arguments: JSON.stringify({ path: "f.txt" }) },
									},
								],
							},
						],
						"tool_calls",
					),
				);
			res.end(sse([{ content: "DONE" }], "stop"));
		});
	});
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
	cleanups.push(() => {
		server.closeAllConnections();
		return new Promise<void>(done => server.close(() => done()));
	});
	return `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
}

async function run(url: string): Promise<Frame[]> {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-link-events-"));
	chmodSync(isolated, 0o700);
	const root = realpathSync(mkdtempSync(join(tmpdir(), "ompdesk-link-events-repo-")));
	writeFileSync(join(root, "f.txt"), "content\n");
	cleanups.push(() => {
		rmSync(isolated, { recursive: true, force: true });
		rmSync(root, { recursive: true, force: true });
	});
	const agentDir = join(isolated, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "models.yml"),
		`providers:\n  fake:\n    baseUrl: ${url}\n    apiKey: x\n    api: openai-completions\n    models:\n      - id: m1\n        name: m1\n        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }\n`,
	);
	const env: Record<string, string | undefined> = {
		...process.env,
		PI_CODING_AGENT_DIR: agentDir,
		PI_CONFIG_DIR: isolated,
		OMP_PROFILE: "",
		PI_PROFILE: "",
	};
	for (const key of ["ELECTRON_RUN_AS_NODE", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OMP_GUI_BRIDGE"])
		Reflect.deleteProperty(env, key);
	const child: ChildProcessWithoutNullStreams = spawn(
		omp,
		["--mode", "rpc-ui", "--no-extensions", "--no-skills", "--no-rules", "--model", "fake/m1"],
		{ cwd: root, env: env as NodeJS.ProcessEnv },
	);
	const exited = new Promise<void>(done => child.once("exit", () => done()));
	cleanups.push(async () => {
		child.stdin.end();
		const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
		await exited;
		clearTimeout(timer);
	});
	const frames: Frame[] = [];
	createInterface({ input: child.stdout }).on("line", line => {
		try {
			frames.push(JSON.parse(line) as Frame);
		} catch {
			// not a frame
		}
	});
	await expect.poll(() => frames.some(frame => frame.type === "ready"), { timeout: 60_000 }).toBe(true);
	child.stdin.write(`${JSON.stringify({ id: "p1", type: "prompt", message: "read f.txt" })}\n`);
	await expect
		.poll(() => frames.some(frame => frame.type === "agent_end" && frame.isTerminal !== false), { timeout: 30_000 })
		.toBe(true);
	return frames;
}

describe.skipIf(!existsSync(omp))("a run of the installed omp over a slim link", () => {
	it("sends every message of its agent_end as a reference to the message_end that carried it", async () => {
		const frames = await run(await startProvider());
		// What the sidecar does before the link sees a frame (sidecar.ts #routeFrame, then the bridge's
		// sessions.attach_entry_ids, which decorates read calls and crosses a JSON socket).
		const delivered: AgentMessage[] = [];
		const events: AgentSessionEvent[] = [];
		for (const raw of frames) {
			const frame = withoutFrameBookkeeping(raw);
			if (frame.type === "message_end") delivered.push(frame.message as AgentMessage);
			if (frame.type === "agent_end") {
				const messages = completeRunMessages(delivered, frame.messages as AgentMessage[]);
				events.push({
					...frame,
					messages: JSON.parse(JSON.stringify(decorateMessages(messages as AgentMessage[]))),
				} as unknown as AgentSessionEvent);
				continue;
			}
			if (["message_start", "message_update", "message_end", "tool_execution_end"].includes(frame.type))
				events.push(frame as unknown as AgentSessionEvent);
		}
		const original = events.find(event => event.type === "agent_end") as { messages: AgentMessage[] };
		expect(original.messages.some(message => message.role === "assistant")).toBe(true);
		const decoder = createLinkEventDecoder();
		const crossed = (fields: boolean) => {
			const encoder = createLinkEventEncoder({ ends: true, readGroups: true, toolResults: true, endFields: fields });
			return events.flatMap(event => encoder.events([event]));
		};
		const sent = crossed(true);
		const end = sent.find(event => event.type === "agent_end") as { messages: Array<Record<string, unknown>> };
		// Stock stamps a reply's completedAt after its message_end: the reference carries it, nothing crosses whole.
		expect(end.messages.filter(message => !("~sent" in message))).toEqual([]);
		expect(JSON.stringify(end).length * 3).toBeLessThan(
			JSON.stringify(crossed(false).find(event => event.type === "agent_end")).length,
		);
		// The device rebuilds the very messages the host's pool delivered.
		const rebuilt = JSON.parse(JSON.stringify(sent)).flatMap((event: AgentSessionEvent) => decoder.events([event]));
		expect(rebuilt.find((event: AgentSessionEvent) => event.type === "agent_end").messages).toEqual(original.messages);
	}, 120_000);
});
