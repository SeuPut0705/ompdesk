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
	JUDGE_ASSIST_PREVIEW_CHECK,
	JUDGE_ASSIST_SET,
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
	TITLE_TURNS,
	type TitleTurn,
	titleFitRequest,
} from "./judge-assist-core";
import { messageText } from "./next-prompt-core";

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
	/** The model the chain routes to first (stock `ChainJudge.primaryModel`). */
	primaryModel?(): unknown;
}

/** Stock `judgment` functions the engine calls (capabilities.ts `judgeAssist`; loaded by modes/judge-assist.ts). */
export interface JudgeAssistStock {
	hasNativeJudge(settings: never, registry: never): boolean;
	resolveJudge(deps: never): StockJudge;
	sharedJudgmentCache(): unknown;
	journalJudgmentUsage(manager: never): unknown;
	/** `@oh-my-pi/pi-ai`: the image bounds of a native judgment model, undefined when it takes no images. */
	nativeJudgmentImageBounds(model: never): unknown;
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

/** `judge_assist_set {enabled: boolean}`: anything else is refused rather than read as on or off. */
export function applyJudgeAssistSet(params: unknown): { enabled: boolean; requests: number } {
	const value = field(params, "enabled");
	if (typeof value !== "boolean") throw new Error(`${JUDGE_ASSIST_SET} needs {enabled: boolean}`);
	setJudgeAssistEnabled(value);
	return judgeAssistState();
}

/** `judge_assist.preview_check {image: {data, mimeType}}`: the capture, or a refusal naming the shape. */
export function previewImageParam(params: unknown): { data: string; mimeType: string } {
	const image = field(params, "image");
	const data = field(image, "data");
	const mimeType = field(image, "mimeType");
	if (typeof data !== "string" || typeof mimeType !== "string" || !data) {
		throw new Error(`${JUDGE_ASSIST_PREVIEW_CHECK} needs {image: {data, mimeType}}`);
	}
	return { data, mimeType };
}

/**
 * The answers, or undefined whenever the code rule must decide. Never throws. The limit also covers a stock that
 * ignores the abort signal: the caller never waits past it, whatever the judge does. `request` is built only once the
 * gate has passed, so a feature off or without a native judge never pays for reading its input.
 */
async function ask(
	session: JudgeSession,
	purpose: string,
	request: () => unknown,
	needsImages = false,
): Promise<unknown> {
	if (!enabled || !loadStock) return undefined;
	const limit = new AbortController();
	const timedOut = Promise.withResolvers<undefined>();
	const timer = setTimeout(() => {
		limit.abort();
		timedOut.resolve(undefined);
	}, JUDGE_ASSIST_TIMEOUT_MS);
	try {
		return await Promise.race([
			judge(loadStock, session, purpose, request, needsImages, limit.signal),
			timedOut.promise,
		]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Stock's judge for `session`, or undefined when none would answer natively: the `judge` role chain must resolve
 * first to a native model (`hasNativeJudge`) and, for a picture, that model must take images natively. Stock's image
 * chain drops a native judge without image support and then keeps the whole chain, so a chat model (@tiny, @smol,
 * @default) would be shown the picture; asking `primaryModel()` first keeps a picture away from every other model.
 */
function nativeJudgeFor(
	stock: JudgeAssistStock,
	session: JudgeSession,
	purpose: string,
	needsImages: boolean,
): StockJudge | undefined {
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
	const judge = stock.resolveJudge(deps as never);
	if (!needsImages) return judge;
	const primary = judge.primaryModel?.();
	return primary !== undefined && stock.nativeJudgmentImageBounds(primary as never) !== undefined ? judge : undefined;
}

async function judge(
	load: () => Promise<JudgeAssistStock>,
	session: JudgeSession,
	purpose: string,
	request: () => unknown,
	needsImages: boolean,
	signal: AbortSignal,
): Promise<unknown> {
	try {
		const chain = nativeJudgeFor(await load(), session, purpose, needsImages);
		if (!chain) return undefined;
		requests++;
		return (await chain.judge(request(), { signal })).answers;
	} catch {
		return undefined;
	}
}

/**
 * Would a judgment be asked right now: the switch is on and stock's `hasNativeJudge` says the judge role resolves
 * first to a native model; `forImages` also needs that model to take images natively (the Preview check). No model
 * call; false on any error. Lets a caller skip work that only a judgment needs.
 */
export async function judgeAvailable(session: JudgeSession, forImages = false): Promise<boolean> {
	if (!enabled || !loadStock) return false;
	try {
		const stock = await loadStock();
		if (!forImages) return stock.hasNativeJudge(session.settings as never, session.modelRegistry as never);
		return nativeJudgeFor(stock, session, "ompdesk-preview-check", true) !== undefined;
	} catch {
		return false;
	}
}

/**
 * The judgment in flight for one reply: the notification and the suggestion engine ask about the same reply at the
 * same moment. Only while it is in flight: once settled it is forgotten, so a later ask passes the live gate again
 * (the switch turned off, a key removed or restored), and stock's answer cache serves a repeat at no cost.
 */
let pendingReply: { session: JudgeSession; reply: string; answer: Promise<boolean | undefined> } | undefined;

/** Does `reply` (the last assistant text) end by waiting for the person? Undefined: the judge did not decide. */
export function replyNeedsUser(session: JudgeSession, reply: string): Promise<boolean | undefined> {
	if (!reply.trim()) return Promise.resolve(undefined);
	if (pendingReply && pendingReply.session === session && pendingReply.reply === reply) return pendingReply.answer;
	const entry = {
		session,
		reply,
		answer: ask(session, "ompdesk-needs-user", () => needsUserRequest(reply)).then(needsUserFrom),
	};
	pendingReply = entry;
	void entry.answer.finally(() => {
		if (pendingReply === entry) pendingReply = undefined;
	});
	return entry.answer;
}

/**
 * `judge_assist.needs_user` for the live session: does its last reply wait for the person? `null`: the judge did not
 * decide. A queued follow-up or a goal continuation that already started puts its own user message last, so
 * `lastReplyText` reads "" and nothing is asked. `isStreaming` is not the signal: stock keeps it true past `agent_end`
 * while its post-turn work (auto-compaction) runs, which would turn every such notification into a plain one.
 */
export async function sessionNeedsUser(
	session: JudgeSession & { readonly messages: readonly unknown[] },
): Promise<boolean | null> {
	return (await replyNeedsUser(session, lastReplyText(session.messages))) ?? null;
}

/**
 * Should an evolving title `next` replace `current`? Undefined: the judge did not decide (apply as before). `turns`
 * may be a function: it runs only once a judgment will be asked.
 */
export async function newTitleFits(
	session: JudgeSession,
	current: string,
	next: string,
	turns: readonly TitleTurn[] | (() => readonly TitleTurn[]),
): Promise<boolean | undefined> {
	return newTitleFitsFrom(
		await ask(session, "ompdesk-title-check", () =>
			titleFitRequest(current, next, typeof turns === "function" ? turns() : turns),
		),
	);
}

/** Does a capture of a page the agent opened show an error or a blank page? Only a native judge that takes images. */
export async function previewProblem(
	session: JudgeSession,
	image: { data: string; mimeType: string },
): Promise<PreviewCheckResult> {
	const problem = previewProblemFrom(
		await ask(
			session,
			"ompdesk-preview-check",
			() => ({
				state: PREVIEW_STATE,
				questions: PREVIEW_QUESTIONS,
				images: [{ type: "image", data: image.data, mimeType: image.mimeType }],
			}),
			true,
		),
	);
	return problem === undefined ? { problem: null, judged: false } : { problem, judged: true };
}

/**
 * The last {@link TITLE_TURNS} exchanges of a transcript (each user message with the last assistant text that
 * followed it), read from the tail: a long session is not walked from its start.
 */
export function recentTitleTurns(messages: readonly unknown[]): TitleTurn[] {
	const turns: TitleTurn[] = [];
	let assistant = "";
	for (let index = messages.length - 1; index >= 0 && turns.length < TITLE_TURNS; index--) {
		const message = messages[index];
		const role = field(message, "role");
		if (role === "assistant") {
			if (!assistant) assistant = messageText(message).trim();
		} else if (role === "user") {
			turns.push({ user: messageText(message).trim(), assistant });
			assistant = "";
		}
	}
	return turns.reverse();
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
