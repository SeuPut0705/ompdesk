/**
 * Memory recall (rules: memory-recall-core.ts; contracts: memory-recall-contracts.ts). Before a prompt a person typed
 * in the main session, `before_agent_start` asks the local memory server (`memory_query` over its MCP endpoint,
 * stateless JSON) for pages and session conclusions matching the prompt, lets the judge pick the ones that bear on it
 * (judge-assist-engine.ts `recallRelevance`; the code rule when it does not decide), and returns at most three as one
 * custom message: the model reads them as marked history, the transcript shows one quiet line.
 *
 * Scope: the server resolves the project as it does for the session's own hooks. The request names this omp's
 * session (`x-memory-actor-session-id`, the coordinate ai-memory's hooks publish their active project under), so the
 * project rules (markers, git-remote identity, home routes, aliases) stay the server's and the generated extension's,
 * never re-derived here; `_global` preferences come along as for any single-project query.
 *
 * Quiet on every failure: memory off (no state file), no token yet, the server down or slower than
 * {@link RECALL_TIMEOUT_MS}, an older server, nothing relevant. The prompt goes on unchanged and only a debug line says
 * why. Never on a subagent, another agent's message or an Autopilot run (its prompts are the run's, not a person's).
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type JournalEntry, lastStateEntry } from "./autopilot-core";
import { type JudgeSession, recallRelevance } from "./judge-assist-engine";
import {
	MEMORY_ENV,
	MEMORY_RECALL_MESSAGE_TYPE,
	type MemoryEnv,
	parseMemoryEnv,
	RECALL_QUERY_LIMIT,
	RECALL_TIMEOUT_MS,
} from "./memory-recall-contracts";
import {
	field,
	type RecallCandidate,
	recallCandidates,
	recallDetails,
	recallQuery,
	recallText,
	selectRecall,
	shouldRecall,
} from "./memory-recall-core";

/**
 * The slice of omp's ExtensionAPI this module uses. No omp imports (not even types), like prompt-sections.ts: the
 * GUI's vitest installs it on a fake `pi` (src/main/bridge-memory-recall.test.ts).
 */
interface RecallHost {
	on(
		event: "before_agent_start",
		handler: (
			event: { prompt: string },
			ctx: {
				agent: { kind: string };
				sessionManager: { getSessionId(): string; getBranch(): readonly JournalEntry[] };
			},
		) => Promise<{ message: Record<string, unknown> } | undefined>,
	): void;
	logger: { debug(message: string, details: Record<string, unknown>): void };
	pi: {
		MAIN_AGENT_ID: string;
		AgentRegistry: { global(): { get(id: string): { session?: JudgeSession } | undefined } };
	};
}

/** The `memory_query` answer: the JSON in the MCP result's text parts. Throws on a JSON-RPC or tool error. */
function toolAnswer(body: unknown): unknown {
	const error = field(body, "error");
	if (error !== undefined) throw new Error(String(field(error, "message") ?? "memory_query failed"));
	const result = field(body, "result");
	const content = field(result, "content");
	const text = (Array.isArray(content) ? content : [])
		.map(part => {
			const value = field(part, "text");
			return typeof value === "string" ? value : "";
		})
		.join("");
	if (field(result, "isError") === true) throw new Error(text || "memory_query failed");
	return JSON.parse(text);
}

async function queryMemory(env: MemoryEnv, sessionId: string | undefined, query: string): Promise<unknown> {
	const signal = AbortSignal.timeout(RECALL_TIMEOUT_MS);
	const token = (await readFile(join(env.dataDir, "auth-tokens", "default"), "utf8").catch(() => "")).trim();
	const headers: Record<string, string> = {
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
	};
	if (token) headers.authorization = `Bearer ${token}`;
	if (sessionId) headers["x-memory-actor-session-id"] = sessionId;
	const response = await fetch(`${env.url}/mcp`, {
		method: "POST",
		headers,
		signal,
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			// `conclusions` is ignored by a server without it (its arguments take unknown keys): page hits only then.
			params: { name: "memory_query", arguments: { query, limit: RECALL_QUERY_LIMIT, conclusions: true } },
		}),
	});
	if (!response.ok) throw new Error(`memory answered ${response.status}`);
	return toolAnswer(await response.json());
}

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: RecallHost): void {
	const stateFile = process.env[MEMORY_ENV];
	if (!stateFile) return;
	pi.on("before_agent_start", async (event, ctx) => {
		if (!shouldRecall(event.prompt, ctx.agent.kind)) return undefined;
		const started = Date.now();
		try {
			const env = parseMemoryEnv(await readFile(stateFile, "utf8").catch(() => undefined));
			if (!env) return undefined;
			const run = lastStateEntry(ctx.sessionManager.getBranch());
			if (run && run.state !== "ended") return undefined;
			const query = recallQuery(event.prompt);
			if (!query) return undefined;
			const candidates = recallCandidates(await queryMemory(env, ctx.sessionManager.getSessionId(), query));
			const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID)?.session;
			const judge = session
				? (prompt: string, list: readonly RecallCandidate[]) => recallRelevance(session, prompt, list)
				: undefined;
			const { items, judged } = await selectRecall(event.prompt, candidates, judge);
			pi.logger.debug("gui-bridge: memory recall", {
				ms: Date.now() - started,
				candidates: candidates.length,
				items: items.length,
				judged,
			});
			if (!items.length) return undefined;
			return {
				message: {
					customType: MEMORY_RECALL_MESSAGE_TYPE,
					content: recallText(items),
					display: true,
					details: recallDetails(items, judged),
					attribution: "agent",
				},
			};
		} catch (failure) {
			const error = failure instanceof Error ? failure.message : String(failure);
			pi.logger.debug("gui-bridge: memory recall failed", { ms: Date.now() - started, error });
			return undefined;
		}
	});
}

/** Hooks only: recall has no bridge methods. */
export const methods = {};
