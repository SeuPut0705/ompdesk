import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, describe, expect, it } from "vitest";
import { newBridgeAddress, removeBridgeAddress } from "./bridge-client";

/**
 * A `todo` call that fails inside a turn (GPT-6.1's `op: "append"` without a phase) makes stock queue its
 * `todo-error-reminder` with `deliverAs: "nextTurn"`. On the installed omp (18.12.3) that hidden message waits for
 * the next explicit prompt while `queuedMessageCount` counts it, so `isRpcSessionSettled` stays false, stock never
 * sends `session_settled` and OMPdesk's tab reads running after its answer (11 of 11 such stuck runs followed a todo
 * error). The bridge (todo-reminder.ts) delivers that one reminder as an aside of the live turn instead: the model
 * reads it at the next step, and the session settles when the turn ends.
 */
const omp = join(homedir(), ".bun", "bin", "omp");

type Frame = { type: string; id?: string; message?: { role?: string; customType?: string }; [key: string]: unknown };

function sse(chunks: unknown[], finish: string): string {
	const frame = (delta: unknown, reason: string | null = null) =>
		`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m1", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
	return `${frame({ role: "assistant", content: "" })}${chunks.map(chunk => frame(chunk)).join("")}${frame({}, finish)}data: [DONE]\n\n`;
}

function toolCalls(calls: Array<{ name: string; args: Record<string, unknown> }>): unknown[] {
	return calls.map((call, index) => ({
		tool_calls: [
			{
				index,
				id: `call_${index}_${Math.random().toString(36).slice(2, 8)}`,
				type: "function",
				function: { name: call.name, arguments: JSON.stringify(call.args) },
			},
		],
	}));
}

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup();
});

/** Main-agent requests in order: a valid todo list, then a refused append beside a read, then the repaired append, then the answer. */
async function startProvider(): Promise<{ url: string; bodies: string[] }> {
	const bodies: string[] = [];
	let step = 0;
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", chunk => {
			body += chunk;
		});
		req.on("end", () => {
			const parsed = JSON.parse(body || "{}") as { tools?: Array<{ function?: { name?: string } }> };
			const main = (parsed.tools ?? []).some(tool => tool.function?.name === "todo");
			res.writeHead(200, { "content-type": "text/event-stream" });
			if (!main) {
				res.end(sse([{ content: "side" }], "stop"));
				return;
			}
			bodies.push(body);
			step++;
			if (step === 1)
				res.end(
					sse(
						toolCalls([{ name: "todo", args: { op: "init", list: [{ phase: "Work", items: ["a", "b"] }] } }]),
						"tool_calls",
					),
				);
			else if (step === 2)
				res.end(
					sse(
						toolCalls([
							{ name: "todo", args: { op: "append", items: ["c"] } },
							{ name: "read", args: { path: "f.txt" } },
						]),
						"tool_calls",
					),
				);
			else if (step === 3)
				res.end(
					sse(toolCalls([{ name: "todo", args: { op: "append", phase: "Work", items: ["c"] } }]), "tool_calls"),
				);
			else res.end(sse([{ content: "DONE" }], "stop"));
		});
	});
	await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
	cleanups.push(() => {
		server.closeAllConnections();
		return new Promise<void>(done => server.close(() => done()));
	});
	return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, bodies };
}

async function startOmp(
	url: string,
): Promise<{ frames: Frame[]; send(command: Record<string, unknown>): Promise<Frame> }> {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-todo-reminder-"));
	chmodSync(isolated, 0o700);
	const root = realpathSync(mkdtempSync(join(tmpdir(), "ompdesk-todo-reminder-repo-")));
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
	const address = newBridgeAddress();
	const env: Record<string, string | undefined> = {
		...process.env,
		PI_CODING_AGENT_DIR: agentDir,
		PI_CONFIG_DIR: isolated,
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_BRIDGE: address,
	};
	for (const key of ["ELECTRON_RUN_AS_NODE", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_OAUTH_TOKEN"])
		Reflect.deleteProperty(env, key);
	const child: ChildProcessWithoutNullStreams = spawn(
		omp,
		[
			"--mode",
			"rpc-ui",
			"--no-extensions",
			"--no-skills",
			"--no-rules",
			"--model",
			"fake/m1",
			"-e",
			resolve("resources/gui-bridge/index.ts"),
		],
		{ cwd: root, env: env as NodeJS.ProcessEnv },
	);
	let stderr = "";
	child.stderr.on("data", chunk => {
		stderr += chunk;
	});
	const exited = new Promise<void>(done => child.once("exit", () => done()));
	cleanups.push(async () => {
		child.stdin.end();
		const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
		await exited;
		clearTimeout(timer);
		removeBridgeAddress(address);
	});
	const frames: Frame[] = [];
	const responses = new Map<string, (frame: Frame) => void>();
	createInterface({ input: child.stdout }).on("line", line => {
		try {
			const frame = JSON.parse(line) as Frame;
			if (frame.type === "response" && frame.id && responses.has(frame.id)) responses.get(frame.id)?.(frame);
			else frames.push(frame);
		} catch {
			// not a frame
		}
	});
	await expect
		.poll(() => frames.some(frame => frame.type === "ready"), { timeout: 60_000, message: stderr })
		.toBe(true);
	let counter = 0;
	return {
		frames,
		send: command =>
			new Promise<Frame>(done => {
				const id = `c${++counter}`;
				responses.set(id, done);
				child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
			}),
	};
}

describe.skipIf(!existsSync(omp))("a todo call refused inside a turn on stock omp", () => {
	it("reaches the model as an aside of that turn, and the session settles when the turn ends", async () => {
		const provider = await startProvider();
		const { frames, send } = await startOmp(provider.url);
		await send({ type: "prompt", message: "work through the list" });
		await expect
			.poll(() => frames.some(frame => frame.type === "agent_end" && frame.isTerminal !== false), {
				timeout: 30_000,
			})
			.toBe(true);
		// Stock's reminder came in the same turn: the request after the refused append carries it.
		expect(provider.bodies[2]).toContain("todo failed");
		expect(
			frames.some(frame => frame.type === "message_end" && frame.message?.customType === "todo-error-reminder"),
		).toBe(true);
		await expect.poll(() => frames.some(frame => frame.type === "session_settled"), { timeout: 10_000 }).toBe(true);
		const state = (await send({ type: "get_state" })) as Frame & {
			data?: { isSettled?: boolean; queuedMessageCount?: number };
		};
		expect(state.data).toMatchObject({ isSettled: true, queuedMessageCount: 0 });
	}, 120_000);
});
