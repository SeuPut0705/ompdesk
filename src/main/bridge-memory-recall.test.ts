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
/** How the fake server resolved `memory_status` for the session (ai-memory's `resolved_by`). */
let resolvedBy: string;

const toolResult = (value: unknown) => ({
	status: 200,
	body: { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(value) }] } },
});

const toolName = (body: unknown): unknown =>
	body && typeof body === "object" && "params" in body && body.params && typeof body.params === "object"
		? Reflect.get(body.params, "name")
		: undefined;

/** The server's answer per tool: `memory_status` names the project and how it was resolved, `memory_query` the hits. */
const answers = (body: unknown) =>
	toolName(body) === "memory_status"
		? toolResult({ counts: {}, scope: { workspace: "default", project: "ompdesk", resolved_by: resolvedBy } })
		: toolResult(ANSWER);

const queries = () => requests.filter(request => toolName(request.body) === "memory_query");

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "memory-recall-"));
	await mkdir(join(dir, "data", "auth-tokens"), { recursive: true });
	await writeFile(join(dir, "data", "auth-tokens", "default"), "root-token\n");
	requests = [];
	resolvedBy = "session";
	reply = answers;
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

function ctx(kind = "main", branch: unknown[] = [], cwd = "/work/ompdesk") {
	return { cwd, agent: { kind }, sessionManager: { getSessionId: () => "omp-session-1", getBranch: () => branch } };
}

const PROMPT = "기기연결은 테일스케일로만 하고 페어링코드는 삭제했잖아?";

describe("memory recall hook", () => {
	it("asks which project the server matched to this session, then queries that project by name", async () => {
		const result = await hook()({ prompt: PROMPT }, ctx());
		expect(requests.map(request => toolName(request.body))).toEqual(["memory_status", "memory_query"]);
		for (const request of requests) {
			expect(request.headers.authorization).toBe("Bearer root-token");
			expect(request.headers["x-memory-actor-session-id"]).toBe("omp-session-1");
		}
		expect(queries()[0].body).toMatchObject({
			method: "tools/call",
			params: {
				name: "memory_query",
				arguments: {
					workspace: "default",
					project: "ompdesk",
					limit: 8,
					conclusions: true,
					query: expect.stringContaining("테일스케일"),
				},
			},
		});
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

	it("fails closed when the server did not match the session: an expired or missing pointer means its default project", async () => {
		for (const way of ["default_after_mismatch", "default", "shared_slot", "startup_seed"]) {
			resolvedBy = way;
			requests = [];
			expect(await hook()({ prompt: PROMPT }, ctx()), way).toBeUndefined();
			expect(queries(), way).toEqual([]);
		}
	});

	it("keeps the project it matched for this session and folder once the pointer expired, never for another folder", async () => {
		const run = hook();
		expect(await run({ prompt: PROMPT }, ctx())).toBeDefined();
		resolvedBy = "default_after_mismatch";
		requests = [];
		expect(await run({ prompt: PROMPT }, ctx())).toBeDefined();
		expect(queries()[0].body).toMatchObject({ params: { arguments: { workspace: "default", project: "ompdesk" } } });
		requests = [];
		expect(await run({ prompt: PROMPT }, ctx("main", [], "/work/other"))).toBeUndefined();
		expect(queries()).toEqual([]);
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
		reply = body => ({ ...answers(body), delayMs: RECALL_TIMEOUT_MS + 200 });
		const started = Date.now();
		expect(await run({ prompt: PROMPT }, ctx())).toBeUndefined();
		expect(Date.now() - started).toBeLessThan(RECALL_TIMEOUT_MS + 150);
	});

	it("returns no message when nothing found bears on the prompt", async () => {
		expect(await hook()({ prompt: "로그인 화면 버튼 색을 파랗게 바꿔줘" }, ctx())).toBeUndefined();
		expect(queries()).toHaveLength(1);
	});
});

describe("memory recall hook, term corpus", () => {
	const conclusionAnswer = {
		hits: [],
		conclusion_hits: [
			{
				session_id: "s-1",
				title: "원격 연결 정리",
				excerpt: "테일스케일 신원으로만 연결하고 페어링 코드는 삭제했다",
				created_at: "2026-10-01T00:00:00Z",
			},
		],
	};
	const run = async () => {
		reply = body =>
			toolName(body) === "memory_status"
				? toolResult({ scope: { workspace: "default", project: "ompdesk", resolved_by: "session" } })
				: toolResult(conclusionAnswer);
		return (await hook()({ prompt: PROMPT }, ctx())) as { message?: unknown } | undefined;
	};

	it("works with no terms file", async () => {
		expect(await run()).toMatchObject({ message: { customType: MEMORY_RECALL_MESSAGE_TYPE } });
	});

	it("drops a conclusion whose shared words the sibling terms file says are common", async () => {
		// The prompt's rare word (기기연결) is not in the conclusion; every word it does share is everyday.
		const common = Object.fromEntries(["테일스케일", "페어링", "삭제", "신원", "연결", "코드"].map(t => [t, 90]));
		common["기기연결"] = 1;
		await writeFile(
			join(dir, "recall-terms.json"),
			JSON.stringify({ v: 1, store: "s", native: 1, synced: 0, n: 100, df: common }),
		);
		expect(await run()).toBeUndefined();
	});

	it("ignores a malformed terms file", async () => {
		await writeFile(join(dir, "recall-terms.json"), "{not json");
		expect(await run()).toMatchObject({ message: { customType: MEMORY_RECALL_MESSAGE_TYPE } });
	});
});

describe("memory recall hook, what the session already has", () => {
	const own = {
		session_id: "omp-session-1",
		title: "원격 연결 정리",
		excerpt: "테일스케일 신원으로만 연결하고 페어링 코드는 삭제했다",
		created_at: "2026-10-01T00:00:00Z",
	};
	const other = { ...own, session_id: "s-other", title: "다른 세션의 연결 정리" };
	const given = (items: unknown[]) => ({
		type: "custom_message",
		customType: MEMORY_RECALL_MESSAGE_TYPE,
		content: "<memory-recall>…</memory-recall>",
		display: true,
		details: { v: 1, items, judged: false },
	});
	const run = async (answer: unknown, branch: unknown[] = []) => {
		reply = body =>
			toolName(body) === "memory_status"
				? toolResult({ scope: { workspace: "default", project: "ompdesk", resolved_by: "session" } })
				: toolResult(answer);
		return (await hook()({ prompt: PROMPT }, ctx("main", branch))) as
			| { message: { details: { items: { sessionId?: string; path?: string }[] } } }
			| undefined;
	};

	it("never recalls this session's own conclusion: its turns are already in the context", async () => {
		expect(await run({ hits: [], conclusion_hits: [own] })).toBeUndefined();
		const result = await run({ hits: [], conclusion_hits: [own, other] });
		expect(result?.message.details.items.map(item => item.sessionId)).toEqual(["s-other"]);
	});

	it("never gives a note again that an earlier recall in this session gave", async () => {
		const page = {
			title: "원격 기기 공유는 테일스케일 신원 기반으로",
			kind: "decision",
			path: "decisions/remote-sharing.md",
		};
		expect(await run(ANSWER, [given([page])])).toBeUndefined();
		const conclusion = {
			title: "다른 세션의 연결 정리",
			kind: "conclusion",
			sessionId: "s-other",
			at: "2026-10-01T00:00:00Z",
		};
		expect(await run({ hits: [], conclusion_hits: [other] }, [given([conclusion])])).toBeUndefined();
	});

	it("gives a note again once a compaction replaced the turn that had it", async () => {
		const page = {
			title: "원격 기기 공유는 테일스케일 신원 기반으로",
			kind: "decision",
			path: "decisions/remote-sharing.md",
		};
		const result = await run(ANSWER, [given([page]), { type: "compaction", summary: "…" }]);
		expect(result?.message.details.items.map(item => item.path)).toEqual(["decisions/remote-sharing.md"]);
	});

	it("gives a page again once it was edited (a new version), and another session's later conclusion", async () => {
		const page = { ...ANSWER.hits[0], id: "page-v2" };
		const before = { title: page.title, kind: "decision", path: page.path, version: "page-v1" };
		const edited = await run({ hits: [page], conclusion_hits: [] }, [given([before])]);
		expect(edited?.message.details.items.map(item => item.path)).toEqual([page.path]);
		const earlier = { title: other.title, kind: "conclusion", sessionId: "s-other", at: "2026-09-30T00:00:00Z" };
		const later = await run({ hits: [], conclusion_hits: [other] }, [given([earlier])]);
		expect(later?.message.details.items.map(item => item.sessionId)).toEqual(["s-other"]);
	});
});
