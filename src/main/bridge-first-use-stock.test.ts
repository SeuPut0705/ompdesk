import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, describe, expect, it } from "vitest";
import { replyLanguageInstruction } from "../../resources/gui-bridge/modes/reply-language";
import { newBridgeAddress, removeBridgeAddress } from "./bridge-client";

/**
 * The bridge's area modules load at its first use (index.ts `guiBridge`), not while omp starts: loading them in the
 * factory delayed stock's `ready` by 69 ms and held 14 MB more per omp. A prompt can be that first use (an agent's
 * or a test's prompt sent right at `ready`, before main connected): it must still carry the hooks the areas install,
 * here the reply-language prompt section. Installed omp, scripted provider, no spend; nothing connects to the bridge.
 */
const omp = join(homedir(), ".bun", "bin", "omp");

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
	for (const cleanup of cleanups.reverse()) await cleanup();
});

function sse(text: string): string {
	const frame = (delta: unknown, reason: string | null = null) =>
		`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m1", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
	return `${frame({ role: "assistant", content: "" })}${frame({ content: text })}${frame({}, "stop")}data: [DONE]\n\n`;
}

/** Answers every request with one line; keeps the main agent's request bodies (the ones offering tools). */
async function startProvider(): Promise<{ url: string; bodies: string[] }> {
	const bodies: string[] = [];
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", chunk => {
			body += chunk;
		});
		req.on("end", () => {
			const parsed = JSON.parse(body || "{}") as { tools?: unknown[] };
			if ((parsed.tools ?? []).length > 0) bodies.push(body);
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(sse("DONE"));
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

describe.skipIf(!existsSync(omp))("the bridge's first use, on stock omp", () => {
	it("gives a prompt sent at `ready`, before anything connected, the areas' prompt sections", async () => {
		const provider = await startProvider();
		const isolated = mkdtempSync(join(tmpdir(), "ompdesk-bridge-first-use-"));
		chmodSync(isolated, 0o700);
		cleanups.push(() => rmSync(isolated, { recursive: true, force: true }));
		const agentDir = join(isolated, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "models.yml"),
			`providers:\n  fake:\n    baseUrl: ${provider.url}\n    apiKey: x\n    api: openai-completions\n    models:\n      - id: m1\n        name: m1\n        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }\n`,
		);
		const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ompdesk-bridge-first-use-cwd-")));
		cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
		const address = newBridgeAddress();
		const env: Record<string, string | undefined> = {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			PI_CONFIG_DIR: isolated,
			OMP_PROFILE: "",
			PI_PROFILE: "",
		};
		for (const key of ["ELECTRON_RUN_AS_NODE", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_OAUTH_TOKEN"])
			Reflect.deleteProperty(env, key);
		for (const key of Object.keys(env)) if (key.startsWith("OMP_GUI_")) Reflect.deleteProperty(env, key);
		env.OMP_GUI_BRIDGE = address;
		env.OMP_GUI_REPLY_LANGUAGE = "Korean";
		const child = spawn(
			omp,
			[
				"--mode",
				"rpc-ui",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-rules",
				"--model",
				"fake/m1",
				"-e",
				resolve("resources/gui-bridge/index.ts"),
			],
			{ cwd, env: env as NodeJS.ProcessEnv },
		);
		let stderr = "";
		child.stderr.on("data", chunk => {
			stderr += chunk;
		});
		const exited = Promise.withResolvers<void>();
		child.once("exit", () => exited.resolve());
		cleanups.push(async () => {
			child.stdin.end();
			const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
			await exited.promise;
			clearTimeout(timer);
			removeBridgeAddress(address);
		});
		const settled = Promise.withResolvers<void>();
		createInterface({ input: child.stdout }).on("line", line => {
			let frame: { type?: string };
			try {
				frame = JSON.parse(line) as { type?: string };
			} catch {
				return;
			}
			// The prompt goes out in the same tick as `ready`: nothing has connected to the bridge yet.
			if (frame.type === "ready")
				child.stdin.write(`${JSON.stringify({ id: "p", type: "prompt", message: "hi" })}\n`);
			if (frame.type === "session_settled") settled.resolve();
		});
		const timeout = setTimeout(() => settled.reject(new Error(`no settled turn: ${stderr.slice(-2000)}`)), 120_000);
		await settled.promise;
		clearTimeout(timeout);

		expect(provider.bodies.length).toBeGreaterThan(0);
		const request = JSON.parse(provider.bodies[0]) as { messages: Array<{ role: string; content: unknown }> };
		const system = request.messages
			.filter(message => message.role === "system" || message.role === "developer")
			.map(message => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
			.join("\n");
		const instruction = replyLanguageInstruction("Korean");
		expect(instruction).toBeDefined();
		expect(system).toContain(instruction);
	}, 180_000);
});
