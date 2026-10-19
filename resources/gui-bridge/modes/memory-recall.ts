/**
 * Memory recall (rules: memory-recall-core.ts; contracts: memory-recall-contracts.ts). Before a prompt a person typed
 * in the main session, `before_agent_start` asks the local memory server (`memory_query` over its MCP endpoint,
 * stateless JSON) for pages and session conclusions matching the prompt, lets the judge pick the ones that bear on it
 * (judge-assist-engine.ts `recallRelevance`; the code rule when it does not decide), and returns at most three as one
 * custom message: the model reads them as marked history, the transcript shows one quiet line.
 *
 * Scope, fail closed: the project is never re-derived here (markers, git-remote identity, home routes and aliases
 * are the server's and the generated extension's). `memory_status` is asked first under this omp's session
 * (`x-memory-actor-session-id`, the coordinate ai-memory's hooks publish their active project under) and recall goes
 * on only when the server matched the session itself (`resolved_by: "session"`); `memory_query` then names that
 * workspace and project. A keyed pointer expires after an idle hour and the first hook may not have landed yet: the
 * server then answers with its default project, which may be another one, so recall uses the project it matched
 * earlier for this session in this folder, or nothing. `_global` preferences come along as for any single-project
 * query.
 *
 * Quiet on every failure: memory off (no state file), no token yet, the server down or slower than
 * {@link RECALL_TIMEOUT_MS}, an older server, nothing relevant. The prompt goes on unchanged and only a debug line says
 * why. Never on a subagent, another agent's message or an Autopilot run (its prompts are the run's, not a person's).
 */
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type JournalEntry, lastStateEntry } from "./autopilot-core";
import { type JudgeSession, recallRelevance } from "./judge-assist-engine";
import {
	MEMORY_ENV,
	MEMORY_RECALL_MESSAGE_TYPE,
	type MemoryEnv,
	parseMemoryEnv,
	RECALL_QUERY_LIMIT,
	RECALL_TERMS_FILE,
	RECALL_TIMEOUT_MS,
} from "./memory-recall-contracts";
import {
	field,
	type RecallCandidate,
	type RecallScope,
	type RecallTermStats,
	recallCandidates,
	recallDetails,
	recallQuery,
	recallText,
	selectRecall,
	sessionScope,
	shouldRecall,
} from "./memory-recall-core";

/** Remembered session scopes (`<session id>\n<cwd>`), newest last; one omp holds one session, a switch adds one. */
const REMEMBERED_MAX = 8;

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
				cwd: string;
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

/** A tool's answer: the JSON in the MCP result's text parts. Throws on a JSON-RPC or tool error. */
function toolAnswer(name: string, body: unknown): unknown {
	const error = field(body, "error");
	if (error !== undefined) throw new Error(String(field(error, "message") ?? `${name} failed`));
	const result = field(body, "result");
	const content = field(result, "content");
	const text = (Array.isArray(content) ? content : [])
		.map(part => {
			const value = field(part, "text");
			return typeof value === "string" ? value : "";
		})
		.join("");
	if (field(result, "isError") === true) throw new Error(text || `${name} failed`);
	return JSON.parse(text);
}

/** One stateless MCP `tools/call` on the memory server, under this omp's session. */
async function callTool(
	env: MemoryEnv,
	headers: Record<string, string>,
	signal: AbortSignal,
	name: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	const response = await fetch(`${env.url}/mcp`, {
		method: "POST",
		headers,
		signal,
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
	});
	if (!response.ok) throw new Error(`memory answered ${response.status}`);
	return toolAnswer(name, await response.json());
}

/** The corpus file's parse by path, valid while its mtime and size hold (one parse per change, not per prompt). */
const termsCache = new Map<string, { key: string; stats: RecallTermStats | undefined }>();

/** The term corpus main keeps beside the state file; a missing or malformed file is no stats. */
async function readTermStats(stateFile: string): Promise<RecallTermStats | undefined> {
	const file = join(dirname(stateFile), RECALL_TERMS_FILE);
	try {
		const info = await stat(file);
		const key = `${info.mtimeMs}:${info.size}`;
		const cached = termsCache.get(file);
		if (cached?.key === key) return cached.stats;
		const value: unknown = JSON.parse(await readFile(file, "utf8"));
		const n = field(value, "n");
		const df = field(value, "df");
		const stats =
			typeof n === "number" && n > 0 && df !== null && typeof df === "object" && !Array.isArray(df)
				? {
						n,
						df: Object.fromEntries(
							Object.entries(df).filter(([, v]) => typeof v === "number" && v > 0),
						) as Record<string, number>,
					}
				: undefined;
		termsCache.set(file, { key, stats });
		return stats;
	} catch {
		return undefined;
	}
}

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: RecallHost): void {
	const stateFile = process.env[MEMORY_ENV];
	if (!stateFile) return;
	const remembered = new Map<string, RecallScope>();
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
			const signal = AbortSignal.timeout(RECALL_TIMEOUT_MS);
			const token = (await readFile(join(env.dataDir, "auth-tokens", "default"), "utf8").catch(() => "")).trim();
			const sessionId = ctx.sessionManager.getSessionId();
			const headers: Record<string, string> = {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"x-memory-actor-session-id": sessionId,
			};
			if (token) headers.authorization = `Bearer ${token}`;
			const key = `${sessionId}\n${ctx.cwd}`;
			const matched = sessionScope(await callTool(env, headers, signal, "memory_status", {}));
			if (matched) {
				remembered.delete(key);
				remembered.set(key, matched);
				if (remembered.size > REMEMBERED_MAX) remembered.delete(remembered.keys().next().value ?? key);
			}
			const scope = matched ?? remembered.get(key);
			if (!scope) {
				pi.logger.debug("gui-bridge: memory recall skipped", { reason: "scope not matched to this session" });
				return undefined;
			}
			const candidates = recallCandidates(
				// `conclusions` is ignored by a server without it (its arguments take unknown keys): page hits only then.
				await callTool(env, headers, signal, "memory_query", {
					query,
					workspace: scope.workspace,
					project: scope.project,
					limit: RECALL_QUERY_LIMIT,
					conclusions: true,
				}),
			);
			const stats = await readTermStats(stateFile);
			const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID)?.session;
			const judge = session
				? (prompt: string, list: readonly RecallCandidate[]) => recallRelevance(session, prompt, list)
				: undefined;
			const { items, judged } = await selectRecall(event.prompt, candidates, judge, stats);
			pi.logger.debug("gui-bridge: memory recall", {
				ms: Date.now() - started,
				candidates: candidates.length,
				items: items.length,
				judged,
				terms: stats?.n ?? 0,
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
