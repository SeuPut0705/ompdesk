/**
 * Shared world of the todo rules' stock tests (bridge-todo-stale-stock.test.ts, bridge-todo-compact-stock.test.ts):
 * the installed omp in `--mode rpc-ui` with the bridge, a scripted OpenAI-style provider, and for the opt-in real
 * runs the user's config copied into a private agent dir. Every process and folder it makes is released by the
 * importing file's `afterAll`.
 */
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as http from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { afterAll, expect } from "vitest";
import { newBridgeAddress, removeBridgeAddress } from "./bridge-client";
import { configDirName, OMP_COMMAND } from "./test-bridge-probe";
import { RM_TEMP } from "./test-fake-omp";

export type Frame = {
	type: string;
	id?: string;
	toolName?: string;
	args?: { op?: string };
	result?: {
		details?: { op?: string; phases?: Array<{ name: string; tasks: Array<{ content: string; status: string }> }> };
	};
	isError?: boolean;
	message?: { role?: string; customType?: string };
	[key: string]: unknown;
};

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup();
});

export function onCleanup(cleanup: () => Promise<void> | void): void {
	cleanups.push(cleanup);
}

export function sse(chunks: unknown[], finish: string): string {
	const frame = (delta: unknown, reason: string | null = null) =>
		`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m1", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
	return `${frame({ role: "assistant", content: "" })}${chunks.map(chunk => frame(chunk)).join("")}${frame({}, finish)}data: [DONE]\n\n`;
}

export function toolCall(name: string, args: Record<string, unknown>): unknown[] {
	return [
		{
			tool_calls: [
				{
					index: 0,
					id: `call_${name}_${Math.random().toString(36).slice(2)}`,
					type: "function",
					function: { name, arguments: JSON.stringify(args) },
				},
			],
		},
	];
}

/**
 * A scripted provider: `reply(step)` answers the main agent's `step`th request (1-based) with an SSE body; requests
 * without the `todo` tool (side models) get a plain answer and are not counted.
 */
export async function startProvider(reply: (step: number) => string): Promise<{ url: string; bodies: string[] }> {
	const bodies: string[] = [];
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
			res.end(reply(bodies.length));
		});
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	cleanups.push(() => {
		server.closeAllConnections();
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		return closed.promise;
	});
	return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, bodies };
}

/** A private agent dir whose only model is the scripted provider's `fake/m1`. */
export function fakeAgent(url: string): { agentDir: string; isolated: string } {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-todo-stock-"));
	chmodSync(isolated, 0o700);
	cleanups.push(() => rmSync(isolated, { recursive: true, force: true }));
	const agentDir = join(isolated, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "models.yml"),
		`providers:\n  fake:\n    baseUrl: ${url}\n    apiKey: x\n    api: openai-completions\n    models:\n      - id: m1\n        name: m1\n        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }\n`,
	);
	return { agentDir, isolated };
}

/** The user's config and credentials copied into a private agent dir (never touched); the main model is `smol`. */
export function realAgent(): { agentDir: string; isolated: string; smol: string } {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-todo-stock-real-"));
	chmodSync(isolated, 0o700);
	cleanups.push(() => rmSync(isolated, { recursive: true, force: true }));
	const agentDir = join(isolated, "agent");
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	const config = readFileSync(join(homedir(), ".omp/agent/config.yml"), "utf8");
	const smol = /^ {2}smol:\s*(\S+)\s*$/m.exec(config)?.[1];
	if (!smol) throw new Error("config.yml has no modelRoles.smol");
	writeFileSync(join(agentDir, "config.yml"), config);
	const models = join(homedir(), ".omp/agent/models.yml");
	if (existsSync(models)) writeFileSync(join(agentDir, "models.yml"), readFileSync(models));
	const db = new DatabaseSync(join(homedir(), ".omp/agent/agent.db"), { readOnly: true });
	try {
		db.exec(`VACUUM INTO '${join(agentDir, "agent.db").replaceAll("'", "''")}'`);
	} finally {
		db.close();
	}
	return { agentDir, isolated, smol };
}

/** The bridge as it was at `ref`, extracted beside a copy of `src/shared` its type imports name. */
export function bridgeAt(ref: string): string {
	const dir = mkdtempSync(join(tmpdir(), "ompdesk-todo-stock-before-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const archive = execFileSync("git", ["archive", ref, "resources/gui-bridge", "src/shared"], { maxBuffer: 1 << 28 });
	execFileSync("tar", ["-x", "-C", dir], { input: archive });
	return join(dir, "resources/gui-bridge/index.ts");
}

export interface Omp {
	frames: Frame[];
	send(command: Record<string, unknown>): Promise<Frame>;
	/** Sends a prompt and resolves with the frames of its turn once the session settled. */
	turn(message: string): Promise<Frame[]>;
	root: string;
}

export async function startOmp(options: {
	agentDir: string;
	isolated: string;
	model: string;
	bridge: string;
}): Promise<Omp> {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "ompdesk-todo-stock-repo-")));
	execFileSync("git", ["init", "--quiet"], { cwd: root });
	// Windows: the omp under the launcher (and what it started) keeps this folder open a moment past the launcher's exit.
	cleanups.push(() => rmSync(root, RM_TEMP));
	const address = newBridgeAddress();
	const env: Record<string, string | undefined> = {
		...process.env,
		PI_CODING_AGENT_DIR: options.agentDir,
		// Stock joins it to the home folder (pi-utils dirs.ts `getConfigDirName`): an absolute path would land under home.
		PI_CONFIG_DIR: configDirName(options.isolated),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_BRIDGE: address,
	};
	for (const key of ["ELECTRON_RUN_AS_NODE", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_OAUTH_TOKEN"])
		Reflect.deleteProperty(env, key);
	for (const key of Object.keys(env))
		if (key.startsWith("OMP_GUI_") && key !== "OMP_GUI_BRIDGE") Reflect.deleteProperty(env, key);
	const child: ChildProcessWithoutNullStreams = spawn(
		OMP_COMMAND.file,
		[
			...OMP_COMMAND.args,
			"--mode",
			"rpc-ui",
			"--no-extensions",
			"--no-skills",
			"--no-rules",
			"--model",
			options.model,
			"-e",
			options.bridge,
		],
		{ cwd: root, env: env as NodeJS.ProcessEnv },
	);
	let stderr = "";
	child.stderr.on("data", chunk => {
		stderr += chunk;
	});
	const exited = Promise.withResolvers<void>();
	child.once("exit", () => exited.resolve());
	cleanups.push(async () => {
		child.stdin.end();
		// A real omp exits on stdin EOF; SIGKILL only if it does not.
		const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
		await exited.promise;
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
	const send = (command: Record<string, unknown>) => {
		const answered = Promise.withResolvers<Frame>();
		const id = `c${++counter}`;
		responses.set(id, answered.resolve);
		child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
		return answered.promise;
	};
	const turn = async (message: string) => {
		const from = frames.length;
		await send({ type: "prompt", message });
		await expect
			.poll(() => frames.slice(from).some(frame => frame.type === "session_settled"), { timeout: 300_000 })
			.toBe(true);
		return frames.slice(from);
	};
	return { frames, send, turn, root };
}

export function todoOps(frames: readonly Frame[]): string[] {
	return frames
		.filter(frame => frame.type === "tool_execution_start" && frame.toolName === "todo")
		.map(frame => frame.args?.op ?? "?");
}
