/**
 * Judge-model assists, the engine (contracts and the measured numbers: judge-assist-contracts.ts; questions and
 * thresholds: judge-assist-core.ts). Every judgment goes through stock's own machinery, the way auto mode asks:
 * `resolveJudge` over the `judge` role chain, `sharedJudgmentCache()`, the session ledger (`journalJudgmentUsage`) and
 * telemetry. It runs only while the switch is on and stock's `hasNativeJudge` says that chain resolves first to a
 * native decision model; the check runs on every call, because a login, a key or a role change moves the chain.
 *
 * Every function answers `undefined` (preview: `judged: false`) when the judge did not decide: switch off, no native
 * judge, stock module missing, an error, a timeout or an unreadable answer. Callers then keep the code rule they had
 * before, so OMPdesk without the judge behaves exactly as it did.
 */
import {
	JUDGE_ASSIST_ENV,
	JUDGE_ASSIST_TIMEOUT_MS,
	type PreviewCheckResult,
	parseJudgeAssistEnv,
} from "./judge-assist-contracts";
import {
	needsUserFrom,
	needsUserRequest,
	newTitleFitsFrom,
	PREVIEW_QUESTIONS,
	PREVIEW_STATE,
	previewProblemFrom,
	type TitleTurn,
	titleFitRequest,
} from "./judge-assist-core";

/** The slice of stock's `AgentSession` a judgment reads (the live session; engines pass their own slice of it). */
export interface JudgeSession {
	readonly settings: unknown;
	readonly modelRegistry: unknown;
	readonly sessionId: string;
	readonly sessionManager: unknown;
	readonly model?: unknown;
	readonly agent?: unknown;
}

interface StockJudge {
	judge(request: unknown, options: { signal: AbortSignal }): Promise<{ answers: unknown }>;
}

/** Stock `judgment` functions the engine calls (capabilities.ts `judgeAssist`; loaded by modes/judge-assist.ts). */
export interface JudgeAssistStock {
	hasNativeJudge(settings: never, registry: never): boolean;
	resolveJudge(deps: never): StockJudge;
	sharedJudgmentCache(): unknown;
	journalJudgmentUsage(manager: never): unknown;
}

let loadStock: (() => Promise<JudgeAssistStock>) | undefined;
let enabled = parseJudgeAssistEnv(process.env[JUDGE_ASSIST_ENV]);
let requests = 0;

/** Set by modes/judge-assist.ts once the guard admitted the feature; tests pass a fake stock. */
export function setJudgeAssistStockLoader(load: (() => Promise<JudgeAssistStock>) | undefined): void {
	loadStock = load;
}

/** Main's switch (`judge_assist_set`, spawn env `OMP_GUI_JUDGE_ASSIST`). */
export function setJudgeAssistEnabled(value: boolean): void {
	enabled = value;
}

export function judgeAssistState(): { enabled: boolean; requests: number } {
	return { enabled, requests };
}

/** `value[key]` when `value` is an object holding it. */
function field(value: unknown, key: string): unknown {
	return value !== null && typeof value === "object" && key in value ? Reflect.get(value, key) : undefined;
}

/** The answers, or undefined whenever the code rule must decide. Never throws. */
async function ask(session: JudgeSession, purpose: string, request: unknown): Promise<unknown> {
	if (!enabled || !loadStock) return undefined;
	try {
		const stock = await loadStock();
		if (!stock.hasNativeJudge(session.settings as never, session.modelRegistry as never)) return undefined;
		const agent = session.agent;
		const metadataForProvider = field(agent, "metadataForProvider");
		const deps = {
			settings: session.settings,
			registry: session.modelRegistry,
			sessionModel: session.model,
			sessionId: session.sessionId,
			...(typeof metadataForProvider === "function"
				? { metadataResolver: (provider: string) => metadataForProvider.call(agent, provider) }
				: {}),
			purpose,
			onUsage: stock.journalJudgmentUsage(session.sessionManager as never),
			telemetry: field(agent, "telemetry"),
			cache: stock.sharedJudgmentCache(),
		};
		requests++;
		const result = await stock
			.resolveJudge(deps as never)
			.judge(request, { signal: AbortSignal.timeout(JUDGE_ASSIST_TIMEOUT_MS) });
		return result.answers;
	} catch {
		return undefined;
	}
}

/** The judgment in flight for one reply: the notification and the suggestion engine ask about the same reply. */
let pendingReply: { session: JudgeSession; reply: string; answer: Promise<boolean | undefined> } | undefined;

/** Does `reply` (the last assistant text) end by waiting for the person? Undefined: the judge did not decide. */
export function replyNeedsUser(session: JudgeSession, reply: string): Promise<boolean | undefined> {
	if (!reply.trim()) return Promise.resolve(undefined);
	if (pendingReply && pendingReply.session === session && pendingReply.reply === reply) return pendingReply.answer;
	const answer = ask(session, "ompdesk-needs-user", needsUserRequest(reply)).then(needsUserFrom);
	pendingReply = { session, reply, answer };
	return answer;
}

/** Should an evolving title `next` replace `current`? Undefined: the judge did not decide (apply as before). */
export async function newTitleFits(
	session: JudgeSession,
	current: string,
	next: string,
	turns: readonly TitleTurn[],
): Promise<boolean | undefined> {
	return newTitleFitsFrom(await ask(session, "ompdesk-title-check", titleFitRequest(current, next, turns)));
}

/** Does a capture of a page the agent opened show an error or a blank page? */
export async function previewProblem(
	session: JudgeSession,
	image: { data: string; mimeType: string },
): Promise<PreviewCheckResult> {
	const problem = previewProblemFrom(
		await ask(session, "ompdesk-preview-check", {
			state: PREVIEW_STATE,
			questions: PREVIEW_QUESTIONS,
			images: [{ type: "image", data: image.data, mimeType: image.mimeType }],
		}),
	);
	return problem === undefined ? { problem: null, judged: false } : { problem, judged: true };
}

/** A transcript message's plain text (string content or its text parts). */
export function messageText(message: unknown): string {
	const content = field(message, "content");
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part =>
			field(part, "type") === "text" && typeof field(part, "text") === "string" ? field(part, "text") : "",
		)
		.join("\n");
}

/** The last assistant text of a transcript (a message of tool calls only is skipped), or "". */
export function lastReplyText(messages: readonly unknown[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (field(message, "role") === "user") return "";
		if (field(message, "role") !== "assistant") continue;
		const text = messageText(message).trim();
		if (text) return text;
	}
	return "";
}
