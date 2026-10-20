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
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, describe, expect, it } from "vitest";
import { STALE_TODO_MESSAGE_TYPE } from "../../resources/gui-bridge/todo-stale-core";
import { newBridgeAddress, removeBridgeAddress } from "./bridge-client";

/**
 * A long session takes request after request and kept one finished task's todo list on the work board for hours:
 * stock reminds about a list only to finish it, never when a new request arrives. The bridge (todo-stale.ts) names a
 * stale list to the agent once, as a hidden message at the start of the turn a new request opens.
 *
 * 1. Installed omp, scripted provider, no spend: a finished list meets a new request (the reminder reaches the model in
 *    that turn's request), then a question (nothing new), then another request after a reminder (nothing new).
 * 2. Opt-in (`OMP_GUI_REAL_WORK=1`, `TODO_STALE_BEFORE_REF=<commit before the feature>`): the user's real `smol`
 *    model finishes a listed task, then gets two new requests and a question, on the bridge of that commit and on
 *    this one; prints `TODO_STALE_REAL` lines with the todo ops of each turn and whether a reminder came.
 */
const omp = join(homedir(), ".bun", "bin", "omp");

type Frame = {
	type: string;
	id?: string;
	toolName?: string;
	args?: { op?: string };
	message?: { role?: string; customType?: string };
	[key: string]: unknown;
};

function sse(chunks: unknown[], finish: string): string {
	const frame = (delta: unknown, reason: string | null = null) =>
		`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m1", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
	return `${frame({ role: "assistant", content: "" })}${chunks.map(chunk => frame(chunk)).join("")}${frame({}, finish)}data: [DONE]\n\n`;
}

function toolCall(name: string, args: Record<string, unknown>): unknown[] {
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

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup();
});

/** First prompt: a list, all of it done, an answer. Every later main request: a plain answer. */
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
					sse(toolCall("todo", { op: "init", list: [{ phase: "Sidebar bug", items: ["a", "b"] }] }), "tool_calls"),
				);
			else if (step === 2) res.end(sse(toolCall("todo", { op: "done", phase: "Sidebar bug" }), "tool_calls"));
			else res.end(sse([{ content: "DONE" }], "stop"));
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

interface Omp {
	frames: Frame[];
	send(command: Record<string, unknown>): Promise<Frame>;
	/** Sends a prompt and resolves with the frames of its turn once the session settled. */
	turn(message: string): Promise<Frame[]>;
	root: string;
}

async function startOmp(options: { agentDir: string; isolated: string; model: string; bridge: string }): Promise<Omp> {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "ompdesk-todo-stale-repo-")));
	execFileSync("git", ["init", "--quiet"], { cwd: root });
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const address = newBridgeAddress();
	const env: Record<string, string | undefined> = {
		...process.env,
		PI_CODING_AGENT_DIR: options.agentDir,
		PI_CONFIG_DIR: options.isolated,
		OMP_PROFILE: "",
		PI_PROFILE: "",
		OMP_GUI_BRIDGE: address,
	};
	for (const key of ["ELECTRON_RUN_AS_NODE", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_OAUTH_TOKEN"])
		Reflect.deleteProperty(env, key);
	for (const key of Object.keys(env))
		if (key.startsWith("OMP_GUI_") && key !== "OMP_GUI_BRIDGE") Reflect.deleteProperty(env, key);
	const child: ChildProcessWithoutNullStreams = spawn(
		omp,
		[
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

function reminders(frames: readonly Frame[]): number {
	return frames.filter(frame => frame.type === "message_end" && frame.message?.customType === STALE_TODO_MESSAGE_TYPE)
		.length;
}

function todoOps(frames: readonly Frame[]): string[] {
	return frames
		.filter(frame => frame.type === "tool_execution_start" && frame.toolName === "todo")
		.map(frame => frame.args?.op ?? "?");
}

describe.skipIf(!existsSync(omp))("a todo list left from earlier work, on stock omp", () => {
	it("is named to the model once, in the turn a new request opens, and never for a question", async () => {
		const provider = await startProvider();
		const isolated = mkdtempSync(join(tmpdir(), "ompdesk-todo-stale-"));
		chmodSync(isolated, 0o700);
		cleanups.push(() => rmSync(isolated, { recursive: true, force: true }));
		const agentDir = join(isolated, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "models.yml"),
			`providers:\n  fake:\n    baseUrl: ${provider.url}\n    apiKey: x\n    api: openai-completions\n    models:\n      - id: m1\n        name: m1\n        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }\n`,
		);
		const session = await startOmp({
			agentDir,
			isolated,
			model: "fake/m1",
			bridge: resolve("resources/gui-bridge/index.ts"),
		});
		const first = await session.turn("Fix the sidebar bug and add a test for it");
		expect(todoOps(first)).toEqual(["init", "done"]);
		expect(reminders(first)).toBe(0);

		const request = await session.turn("Add a Korean label to the export button and a test for it");
		expect(reminders(request)).toBe(1);
		const sent = provider.bodies.at(-1) ?? "";
		expect(sent).toContain('Your todo list (\\"Sidebar bug\\", 2/2 done) is finished');
		// After the person's prompt: the cached prefix in front of it stays as it was.
		expect(sent.indexOf("is finished")).toBeGreaterThan(sent.indexOf("Add a Korean label"));

		const question = await session.turn("why did the build fail?");
		expect(reminders(question)).toBe(0);
		const again = await session.turn("Rename the export button to Download in every locale");
		expect(reminders(again)).toBe(0);
	}, 180_000);
});

const real =
	process.env.OMP_GUI_REAL_WORK === "1" && process.env.TODO_STALE_BEFORE_REF !== undefined && existsSync(omp);
const RUNS = Number(process.env.TODO_STALE_REAL_RUNS ?? 2);

/** The user's config and credentials copied into a private agent dir (never touched); the main model is `smol`. */
function realAgent(): { agentDir: string; isolated: string; smol: string } {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-todo-stale-real-"));
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
	execFileSync("sqlite3", [
		join(homedir(), ".omp/agent/agent.db"),
		`VACUUM INTO '${join(agentDir, "agent.db").replaceAll("'", "''")}'`,
	]);
	return { agentDir, isolated, smol };
}

/** The bridge as it was at `ref`, extracted beside a copy of `src/shared` its type imports name. */
function bridgeAt(ref: string): string {
	const dir = mkdtempSync(join(tmpdir(), "ompdesk-todo-stale-before-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const archive = execFileSync("git", ["archive", ref, "resources/gui-bridge", "src/shared"], { maxBuffer: 1 << 28 });
	execFileSync("tar", ["-x", "-C", dir], { input: archive });
	return join(dir, "resources/gui-bridge/index.ts");
}

const SCRIPT = [
	{
		kind: "task",
		text: "Create notes.md with three bullet points about Bun, then count.txt holding the number 3. Track the two steps in your todo list and mark each done.",
	},
	{
		kind: "request",
		text: "Now add hello.ts exporting greet(name) that returns 'Hello, ' + name, and hello.test.ts with one bun test for it. Run the test.",
	},
	{ kind: "question", text: "What does greet return for an empty name?" },
	{ kind: "request", text: "Rename greet to welcome in hello.ts and hello.test.ts and run the test again." },
] as const;

describe.skipIf(!real)("a todo list left from earlier work, on the user's real smol model", () => {
	it("is replaced or updated on the first new request", async () => {
		const results: Array<Record<string, unknown>> = [];
		for (let run = 0; run < RUNS; run++)
			for (const [variant, bridge] of [
				["before", bridgeAt(process.env.TODO_STALE_BEFORE_REF ?? "")],
				["after", resolve("resources/gui-bridge/index.ts")],
			] as const) {
				const { agentDir, isolated, smol } = realAgent();
				const session = await startOmp({ agentDir, isolated, model: smol, bridge });
				const turns: Array<{ kind: string; ops: string[]; reminder: number }> = [];
				for (const step of SCRIPT) {
					const frames = await session.turn(step.text);
					turns.push({ kind: step.kind, ops: todoOps(frames), reminder: reminders(frames) });
				}
				const line = { run, variant, model: smol, turns };
				results.push(line);
				console.log(`TODO_STALE_REAL=${JSON.stringify(line)}`);
			}
		for (const line of results)
			if (line.variant === "after")
				for (const turn of line.turns as Array<{ kind: string; reminder: number }>)
					if (turn.kind === "question") expect(turn.reminder).toBe(0);
	}, 3_600_000);
});
