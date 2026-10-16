/**
 * Automatic session titles for GUI tabs (contracts in ./auto-title-contracts.ts, rules in
 * ./auto-title-core.ts, guarded wiring in ./modes/auto-title.ts). Stock names a session only in its TUI
 * (`autoTitle` is a session option; `main.ts` sets it for the TUI, and `PI_NO_TITLE` for `rpc-ui`), so
 * this runs stock's own title machinery from the live session's events:
 *
 * - First title: the operator's first message goes to `AgentSession.generateTitle` (the title model:
 *   stock's `tiny` role, then `commit`, `smol`; never the session model unless no cheap model resolves)
 *   and `renameTitle(title)` heads it with a card per `title.icons`, exactly as `/rename` does (OMPdesk holds
 *   `boring`, so no card and no card request unless the person chose icons). A message
 *   the title model declines (a greeting) is retried from the conversation after the turn, with
 *   `renameTitle()` (stock's `/rename` without a title).
 * - Evolving: while the title is automatic ({@link titleIsAuto}), a terminal `agent_end` asks
 *   {@link EvolveGate} whether the work moved; if so `renameTitle()` makes a fresh title for the recent
 *   conversation, applied only when it is not a reword of the current one.
 * - The person's name is never replaced by a background run: a typed name is "user" source, and every
 *   write re-checks that the name and the title revision are the ones the request started from.
 * - `regenerate_title` (the editor's auto button) is `/rename` without a title on the live session; the
 *   result is automatic from then on, even over a typed name.
 * - Language and length: every title path above reads the session's title prompt override
 *   (`AgentSession.titleSystemPrompt`, stock's TITLE_SYSTEM.md slot). It is stock's own `title-system.md` plus
 *   one line ({@link planTitlePrompt}: the person's language, the reply language as the fallback when it is not
 *   English, a plain 2-4 word noun phrase), set when the engine attaches, when `reply_language_set` changes the
 *   language, and again before each request (stock's headless `/move` re-resolves the slot). While that line is in
 *   effect, a title past the limits ({@link titleFits}) gets one retry with {@link titleShorterLine} on a stronger
 *   model than the cheap title chain (stock's `default` role, else the session's model; reasoning off, a small output
 *   cap); the retry wins unless it is longer, cut only past the hard cap ({@link conciseTitle}). Each generated
 *   title is logged with the model's answers, the retry's model and usage (`auto-title: title` in omp's log). A
 *   person's own TITLE_SYSTEM.md is left as written, and its titles uncut.
 * - Cards: under `title.icons: boring` a fresh title for a session whose title has a card comes back plain
 *   (stock adds none, but its retitle keeps the current title's card).
 *
 * No omp imports: the GUI's vitest drives it with fake sessions (src/main/bridge-auto-title.test.ts).
 */
import {
	type AutoTitleSettings,
	DEFAULT_AUTO_TITLE,
	evolveEffective,
	normalizeAutoTitle,
	parseAutoTitleEnv,
	TITLE_TRIGGER,
	type TitleRegenerateResult,
	titleEffective,
} from "./auto-title-contracts";
import {
	conciseTitle,
	EvolveGate,
	isRewordedTitle,
	planTitlePrompt,
	type TitleChangeLike,
	titleFits,
	titleIsAuto,
	titleShorterLine,
} from "./auto-title-core";
import { currentReplyLanguage, onReplyLanguageChange } from "./modes/reply-language";

/** A frame the engine pushes to the GUI (it reaches the renderer as if omp had written it). */
export interface AutoTitleFrame {
	type: string;
	[key: string]: unknown;
}

/** The slice of the bridge's `BridgeEnv` the engine uses. */
export interface AutoTitleEnv {
	session(): unknown;
	emit(event: AutoTitleFrame): void;
}

export type AutoTitleMethods = Record<string, (params: unknown, env: AutoTitleEnv) => Promise<unknown>>;

/** The slice of stock's `SessionManager` the engine uses. */
export interface TitleManager {
	getSessionId(): string;
	getSessionName(): string | undefined;
	readonly titleSource: string | undefined;
	readonly titleRevision: number;
	getEntries(): readonly TitleChangeLike[];
	setSessionName(name: string, source: "auto" | "user", trigger?: string): Promise<boolean>;
}

/** An event `AgentSession.subscribe` delivers (only these fields are read). */
export interface TitleEvent {
	type: string;
	isTerminal?: boolean;
	message?: unknown;
	toolName?: string;
	isError?: boolean;
}

/** A catalog model, as stock's role resolution returns it (only these fields are read). */
export interface TitleModel {
	provider: string;
	id: string;
}

/** A stock `completeSimple` reply (only these fields are read). */
export interface TitleReply {
	content: ReadonlyArray<{ type: string; text?: string }>;
	stopReason?: string;
	errorMessage?: string;
	usage?: unknown;
}

/** The slice of stock's `AgentSession` the engine uses. */
export interface TitleSession {
	readonly sessionManager: TitleManager;
	readonly sessionName: string | undefined;
	readonly sessionId: string;
	/** The session's settings (read for `title.icons` and the `default` role). */
	readonly settings: unknown;
	/** The session's model: the retry's model when the `default` role resolves to nothing usable. */
	readonly model: TitleModel | undefined;
	readonly modelRegistry: {
		getApiKey(model: never, sessionId?: string): Promise<unknown>;
		resolver(model: never, sessionId?: string): unknown;
	};
	generateTitle(firstMessage: string, customSystemPrompt?: string, signal?: AbortSignal): Promise<string | null>;
	renameTitle(title?: string, signal?: AbortSignal): Promise<string | null | undefined>;
	subscribe(listener: (event: TitleEvent) => void): () => void;
	/** The title prompt override every title path uses (stock's TITLE_SYSTEM.md slot); undefined = stock's own. */
	readonly titleSystemPrompt: string | undefined;
	setTitleSystemPrompt(prompt: string | undefined): void;
}

/** Stock functions the engine calls (loaded by modes/auto-title.ts behind the compatibility guard). */
export interface AutoTitleStock {
	/** `session/messages` `operatorTitleText`: what an operator message names, undefined for anything else. */
	operatorTitleText(message: never): string | undefined;
	/** Stock's bundled title prompt (`prompts/system/title-system.md`, rendered as stock renders it). */
	titleSystemPrompt: string;
	/** `utils/title-card` `splitCardTitle`: the pieces of `<icon> <CODE>: <title>`, undefined for a plain title. */
	splitCardTitle(title: string): { icon: string; code: string; title: string } | undefined;
	/** `utils/title-card` `formatCardTitle`: `title` headed by `card`. */
	formatCardTitle(card: { icon: string; code: string }, title: string): string;
	/** `utils/title-settings` `cfgTitleIcons.get`: the session's `title.icons` (`boring` = no card). */
	titleIcons(settings: unknown): string;
	/** `pi-utils` `logger.info`: one line in omp's own log (`~/.omp/logs`). */
	log(message: string, context: Record<string, unknown>): void;
	/** `config/model-roles` `roleCandidatePool` and `config/model-resolver` `resolveRoleChain`: a role's models. */
	roleCandidatePool(role: string, settings: never, registry: never): TitleModel[];
	resolveRoleChain(role: string, settings: never, pool: never): Array<{ model: TitleModel }>;
	/** `pi-ai` `completeSimple`: one request on a chosen model. */
	completeSimple(model: never, context: unknown, options: unknown): Promise<TitleReply>;
	/** `tiny/text` `normalizeGeneratedTitle`: stock's check of a title answer (`<title/>`, junk, a whole reply). */
	normalizeGeneratedTitle(value: string, sourceText?: string): string | null;
}

/** The retry's output ceiling (reasoning is off; a title is a handful of tokens) and how long it may take. */
const RETRY_MAX_TOKENS = 256;
const RETRY_DEADLINE_MS = 20_000;

let stock: AutoTitleStock | undefined;
let loadStock: (() => Promise<AutoTitleStock>) | undefined;

export function setAutoTitleStock(next: AutoTitleStock | undefined): void {
	stock = next;
}

export function setAutoTitleStockLoader(loader: () => Promise<AutoTitleStock>): void {
	loadStock = loader;
}

async function stockFunctions(): Promise<AutoTitleStock> {
	if (stock) return stock;
	if (!loadStock) throw new Error("Auto title: stock loader missing");
	stock = await loadStock();
	return stock;
}

let settings: AutoTitleSettings = parseAutoTitleEnv(process.env.OMP_GUI_AUTO_TITLE);

/** Per-session bookkeeping of the one live main session. */
interface Tracking {
	sessionId: string;
	gate: EvolveGate;
	/** A first-title or evolve request is running: another one waits for the next turn. */
	busy: boolean;
}

const tracked = new WeakMap<TitleSession, Tracking>();
const subscribed = new WeakSet<TitleSession>();
let emitFrame: AutoTitleEnv["emit"] | undefined;
let clock: () => number = Date.now;
/** Title-model requests started (a first title, a retitle, a card, a regeneration), for the cost report. */
let requests = 0;
/** The title prompt the engine last set on each session; any other value there is the person's TITLE_SYSTEM.md. */
const ownPrompts = new WeakMap<TitleSession, string>();
/** The live main session (the latest attach), which a changed reply language retitles the prompt of. */
let live: TitleSession | undefined;
let followsLanguage = false;

function tracking(session: TitleSession): Tracking {
	const sessionId = session.sessionManager.getSessionId();
	let state = tracked.get(session);
	if (!state || state.sessionId !== sessionId) {
		state = { sessionId, gate: new EvolveGate(clock()), busy: false };
		tracked.set(session, state);
	}
	return state;
}

/** Stock's source for a write: "auto" unless a typed name made it "user" (stock refuses "auto" over that). */
function writeSource(manager: TitleManager): "auto" | "user" {
	return manager.titleSource === "user" ? "user" : "auto";
}

/** Give `session`'s title paths the reply language (see {@link planTitlePrompt}). */
async function applyTitleLanguage(session: TitleSession): Promise<void> {
	const { titleSystemPrompt } = await stockFunctions();
	const plan = planTitlePrompt(
		session.titleSystemPrompt,
		ownPrompts.get(session),
		titleSystemPrompt,
		currentReplyLanguage(),
	);
	if (plan.keep) {
		ownPrompts.delete(session);
		return;
	}
	ownPrompts.set(session, plan.prompt);
	if (session.titleSystemPrompt !== plan.prompt) session.setTitleSystemPrompt(plan.prompt);
}

/**
 * The retry's model: stock's `default` role (its configured value, then its fallbacks, `resolveRoleChain`), else the
 * session's model; the first with credentials. Never the cheap title chain, which wrote the answer being retried.
 */
async function retryModel(
	session: TitleSession,
	functions: AutoTitleStock,
): Promise<{ model: TitleModel; resolver: unknown } | undefined> {
	const registry = session.modelRegistry;
	const pool = functions.roleCandidatePool("default", session.settings as never, registry as never);
	const chain = functions.resolveRoleChain("default", session.settings as never, pool as never);
	for (const model of [...chain.map(candidate => candidate.model), ...(session.model ? [session.model] : [])]) {
		if (await registry.getApiKey(model as never, session.sessionId))
			return { model, resolver: registry.resolver(model as never, session.sessionId) };
	}
	return undefined;
}

interface Retry {
	title: string | null;
	model: string;
	usage: unknown;
}

/** The one shorter retry: the slot's prompt plus {@link titleShorterLine}, on {@link retryModel}. */
async function shorterTitle(session: TitleSession, prompt: string, answer: string, input: string): Promise<Retry> {
	const functions = await stockFunctions();
	const target = await retryModel(session, functions);
	if (!target) throw new Error("No model with credentials for the default role or the session");
	const reply = await functions.completeSimple(
		target.model as never,
		{
			systemPrompt: [`${prompt}\n\n${titleShorterLine(answer)}`],
			messages: [{ role: "user", content: input, timestamp: Date.now() }],
		},
		{
			apiKey: target.resolver,
			sessionId: session.sessionId,
			maxTokens: RETRY_MAX_TOKENS,
			disableReasoning: true,
			temperature: 0,
			// A one-off request: a cache write (Anthropic's 1 h write costs twice the input) would be its whole cost.
			cacheRetention: "none",
			signal: AbortSignal.timeout(RETRY_DEADLINE_MS),
		},
	);
	if (reply.stopReason === "error") throw new Error(reply.errorMessage ?? "The title retry failed");
	const text = reply.content.map(block => (block.type === "text" ? (block.text ?? "") : "")).join("");
	const marked = /<title>([\s\S]*?)<\/title>/i.exec(text)?.[1] ?? text;
	return {
		title: functions.normalizeGeneratedTitle(marked, input),
		model: `${target.model.provider}/${target.model.id}`,
		usage: reply.usage,
	};
}

/**
 * `title` as the session should show it: without its card under `title.icons: boring` (stock's retitle keeps the
 * current title's card even then), and while the line is in effect fitted to its length. With `retryInput` (the
 * message the retry names: the operator's, or the answer itself when stock built the context) a title past the
 * limits gets one retry on a stronger model ({@link shorterTitle}, counted in `requests`); the retry wins unless it
 * is longer, and {@link conciseTitle} is the last safety net. Without `retryInput` (a title fitted already) it is
 * only fitted.
 */
async function concise(
	session: TitleSession,
	title: string | null | undefined,
	retryInput?: (answer: string) => string,
): Promise<string | null | undefined> {
	if (!title) return title;
	const { splitCardTitle, formatCardTitle, titleIcons, log } = await stockFunctions();
	const card = splitCardTitle(title);
	const answer = card?.title ?? title;
	const own = ownPrompts.get(session);
	if (own === undefined) return card && titleIcons(session.settings) !== "boring" ? title : answer;
	let text = answer;
	let retry: Retry | undefined;
	if (!titleFits(answer) && retryInput) {
		requests++;
		try {
			retry = await shorterTitle(session, own, answer, retryInput(answer));
		} catch (error) {
			// The first answer is still a title: keep it rather than lose the name.
			log("auto-title: shorter retry failed", { answer, error: String(error) });
		}
	}
	if (!titleFits(answer)) {
		const shorter = retry?.title;
		text = conciseTitle(shorter && shorter.trim().length <= answer.trim().length ? shorter : answer);
	}
	// Every generated title, with the model's own answers, so a title that reads wrong can be traced.
	if (retryInput)
		log("auto-title: title", {
			answer,
			retry: retry?.title ?? null,
			retryModel: retry?.model ?? null,
			retryUsage: retry?.usage ?? null,
			title: text,
		});
	return card && titleIcons(session.settings) !== "boring" ? formatCardTitle(card, text) : text;
}

/**
 * Write an automatic title and tell the GUI. The caller has checked that the name is still the one its
 * request started from; stock itself refuses an "auto" write over the person's name.
 */
async function writeTitle(session: TitleSession, title: string): Promise<boolean> {
	const manager = session.sessionManager;
	const sessionId = manager.getSessionId();
	const ok = await manager.setSessionName(title, writeSource(manager), TITLE_TRIGGER);
	if (!ok) return false;
	tracking(session).gate.reset(clock());
	emitFrame?.({ type: "session_info_update", title: manager.getSessionName(), sessionId });
	return true;
}

/** A request began for `sessionId` and `name`: still the live session and the same name afterwards? */
function unchanged(session: TitleSession, sessionId: string, name: string | undefined, revision: number): boolean {
	const manager = session.sessionManager;
	return manager.getSessionId() === sessionId && session.sessionName === name && manager.titleRevision === revision;
}

/**
 * `renameTitle` the way stock's `/rename` calls it: the revision it reserves is read right after the call. A typed
 * `title` was fitted already, so only a generated one may get the retry.
 */
async function retitle(
	session: TitleSession,
	title?: string,
): Promise<{ title: string | null | undefined; revision: number }> {
	await applyTitleLanguage(session);
	requests++;
	const generation = session.renameTitle(title);
	const revision = session.sessionManager.titleRevision;
	const named = await generation;
	return { title: await concise(session, named, title === undefined ? answer => answer : undefined), revision };
}

/** The first title: the operator's message through the title model, then the card. */
async function firstTitle(session: TitleSession, text: string): Promise<void> {
	const manager = session.sessionManager;
	const sessionId = manager.getSessionId();
	await applyTitleLanguage(session);
	requests++;
	const plain = await concise(session, await session.generateTitle(text), () => text);
	if (!plain || manager.getSessionId() !== sessionId || session.sessionName) return;
	const { title, revision } = await retitle(session, plain);
	if (!title || !unchanged(session, sessionId, undefined, revision)) return;
	await writeTitle(session, title);
}

/** An unnamed session after a turn the title model declined: name it from the conversation. */
async function contextTitle(session: TitleSession): Promise<void> {
	const sessionId = session.sessionManager.getSessionId();
	const { title, revision } = await retitle(session);
	if (!title || !unchanged(session, sessionId, undefined, revision)) return;
	await writeTitle(session, title);
}

/** An automatic title after the work moved: a fresh one unless it only rewords the current. */
async function evolveTitle(session: TitleSession): Promise<void> {
	const manager = session.sessionManager;
	const sessionId = manager.getSessionId();
	const name = session.sessionName;
	if (!name) return;
	const { title, revision } = await retitle(session);
	if (!title || !unchanged(session, sessionId, name, revision)) return;
	if (!titleIsAuto(name, manager.titleSource, manager.getEntries()) || isRewordedTitle(name, title)) return;
	await writeTitle(session, title);
}

function runBackground(session: TitleSession, work: () => Promise<void>): void {
	const state = tracking(session);
	if (state.busy) return;
	state.busy = true;
	void work()
		.catch(() => {})
		.finally(() => {
			state.busy = false;
		});
}

async function onEvent(event: TitleEvent, session: TitleSession): Promise<void> {
	const state = tracking(session);
	state.gate.note(event);
	if (!titleEffective(settings)) return;
	if (event.type === "message_end" && !session.sessionName && event.message !== undefined) {
		const text = (await stockFunctions()).operatorTitleText(event.message as never);
		if (text && !session.sessionName) runBackground(session, () => firstTitle(session, text));
		return;
	}
	// A pending async wake is a pause, not the end of the work.
	if (event.type !== "agent_end" || event.isTerminal === false) return;
	const manager = session.sessionManager;
	if (!session.sessionName) {
		runBackground(session, () => contextTitle(session));
		return;
	}
	if (!evolveEffective(settings) || !titleIsAuto(session.sessionName, manager.titleSource, manager.getEntries()))
		return;
	if (state.gate.turnEnded(clock())) runBackground(session, () => evolveTitle(session));
}

/** Follow the live session's events, and give its title prompt the reply language. */
async function attach(session: TitleSession, env: AutoTitleEnv): Promise<void> {
	emitFrame = event => env.emit(event);
	live = session;
	if (!followsLanguage) {
		followsLanguage = true;
		onReplyLanguageChange(() => (live ? applyTitleLanguage(live) : undefined));
	}
	if (!subscribed.has(session)) {
		subscribed.add(session);
		session.subscribe(event => void onEvent(event, session).catch(() => {}));
	}
	await applyTitleLanguage(session);
}

/** `{enabled, evolve, suppressed}` as main's prefs say; anything else is refused rather than read as on. */
function parseSettings(params: unknown): AutoTitleSettings {
	if (typeof params !== "object" || params === null) throw new Error("auto_title_set needs {enabled, evolve}");
	const { enabled, evolve } = params as Record<string, unknown>;
	if (typeof enabled !== "boolean" || typeof evolve !== "boolean")
		throw new Error("auto_title_set needs {enabled: boolean, evolve: boolean}");
	return normalizeAutoTitle(params);
}

/** The `regenerate_title` method: `/rename` without a title on the live session, saved as an automatic title. */
export async function regenerate(session: TitleSession): Promise<TitleRegenerateResult> {
	const manager = session.sessionManager;
	const sessionId = manager.getSessionId();
	const name = session.sessionName;
	const { title, revision } = await retitle(session);
	if (title === undefined || manager.getSessionId() !== sessionId || manager.titleRevision !== revision)
		return { title: null, reason: "superseded" };
	if (!title) return { title: null, reason: "none" };
	// The person may have typed a name while the model worked: that one wins, as a newer rename does in stock.
	if (session.sessionName !== name) return { title: null, reason: "superseded" };
	if (!(await writeTitle(session, title))) return { title: null, reason: "none" };
	return { title };
}

export const handlers: AutoTitleMethods = {
	/** Main sends this to every live local sidecar when a pref changes, and on bridge connect. */
	auto_title_set: async (params, env) => {
		settings = parseSettings(params);
		await attach(env.session() as unknown as TitleSession, env);
		return { ...settings, requests };
	},
	/** The editor's auto button: a fresh automatic title for the live session. */
	regenerate_title: async (_params, env) => {
		const session = env.session() as unknown as TitleSession;
		await attach(session, env);
		return regenerate(session);
	},
};

/** Tests: back to the spawn-time state. */
export function resetAutoTitleState(next: AutoTitleSettings = DEFAULT_AUTO_TITLE, now: () => number = Date.now): void {
	settings = { ...next };
	emitFrame = undefined;
	live = undefined;
	clock = now;
	requests = 0;
}

/** Tests: feed one event as the subscription would. */
export function deliverAutoTitleEvent(event: TitleEvent, session: TitleSession): Promise<void> {
	return onEvent(event, session);
}
