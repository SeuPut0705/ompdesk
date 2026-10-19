/**
 * Memory recall's hook (resources/gui-bridge/modes/memory-recall.ts) on a fake `pi` against a real local HTTP server
 * standing in for ai-memory's `/mcp`: the request it sends (stateless JSON `tools/call memory_query`, the root token,
 * the session coordinate, `conclusions: true`), the message it returns, and every quiet path (no state file, memory
 * off, a subagent or another agent's prompt, an Autopilot run, the server down, slow or erroring, nothing relevant).
 * The rules themselves: bridge-memory-recall-core.test.ts.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTOPILOT_STATE_ENTRY } from "../../resources/gui-bridge/modes/autopilot-contracts";
import { setJudgeAssistStockLoader } from "../../resources/gui-bridge/modes/judge-assist-engine";
import { install } from "../../resources/gui-bridge/modes/memory-recall";
import {
	MEMORY_ENV,
	MEMORY_RECALL_MESSAGE_TYPE,
	RECALL_TIMEOUT_MS,
} from "../../resources/gui-bridge/modes/memory-recall-contracts";

type Hook = (event: { prompt: string }, ctx: unknown) => Promise<unknown>;

const ANSWER = {
	hits: [
		{
			path: "decisions/remote-sharing.md",
			title: "원격 기기 공유는 테일스케일 신원 기반으로",
			snippet: "<mark>테일스케일</mark> 신원으로만 연결하고 <mark>페어링</mark> 코드는 제거한다",
		},
	],
	conclusion_hits: [],
};

let dir: string;
let server: Server;
let url: string;
let requests: { headers: IncomingMessage["headers"]; body: unknown }[];
let reply: (body: unknown) => { status: number; body: unknown; delayMs?: number };

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "memory-recall-"));
	await mkdir(join(dir, "data", "auth-tokens"), { recursive: true });
	await writeFile(join(dir, "data", "auth-tokens", "default"), "root-token\n");
	requests = [];
	reply = () => ({
		status: 200,
		body: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(ANSWER) }] } },
	});
	server = createServer((req, res) => {
		let raw = "";
		req.on("data", chunk => {
			raw += chunk;
		});
		req.on("end", () => {
			const body = JSON.parse(raw || "null");
			requests.push({ headers: req.headers, body });
			const { status, body: out, delayMs } = reply(body);
			const answer = () => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(out));
			};
			// A real delay on purpose: the budget under test is the hook's own AbortSignal.timeout on a real socket.
			if (delayMs) setTimeout(answer, delayMs);
			else answer();
		});
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", listening.resolve);
	await listening.promise;
	const address: AddressInfo | string | null = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	url = `http://127.0.0.1:${address.port}`;
	await writeFile(join(dir, "recall.json"), JSON.stringify({ url, dataDir: join(dir, "data") }));
	process.env[MEMORY_ENV] = join(dir, "recall.json");
	setJudgeAssistStockLoader(undefined);
});

afterEach(async () => {
	delete process.env[MEMORY_ENV];
	server.closeAllConnections();
	const closed = Promise.withResolvers<void>();
	server.close(() => closed.resolve());
	await closed.promise;
	await rm(dir, { recursive: true, force: true });
});

function hook(): Hook {
	let registered: Hook | undefined;
	const pi = {
		on: (event: string, handler: Hook) => {
			if (event === "before_agent_start") registered = handler;
		},
		logger: { debug: () => {} },
		pi: { MAIN_AGENT_ID: "main", AgentRegistry: { global: () => ({ get: () => undefined }) } },
	};
	install(pi as never);
	if (!registered) throw new Error("no before_agent_start hook");
	return registered;
}

function ctx(kind = "main", branch: unknown[] = []) {
	return { agent: { kind }, sessionManager: { getSessionId: () => "omp-session-1", getBranch: () => branch } };
}

const PROMPT = "기기연결은 테일스케일로만 하고 페어링코드는 삭제했잖아?";

describe("memory recall hook", () => {
	it("asks memory_query for the session's project and returns one quiet message", async () => {
		const result = await hook()({ prompt: PROMPT }, ctx());
		expect(requests).toHaveLength(1);
		const [request] = requests;
		expect(request.headers.authorization).toBe("Bearer root-token");
		expect(request.headers["x-memory-actor-session-id"]).toBe("omp-session-1");
		expect(request.body).toMatchObject({
			method: "tools/call",
			params: {
				name: "memory_query",
				arguments: { limit: 8, conclusions: true, query: expect.stringContaining("테일스케일") },
			},
		});
		expect(request.body).not.toHaveProperty("params.arguments.workspace");
		expect(result).toMatchObject({
			message: {
				customType: MEMORY_RECALL_MESSAGE_TYPE,
				display: true,
				attribution: "agent",
				content: expect.stringContaining("<memory-recall>"),
				details: { v: 1, judged: false, items: [{ kind: "decision", path: "decisions/remote-sharing.md" }] },
			},
		});
	});

	it("asks nothing for a subagent, another agent's message, a greeting or an Autopilot run", async () => {
		const run = hook();
		expect(await run({ prompt: PROMPT }, ctx("sub"))).toBeUndefined();
		expect(
			await run({ prompt: `<ompdesk-agent-message from="x">\n${PROMPT}\n</ompdesk-agent-message>` }, ctx()),
		).toBeUndefined();
		expect(await run({ prompt: "안녕" }, ctx())).toBeUndefined();
		const armed = [{ type: "custom", customType: AUTOPILOT_STATE_ENTRY, data: { state: "running" } }];
		expect(await run({ prompt: PROMPT }, ctx("main", armed))).toBeUndefined();
		expect(requests).toEqual([]);
	});

	it("does nothing while memory is off (no state file) and installs nothing without the env", async () => {
		const run = hook();
		await rm(join(dir, "recall.json"));
		expect(await run({ prompt: PROMPT }, ctx())).toBeUndefined();
		delete process.env[MEMORY_ENV];
		expect(() => hook()).toThrow("no before_agent_start hook");
		expect(requests).toEqual([]);
	});

	it("goes on quietly when the server errors, refuses the tool, or is slower than the budget", async () => {
		const run = hook();
		reply = () => ({ status: 500, body: {} });
		expect(await run({ prompt: PROMPT }, ctx())).toBeUndefined();
		reply = () => ({ status: 200, body: { jsonrpc: "2.0", id: 1, error: { message: "unknown tool" } } });
		expect(await run({ prompt: PROMPT }, ctx())).toBeUndefined();
		reply = () => ({
			status: 200,
			body: { jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "bad" }] } },
		});
		expect(await run({ prompt: PROMPT }, ctx())).toBeUndefined();
		reply = () => ({
			status: 200,
			body: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(ANSWER) }] } },
			delayMs: RECALL_TIMEOUT_MS + 200,
		});
		const started = Date.now();
		expect(await run({ prompt: PROMPT }, ctx())).toBeUndefined();
		expect(Date.now() - started).toBeLessThan(RECALL_TIMEOUT_MS + 150);
	});

	it("returns no message when nothing found bears on the prompt", async () => {
		expect(await hook()({ prompt: "로그인 화면 버튼 색을 파랗게 바꿔줘" }, ctx())).toBeUndefined();
		expect(requests).toHaveLength(1);
	});
});
