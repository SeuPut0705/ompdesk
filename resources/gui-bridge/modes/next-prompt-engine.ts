/**
 * Built-in prompt suggestions. After each main-agent turn (and after a few other state changes: a compaction,
 * the user's own `!` command, a session switch) the bridge asks a cheap model for the message the user will
 * most likely send next and pushes `next_prompt_update` frames: 1–3 ranked candidates the composer shows as its
 * placeholder (best) and chips (the rest). While the user types, `next_prompt_inline` completes the draft.
 *
 * Stock omp has no such feature over RPC: its `ComposerPredictionController` runs only in the TUI, and its
 * `runEphemeralTurn` can only use the session's own model. A suggestion is not worth the main model's price, so
 * the request goes through stock's `completeSimple` with the model stock's `smol` role resolves to (stock's own
 * role chain, empty-role fallback included) and the session's credentials (`modelRegistry.resolver`). A role that
 * resolves to nothing, or to a model without credentials, makes the feature unavailable with that reason; it
 * never falls back to the main model. Rules live in next-prompt-core.ts; contracts in next-prompt-contracts.ts.
 *
 * - Enabled by `OMP_GUI_NEXT_PROMPT` at spawn and `next_prompt_set` afterwards (Settings › Agent behavior,
 *   prefs `nextPromptSuggestions` / `nextPromptInline`).
 * - The renderer reports whether its composer draft is empty (`next_prompt_draft`); typing aborts the pending
 *   or running suggestion, emptying the draft asks again only when the state moved (the person's own deleted draft
 *   brings the suggestion they saw back, never a new one).
 * - The session's last suggestion is kept (and journaled as `NEXT_PROMPT_ENTRY`) and `next_prompt_state` answers
 *   it as `last`: a page that missed the frame (a tab in the background, a reload, a hidden phone, a paired host's
 *   lost link) or an omp started on the session later (a relaunch, an update) shows it again on its next hydration.
 * - Cost: one request per finished turn (a few k tokens in, ≤ 512 out, reasoning off) and, while typing, at most
 *   one per 2 s of typing pauses (cached per draft). `next_prompt_state.requests` counts both.
 * - The user's own `next-prompt` extension is detected through the loaded extension list; the renderer then
 *   ignores its widget. Its own request cannot be stopped from here.
 */
import { lastReplyText, replyNeedsUser } from "./judge-assist-engine";
import {
	INLINE_MAX_DRAFT_CHARS,
	type InlineCompletion,
	inlineEffective,
	MAX_NEXT_PROMPT_CHILDREN,
	NEXT_PROMPT_ENTRY,
	NEXT_PROMPT_REFRESH_REASONS,
	type NextPromptChild,
	type NextPromptConfigFrame,
	type NextPromptLast,
	type NextPromptModelUsed,
	type NextPromptSettings,
	type NextPromptState,
	type NextPromptTrigger,
	type NextPromptUnavailable,
	type NextPromptUpdate,
	parseNextPromptEnv,
} from "./next-prompt-contracts";
import {
	awaitsDecision,
	buildAppState,
	buildInlineRequest,
	buildSuggestionRequest,
	classifyFailure,
	cleanCandidates,
	cleanInlineReply,
	errorText,
	extractFacts,
	gateSuggestion,
	INLINE_INSTRUCTIONS,
	INLINE_TRANSCRIPT_CHARS,
	inlineDraftEligibility,
	inlineDraftWindow,
	isOutputCapRefusal,
	renderTranscript,
	SentMessages,
	type SessionExtras,
	SUGGEST_INSTRUCTIONS,
	SUGGEST_TRANSCRIPT_CHARS,
	SuggestionScheduler,
	sentTexts,
	suggestionStateKey,
	userRegister,
} from "./next-prompt-core";

/** What the engine needs of the bridge's env (modes/next-prompt.ts hands it the real one). */
export interface EngineEnv {
	emit(event: NextPromptUpdate | NextPromptConfigFrame): void;
	session(): unknown;
}

export type EngineMethods = Record<string, (params: unknown, env: EngineEnv) => Promise<unknown>>;

function record(params: unknown): Record<string, unknown> {
	return typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
}

/** Output ceilings: a ceiling, not a target (reasoning is off; see `ask`). */
const SUGGEST_MAX_TOKENS = 512;
/** The inline reply restates the draft window (≤ 400 characters) before its short continuation. */
const INLINE_MAX_TOKENS = 512;
/** Stock's usage-ledger purpose for a composer prediction, so session totals and `/stats` include these requests. */
const USAGE_PURPOSE = "composer-prediction";
/** Sessions whose last suggestion key is remembered. */
const KEYS_KEPT = 20;
/** A request that has not answered by then is no longer worth waiting for. */
const REQUEST_DEADLINE_MS = 20_000;

// ───────────────────────────── stock seam ─────────────────────────────

/** A stock model; `identity.class` is its vendor lineage ("unknown" when stock cannot classify it). */
export interface ModelLike {
	provider: string;
	id: string;
	identity?: { class?: string };
}

interface Registry {
	getApiKey(model: never, sessionId?: string): Promise<unknown>;
	resolver(model: never, sessionId?: string): unknown;
	getAvailable(kind?: string): unknown[];
}

interface MessageLike {
	role: string;
	[key: string]: unknown;
}

/** The slice of the live AgentSession this module reads. */
export interface NextPromptSession {
	messages: readonly MessageLike[];
	isStreaming: boolean;
	isCompacting: boolean;
	queuedMessageCount: number;
	sessionId: string;
	sessionFile?: string;
	settings: unknown;
	modelRegistry: Registry;
	sessionManager: {
		getSessionId(): string;
		getLeafId(): string | null;
		appendModelUsage?(usage: Record<string, unknown>, owner: { sessionId: string; parentId: string | null }): unknown;
		/** The journal: the last suggestion is written there and read back by an omp started on the session later. */
		appendCustomEntry?(customType: string, data: unknown): unknown;
		getBranch?(): ReadonlyArray<{ type?: string; customType?: string; data?: unknown; message?: unknown }>;
	};
	getTodoPhases?(): ReadonlyArray<{ tasks: ReadonlyArray<{ content: string; status: string }> }>;
	getPlanModeState?(): { enabled: boolean; planFilePath?: string } | undefined;
	getGoalModeState?(): { enabled: boolean; goal?: { objective?: string; status?: string } } | undefined;
	getAsyncJobTree?(): { running: ReadonlyArray<{ type: string; label: string; command?: string }> } | null;
	extensionRunner?: {
		getLoadedExtensions?(): ReadonlyArray<{ path: string }>;
		isExtensionActive?(path: string): boolean;
	};
}

interface AssistantReply {
	content: ReadonlyArray<{ type: string; text?: string }>;
	stopReason?: string;
	errorMessage?: string;
	[key: string]: unknown;
}

/** The stock functions this module calls (listed in capabilities.ts `nextPrompt`). */
export interface NextPromptStock {
	completeSimple(model: never, context: unknown, options: unknown): Promise<AssistantReply>;
	roleCandidatePool(role: string, settings: never, registry: never): ModelLike[];
	resolveRoleChain(role: string, settings: never, pool: never): Array<{ model: ModelLike }>;
	shouldSkipHistory(text: string): boolean;
}

let stockOverride: NextPromptStock | undefined;
let stockLoader: (() => Promise<NextPromptStock>) | undefined;
let stockLoaded: Promise<NextPromptStock> | undefined;

/** Tests hand in fakes; undefined restores the real stock modules. */
export function setNextPromptStock(stock: NextPromptStock | undefined): void {
	stockOverride = stock;
}

/**
 * modes/next-prompt.ts registers the loader of the real stock modules (literal specifiers: omp rewrites only those
 * onto its bundled singletons). It runs on first use, after `guard` checked the feature, so a vanished stock module
 * cannot stop the bridge from loading.
 */
export function setNextPromptStockLoader(loader: () => Promise<NextPromptStock>): void {
	stockLoader = loader;
}

function loadStock(): Promise<NextPromptStock> {
	if (stockOverride) return Promise.resolve(stockOverride);
	if (!stockLoader) return Promise.reject(new Error("The stock loader is not registered"));
	stockLoaded ??= stockLoader();
	return stockLoaded;
}

/** An `Error` that already knows the reason the footer hint names. */
class Unavailable extends Error {
	constructor(
		readonly reason: NextPromptUnavailable,
		message: string,
	) {
		super(message);
	}
}

interface Resolved {
	model: ModelLike;
	used: NextPromptModelUsed;
	resolver: unknown;
	/** False when a `prefer` rule matched no credentialed candidate and the first credentialed one stood in. */
	preferred: boolean;
}

/**
 * The first model with credentials on an ordered list of stock roles (`smol` by default): each role's configured
 * value, then its empty-role fallbacks (`resolveRoleChain`), a model listed by two roles counted once. With `prefer`,
 * the first credentialed candidate it accepts wins; failing that, the first credentialed one (`preferred: false`).
 * Nothing matching, or no credentials, is an `Unavailable`; the main model is never a stand-in.
 */
async function resolveModel(
	session: NextPromptSession,
	stock: NextPromptStock,
	roles: readonly string[] = ["smol"],
	prefer?: (model: ModelLike) => boolean,
): Promise<Resolved> {
	const registry = session.modelRegistry;
	const candidates: Array<{ model: ModelLike; role: string }> = [];
	const listed = new Set<string>();
	for (const role of roles) {
		const pool = stock.roleCandidatePool(role, session.settings as never, registry as never);
		for (const candidate of stock.resolveRoleChain(role, session.settings as never, pool as never)) {
			const ref = `${candidate.model.provider}/${candidate.model.id}`;
			if (listed.has(ref)) continue;
			listed.add(ref);
			candidates.push({ model: candidate.model, role });
		}
	}
	if (candidates.length === 0) {
		throw new Unavailable("no_model", `The ${roles.join(" or ")} role resolves to no available model`);
	}
	let fallback: Resolved | undefined;
	for (const { model, role } of candidates) {
		const key = await registry.getApiKey(model as never, session.sessionId);
		if (!key) continue;
		const matches = prefer === undefined || prefer(model);
		if (!matches && fallback) continue;
		const resolved: Resolved = {
			model,
			used: { model: `${model.provider}/${model.id}`, role },
			resolver: registry.resolver(model as never, session.sessionId),
			preferred: matches,
		};
		if (matches) return resolved;
		fallback = resolved;
	}
	if (fallback) return fallback;
	const first = candidates[0]?.model;
	throw new Unavailable(
		"no_credentials",
		`No credentials for ${first ? `${first.provider}/${first.id}` : `the ${roles.join(" or ")} model`}`,
	);
}

interface Asked {
	text: string;
	message: AssistantReply;
}

/**
 * One cheap request. Reasoning is off and the output capped; a transport that refuses the cap (some Responses
 * and Cursor-style transports do) is asked once more without one. A provider error comes back as a thrown
 * error, never as an empty reply.
 */
async function ask(
	session: NextPromptSession,
	stock: NextPromptStock,
	resolved: Resolved,
	system: string,
	user: string,
	options: { maxTokens: number; temperature: number; signal: AbortSignal; deadlineMs?: number },
): Promise<Asked> {
	const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.deadlineMs ?? REQUEST_DEADLINE_MS)]);
	const context = { systemPrompt: [system], messages: [{ role: "user", content: user, timestamp: Date.now() }] };
	const call = (maxTokens: number | undefined) =>
		stock.completeSimple(resolved.model as never, context, {
			apiKey: resolved.resolver,
			sessionId: session.sessionId,
			maxTokens,
			disableReasoning: true,
			temperature: options.temperature,
			signal,
		});
	let message: AssistantReply;
	try {
		message = await call(options.maxTokens);
	} catch (error) {
		if (signal.aborted || !isOutputCapRefusal(error)) throw error;
		message = await call(undefined);
	}
	if (message.stopReason === "error") throw new Error(message.errorMessage ?? "The model request failed");
	// A deadline ends the stream with stopReason "aborted" and no text: an empty answer would read as one. Worded as a
	// timeout so `classifyFailure` calls it offline; a caller's own abort is the caller's to ignore.
	if (message.stopReason === "aborted")
		throw new Error(
			options.signal.aborted
				? (message.errorMessage ?? "The model request was aborted")
				: `The model request timed out after ${Math.round((options.deadlineMs ?? REQUEST_DEADLINE_MS) / 1000)} s`,
		);
	const text = message.content
		.map(block => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
		.join("");
	return { text, message };
}

// ───────────────────────────── module state ─────────────────────────────

/** The slice of omp's ExtensionAPI this module needs. */
export interface NextPromptHost {
	on(event: "agent_start", handler: (event: unknown, ctx: HookContext) => void): void;
	on(event: "agent_end", handler: (event: unknown, ctx: HookContext) => void): void;
	on(event: "session_switch", handler: (event: unknown, ctx: HookContext) => void): void;
	on(event: "session_compact", handler: (event: unknown, ctx: HookContext) => void): void;
	on(event: "session_shutdown", handler: (event: unknown, ctx: HookContext) => void): void;
	logger: { debug(message: string, data?: Record<string, unknown>): void };
	pi: {
		AgentRegistry: { global(): { get(id: unknown): { session?: unknown } | undefined } };
		MAIN_AGENT_ID: unknown;
	};
	getCommands?(): ReadonlyArray<{ name: string; description?: string; source: string }>;
}

interface HookContext {
	agent: { kind: string };
}

let settings: NextPromptSettings = parseNextPromptEnv(process.env.OMP_GUI_NEXT_PROMPT);
let draftEmpty = true;
let latestEnv: EngineEnv | undefined;
let host: NextPromptHost | undefined;
let unavailable: { reason: NextPromptUnavailable; detail?: string } | undefined;
let lastModel: NextPromptModelUsed | undefined;
let inlineAbort: AbortController | undefined;
const requests = { suggest: 0, inline: 0 };
/** Last suggestion's state key per session (session file, else id): "did the state move since?". */
const lastKeys = new Map<string, string>();

/** A session's last suggestion: candidates empty once a run made it stale (or nothing fitted); `key` its moment. */
interface Kept {
	candidates: string[];
	used?: NextPromptModelUsed;
	at: number;
	key?: string;
}
/**
 * The last suggestion per session key; `null` = the journal was read and holds none still valid. Absent: not read
 * yet (an omp that just started on a stored session reads the journal once).
 */
const kept = new Map<string, Kept | null>();

const scheduler = new SuggestionScheduler({ run: (trigger, signal) => generate(trigger, signal) });

function mainSession(): NextPromptSession | undefined {
	if (host) {
		const entry = host.pi.AgentRegistry.global().get(host.pi.MAIN_AGENT_ID);
		return entry?.session as NextPromptSession | undefined;
	}
	// Hooks are not installed yet (a method call came first): the env of that call knows the live session.
	try {
		return latestEnv?.session() as unknown as NextPromptSession | undefined;
	} catch {
		return undefined;
	}
}

function sessionKey(session: NextPromptSession): string {
	return session.sessionFile || session.sessionId;
}

function idle(session: NextPromptSession): boolean {
	return !session.isStreaming && !session.isCompacting && session.queuedMessageCount === 0;
}

function emitFrame(frame: NextPromptUpdate | NextPromptConfigFrame): void {
	latestEnv?.emit(frame);
}

function identity(session: NextPromptSession): Pick<NextPromptUpdate, "sessionFile" | "sessionId"> {
	return { ...(session.sessionFile ? { sessionFile: session.sessionFile } : {}), sessionId: session.sessionId };
}

function remember(key: string, stateKey: string): void {
	lastKeys.delete(key);
	lastKeys.set(key, stateKey);
	for (const stale of [...lastKeys.keys()].slice(0, Math.max(0, lastKeys.size - KEYS_KEPT))) lastKeys.delete(stale);
}

function keep(key: string, entry: Kept | null): void {
	kept.delete(key);
	kept.set(key, entry);
	for (const stale of [...kept.keys()].slice(0, Math.max(0, kept.size - KEYS_KEPT))) kept.delete(stale);
}

/** What `NEXT_PROMPT_ENTRY` holds, or null for anything else. */
function journaled(data: unknown): Kept | null {
	if (typeof data !== "object" || data === null) return null;
	const value = data as Record<string, unknown>;
	if (!Array.isArray(value.candidates) || typeof value.at !== "number") return null;
	const candidates = value.candidates.filter((text): text is string => typeof text === "string" && text.trim() !== "");
	const used = value.used as Record<string, unknown> | undefined;
	return {
		candidates,
		at: value.at,
		...(typeof value.key === "string" ? { key: value.key } : {}),
		...(used && typeof used.model === "string" && typeof used.role === "string"
			? { used: { model: used.model, role: used.role } }
			: {}),
	};
}

/**
 * The journal's last suggestion, valid while no message followed it (a prompt, a reply, a tool result: the moment it
 * was made for has passed). Custom messages (a recap, a session report) leave it standing, as they do on screen.
 */
function fromJournal(session: NextPromptSession): Kept | null {
	let branch: ReturnType<NonNullable<NextPromptSession["sessionManager"]["getBranch"]>>;
	try {
		branch = session.sessionManager.getBranch?.() ?? [];
	} catch {
		return null;
	}
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry?.type === "message") return null;
		if (entry?.type === "custom" && entry.customType === NEXT_PROMPT_ENTRY) return journaled(entry.data);
	}
	return null;
}

/** The session's last suggestion, read from the journal the first time this omp is asked about the session. */
function lastFor(session: NextPromptSession): NextPromptLast | undefined {
	const key = sessionKey(session);
	let entry = kept.get(key);
	if (entry === undefined) {
		entry = fromJournal(session);
		keep(key, entry);
		// Made for the moment this omp sees too: a trigger that finds the moment unchanged asks the model nothing.
		if (entry?.key && !lastKeys.has(key) && moment(session).key === entry.key) remember(key, entry.key);
	}
	if (!entry) return undefined;
	return {
		candidates: [...entry.candidates],
		...(entry.used ? { used: entry.used } : {}),
		at: entry.at,
		...identity(session),
	};
}

/**
 * What the user typed in this session, oldest first ({@link sentTexts}), from the journal's branch when the session
 * has one: after a compaction `session.messages` keeps only a few of them, too few to tell the register (measured: 6
 * of 16 real moments named none) or to catch a candidate that restates an earlier request.
 */
function typedTexts(session: NextPromptSession): string[] {
	try {
		const branch = session.sessionManager.getBranch?.();
		if (branch && branch.length > 0)
			return sentTexts(
				branch.flatMap(entry => (entry.type === "message" && "message" in entry ? [entry.message] : [])),
			);
	} catch {
		// The live messages below.
	}
	return sentTexts(session.messages);
}

/** Kept for the next hydration, and journaled so an omp started on the session later has it too. */
function keepSuggestion(session: NextPromptSession, entry: Kept): void {
	keep(sessionKey(session), entry);
	try {
		session.sessionManager.appendCustomEntry?.(NEXT_PROMPT_ENTRY, {
			candidates: entry.candidates,
			...(entry.used ? { used: entry.used } : {}),
			at: entry.at,
			...(entry.key ? { key: entry.key } : {}),
		});
	} catch (error) {
		host?.logger.debug("next-prompt suggestion not journaled", { error: errorText(error) });
	}
}

/** The user's own `next-prompt` extension is loaded and active (its widget is ignored while this feature is on). */
function legacyExtensionLoaded(session: NextPromptSession | undefined): boolean {
	const runner = session?.extensionRunner;
	if (runner?.getLoadedExtensions) {
		const active = runner.isExtensionActive?.bind(runner);
		return runner
			.getLoadedExtensions()
			.some(
				extension =>
					/(?:^|[\\/])next-prompt\.[cm]?[jt]s$/.test(extension.path) && (active ? active(extension.path) : true),
			);
	}
	// Without the runner: the extension's `/suggest` command is the tell.
	return (
		host
			?.getCommands?.()
			.some(
				command =>
					command.source === "extension" &&
					command.name === "suggest" &&
					/next-prompt/i.test(command.description ?? ""),
			) ?? false
	);
}

async function currentState(session: NextPromptSession | undefined): Promise<NextPromptState> {
	let model: NextPromptModelUsed | undefined = lastModel;
	let failure = unavailable;
	if (session) {
		try {
			model = (await resolveModel(session, await loadStock())).used;
			lastModel = model;
			if (failure && (failure.reason === "no_model" || failure.reason === "no_credentials")) {
				unavailable = undefined;
				failure = undefined;
			}
		} catch (error) {
			model = undefined;
			failure = {
				reason: error instanceof Unavailable ? error.reason : classifyFailure(error),
				detail: errorText(error),
			};
		}
	}
	return {
		...settings,
		legacyExtension: legacyExtensionLoaded(session),
		...(model ? { model } : {}),
		...(failure ? { unavailable: failure.reason, ...(failure.detail ? { detail: failure.detail } : {}) } : {}),
		requests: { ...requests },
	};
}

/** `next_prompt_state`: the feature's state and the main session's last suggestion. */
async function stateWithLast(session: NextPromptSession | undefined): Promise<NextPromptState> {
	const state = await currentState(session);
	const last = session && settings.suggestions ? lastFor(session) : undefined;
	return last ? { ...state, last } : state;
}

/** Pushes the feature's current state (settings, legacy extension, model, availability). */
async function emitConfig(): Promise<void> {
	if (!latestEnv) return;
	const frame: NextPromptConfigFrame = { type: "next_prompt_config", ...(await currentState(mainSession())) };
	emitFrame(frame);
}

function fail(session: NextPromptSession, trigger: NextPromptTrigger, error: unknown): void {
	const reason = error instanceof Unavailable ? error.reason : classifyFailure(error);
	const detail = errorText(error);
	host?.logger.debug("next-prompt suggestion unavailable", { reason, detail, trigger });
	const changed = unavailable?.reason !== reason;
	unavailable = { reason, detail };
	const frame: NextPromptUpdate = {
		type: "next_prompt_update",
		status: "unavailable",
		trigger,
		reason,
		detail,
		...identity(session),
	};
	emitFrame(frame);
	if (changed) void emitConfig();
}

// ───────────────────────────── suggestions ─────────────────────────────

function sessionExtras(session: NextPromptSession): SessionExtras {
	const plan = session.getPlanModeState?.();
	const goal = session.getGoalModeState?.();
	const jobs = session.getAsyncJobTree?.();
	return {
		...(plan ? { plan: { enabled: plan.enabled === true } } : {}),
		...(session.getTodoPhases ? { todoPhases: session.getTodoPhases() } : {}),
		...(goal?.goal?.objective
			? {
					goal: {
						objective: goal.goal.objective,
						enabled: goal.enabled,
						...(goal.goal.status ? { status: goal.goal.status } : {}),
					},
				}
			: {}),
		...(jobs ? { runningJobs: jobs.running } : {}),
		...(openedChildren.length > 0 ? { openedSessions: openedChildren } : {}),
	};
}

/** The sessions this omp's main agent opened that still run or wait (main pushes them, `next_prompt_children`). */
let openedChildren: NextPromptChild[] = [];

/** Set by a compaction until the next suggestion consumes it. */
let compactedSinceSuggestion = false;

/**
 * The moment a suggestion is made for: the `<app-state>` section and the state key it is remembered by. `judged`
 * (the judge's reading of the last reply, undefined without one) changes only the section: the key is always the
 * code rule's, because the gate asks for it before the judge has answered and a key moving with the judge's answer
 * would regenerate an unchanged moment.
 */
function moment(session: NextPromptSession, judged?: boolean): { appState: string; key: string } {
	const extras = {
		...sessionExtras(session),
		...(compactedSinceSuggestion ? { compacted: true } : {}),
	};
	const rule = buildAppState(extractFacts(session.messages, extras));
	const appState =
		judged === undefined ? rule : buildAppState(extractFacts(session.messages, { ...extras, replyAsksUser: judged }));
	return { appState, key: suggestionStateKey(session.messages, rule) };
}

async function generate(trigger: NextPromptTrigger, signal: AbortSignal): Promise<void> {
	const session = mainSession();
	if (!session) return;
	const key = sessionKey(session);
	const messages = session.messages;
	const { appState: ruleAppState, key: stateKey } = moment(session);
	const gate = gateSuggestion({
		enabled: settings.suggestions,
		idle: idle(session),
		draftEmpty,
		main: true,
		hasReply: messages.some(message => message.role === "assistant"),
		lastKey: lastKeys.get(key),
		key: stateKey,
		force: trigger === "refresh",
	});
	if (!gate.ok) {
		host?.logger.debug("next-prompt suggestion skipped", { reason: gate.reason, trigger });
		return;
	}
	const started = performance.now();
	try {
		// Asked early so it runs beside the model lookup; never blocks the gate, never throws.
		const judging = replyNeedsUser(session, lastReplyText(messages));
		const stock = await loadStock();
		const resolved = await resolveModel(session, stock);
		const judged = await judging;
		if (signal.aborted) return;
		const appState = judged === undefined ? ruleAppState : moment(session, judged).appState;
		requests.suggest++;
		const sent = typedTexts(session);
		const register = userRegister(sent);
		const prompt = buildSuggestionRequest(renderTranscript(messages, SUGGEST_TRANSCRIPT_CHARS), appState, register);
		const { text, message } = await ask(session, stock, resolved, SUGGEST_INSTRUCTIONS, prompt, {
			maxTokens: SUGGEST_MAX_TOKENS,
			temperature: 0.3,
			signal,
		});
		recordUsage(session, resolved, message);
		if (signal.aborted || sessionKey(session) !== key || !idle(session) || !draftEmpty) return;
		// The answer is worth showing only while the moment it was made for is still the moment. Running work that
		// ended or started meanwhile moves it without a run or a keystroke, so nothing else would ask again.
		if (moment(session).key !== stateKey) {
			request(trigger);
			return;
		}
		compactedSinceSuggestion = false;
		remember(key, stateKey);
		lastModel = resolved.used;
		const candidates = cleanCandidates(text, {
			register,
			sent: new SentMessages(sent),
			decisionPending: awaitsDecision(messages, judged),
			style: sent,
		});
		const ms = Math.round(performance.now() - started);
		host?.logger.debug("next-prompt suggestion", {
			trigger,
			model: resolved.used.model,
			ms,
			candidates: candidates.length,
			register,
		});
		const wasUnavailable = unavailable !== undefined;
		unavailable = undefined;
		keepSuggestion(session, { candidates, used: resolved.used, at: Date.now(), key: stateKey });
		const update: NextPromptUpdate = {
			type: "next_prompt_update",
			status: "ready",
			trigger,
			candidates,
			used: resolved.used,
			ms,
			...identity(session),
		};
		emitFrame(update);
		if (wasUnavailable) void emitConfig();
	} catch (error) {
		if (signal.aborted) return;
		fail(session, trigger, error);
	}
}

/** Stock's usage ledger gets the request (as it does for its own predictions); never worth failing a suggestion for. */
function recordUsage(
	session: NextPromptSession,
	resolved: Resolved,
	message: AssistantReply,
	purpose = USAGE_PURPOSE,
): void {
	try {
		session.sessionManager.appendModelUsage?.(
			{
				purpose,
				role: resolved.used.role,
				api: message.api,
				provider: message.provider ?? resolved.model.provider,
				model: message.model ?? resolved.model.id,
				usage: message.usage,
				stopReason: message.stopReason,
			},
			{ sessionId: session.sessionManager.getSessionId(), parentId: session.sessionManager.getLeafId() },
		);
	} catch (error) {
		host?.logger.debug("next-prompt usage not recorded", { error: errorText(error) });
	}
}

function request(trigger: NextPromptTrigger): void {
	if (settings.suggestions) scheduler.request(trigger);
}

// ───────────────────────────── hooks ─────────────────────────────

/** Called once per extension instance (main and every subagent rebinding) by index.ts. */
export function install(pi: NextPromptHost): void {
	host = pi;
	const main = (ctx: HookContext) => ctx.agent.kind === "main";
	pi.on("agent_start", (_event, ctx) => {
		if (!main(ctx)) return;
		// A new run makes any pending or running suggestion stale, and the one shown too.
		scheduler.cancel();
		const session = mainSession();
		if (session) keep(sessionKey(session), { candidates: [], at: Date.now() });
	});
	pi.on("agent_end", (_event, ctx) => {
		if (main(ctx)) request("turn");
	});
	pi.on("session_compact", (_event, ctx) => {
		if (!main(ctx)) return;
		compactedSinceSuggestion = true;
		request("compaction");
	});
	pi.on("session_switch", (_event, ctx) => {
		if (!main(ctx)) return;
		compactedSinceSuggestion = false;
		// A session whose suggestion is missing or stale gets a fresh one; the gate drops an unchanged one.
		request("switch");
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (!main(ctx)) return;
		scheduler.cancel();
		inlineAbort?.abort();
	});
}

// ───────────────────────────── methods ─────────────────────────────

function flag(params: Record<string, unknown>, name: string): boolean {
	const value = params[name];
	if (typeof value !== "boolean") throw new Error(`next_prompt_set needs {suggestions: boolean, inline: boolean}`);
	return value;
}

function attach(env: EngineEnv): void {
	latestEnv = env;
}

/** The method table before the guard (tests drive it with a fake stock). */
export const handlers: EngineMethods = {
	/** `{suggestions, inline}`: the Settings values (main pushes them at connect and on every change). */
	next_prompt_set: async (params, env) => {
		attach(env);
		const input = record(params);
		const next: NextPromptSettings = { suggestions: flag(input, "suggestions"), inline: flag(input, "inline") };
		const enabledNow = next.suggestions && !settings.suggestions;
		const disabledNow = !next.suggestions && settings.suggestions;
		settings = next;
		if (disabledNow) {
			scheduler.cancel();
			inlineAbort?.abort();
			const session = mainSession();
			if (session) {
				keep(sessionKey(session), { candidates: [], at: Date.now() });
				emitFrame({ type: "next_prompt_update", status: "cleared", ...identity(session) });
			}
		}
		if (!next.inline) inlineAbort?.abort();
		if (enabledNow) request("refresh");
		await emitConfig();
		return { ...settings };
	},

	next_prompt_state: async (_params, env) => {
		attach(env);
		return stateWithLast(mainSession());
	},

	/** `{empty}`: the composer draft is (not) empty. Typing aborts a pending suggestion; emptying it asks again when the state moved. */
	next_prompt_draft: async (params, env) => {
		attach(env);
		const empty = record(params).empty;
		if (typeof empty !== "boolean") throw new Error("next_prompt_draft needs {empty: boolean}");
		const changed = empty !== draftEmpty;
		draftEmpty = empty;
		if (!changed) return { empty };
		if (!empty) scheduler.cancel();
		// Asks only when the moment moved, or no suggestion was made for it (typing dropped the request).
		else request("draft");
		return { empty };
	},

	/** `{reason}`: the renderer saw something the bridge does not (a finished `!` command). Forced past the unchanged-state gate. */
	next_prompt_refresh: async (params, env) => {
		attach(env);
		const reason = record(params).reason;
		if (typeof reason !== "string" || !(NEXT_PROMPT_REFRESH_REASONS as readonly string[]).includes(reason))
			throw new Error(`next_prompt_refresh needs {reason: ${NEXT_PROMPT_REFRESH_REASONS.join(" | ")}}`);
		request(reason === "bash" ? "bash" : reason === "switch" ? "switch" : "refresh");
		return { requested: settings.suggestions };
	},

	/** `{children}`: main's list of the sessions the main agent opened that still run or wait for an answer. */
	next_prompt_children: async (params, env) => {
		attach(env);
		const children = record(params).children;
		if (!Array.isArray(children)) throw new Error("next_prompt_children needs {children: {title, waiting?}[]}");
		openedChildren = children
			.filter((child): child is Record<string, unknown> => typeof child === "object" && child !== null)
			.filter(child => typeof child.title === "string" && child.title.trim() !== "")
			.slice(0, MAX_NEXT_PROMPT_CHILDREN)
			.map(child => ({ title: String(child.title), ...(child.waiting === true ? { waiting: true } : {}) }));
		return { children: openedChildren.length };
	},

	/** `{scope: "suggest" | "inline" | "all"}`. */
	next_prompt_cancel: async (params, env) => {
		attach(env);
		const scope = record(params).scope;
		if (scope !== "suggest" && scope !== "inline" && scope !== "all")
			throw new Error("next_prompt_cancel needs {scope: suggest | inline | all}");
		if (scope !== "inline") scheduler.cancel();
		if (scope !== "suggest") inlineAbort?.abort();
		return { cancelled: scope };
	},

	/** `{draft, requestId}` → InlineCompletion: the text that continues the draft, or null. */
	next_prompt_inline: async (params, env): Promise<InlineCompletion> => {
		attach(env);
		const input = record(params);
		const draft = input.draft;
		const requestId = input.requestId;
		if (typeof draft !== "string" || typeof requestId !== "string" || requestId === "")
			throw new Error("next_prompt_inline needs {draft: string, requestId: string}");
		const none: InlineCompletion = { requestId, text: null };
		// Any newer request, eligible or not, supersedes the one in flight (the user typed on).
		inlineAbort?.abort();
		const abort = new AbortController();
		inlineAbort = abort;
		if (!inlineEffective(settings)) return none;
		if (!inlineDraftEligibility({ draft, caretAtEnd: true, composing: false, menuOpen: false }).ok) return none;
		const stock = await loadStock();
		// A draft that looks like a secret (stock's history rule: /login, /join, /mcp add --token) never leaves the machine.
		if (stock.shouldSkipHistory(draft)) return none;
		const session = env.session() as unknown as NextPromptSession;
		const started = performance.now();
		try {
			const resolved = await resolveModel(session, stock);
			if (abort.signal.aborted) return none;
			requests.inline++;
			const messages = session.messages;
			const sent = typedTexts(session);
			const register = userRegister(sent);
			const transcript = renderTranscript(messages, INLINE_TRANSCRIPT_CHARS);
			const { text } = await ask(
				session,
				stock,
				resolved,
				INLINE_INSTRUCTIONS,
				buildInlineRequest(transcript, inlineDraftWindow(draft), register),
				{
					maxTokens: INLINE_MAX_TOKENS,
					temperature: 0,
					signal: abort.signal,
				},
			);
			if (abort.signal.aborted) return none;
			const completion = cleanInlineReply(text, draft, { register, sent: new SentMessages(sent) });
			const ms = Math.round(performance.now() - started);
			// Whether a ghost was shown, never the text: evidence for "odd continuations" without logging what was typed.
			host?.logger.debug("next-prompt inline", {
				model: resolved.used.model,
				ms,
				shown: completion !== null,
				register,
			});
			return { requestId, text: completion, used: resolved.used, ms };
		} catch (error) {
			if (abort.signal.aborted) return none;
			const reason = error instanceof Unavailable ? error.reason : classifyFailure(error);
			host?.logger.debug("next-prompt inline unavailable", {
				reason,
				detail: errorText(error),
				maxDraft: INLINE_MAX_DRAFT_CHARS,
			});
			return { requestId, text: null, reason };
		} finally {
			if (inlineAbort === abort) inlineAbort = undefined;
		}
	},
};

/** For tests: forget every module-level state. */
export function resetNextPromptState(): void {
	scheduler.cancel();
	inlineAbort?.abort();
	inlineAbort = undefined;
	settings = parseNextPromptEnv(process.env.OMP_GUI_NEXT_PROMPT);
	draftEmpty = true;
	latestEnv = undefined;
	host = undefined;
	unavailable = undefined;
	lastModel = undefined;
	requests.suggest = 0;
	requests.inline = 0;
	lastKeys.clear();
	kept.clear();
	compactedSinceSuggestion = false;
}

/** What one cheap request answered with (the model that served it, the text, what it cost). */
export interface SmolCompletion {
	text: string;
	/** `provider/id` of the model that served it. */
	model: string;
	/** The stock role whose chain supplied the model. */
	role: string;
	/** The stock model itself (its `identity.class` is the lineage); the judge reports it. */
	modelRef: ModelLike;
	/** False when `prefer` accepted no credentialed candidate and the first credentialed one served instead. */
	preferred: boolean;
	usd?: number;
	tokens?: number;
}

/**
 * One request on stock roles (`smol` unless `roles` or `role` name others, tried in that order; see `resolveModel`)
 * for another bridge module (Autopilot's guide draft, the control tools' judge on `advisor` then `slow`): same
 * resolution as the suggestions (never the session's model), same output ceiling, the request in stock's usage
 * ledger under `purpose`. `deadlineMs` replaces the 20 s a suggestion may take, for a caller whose answer is long.
 * Throws when no role has a model or credentials or the request fails; the caller owns its fallback.
 */
export async function completeOnSmol(
	session: NextPromptSession,
	request: {
		system: string;
		user: string;
		maxTokens: number;
		temperature: number;
		purpose: string;
		role?: string;
		roles?: readonly string[];
		prefer?: (model: ModelLike) => boolean;
		deadlineMs?: number;
		signal?: AbortSignal;
	},
): Promise<SmolCompletion> {
	const stock = await loadStock();
	const resolved = await resolveModel(session, stock, request.roles ?? [request.role ?? "smol"], request.prefer);
	const asked = await ask(session, stock, resolved, request.system, request.user, {
		maxTokens: request.maxTokens,
		temperature: request.temperature,
		signal: request.signal ?? new AbortController().signal,
		...(request.deadlineMs === undefined ? {} : { deadlineMs: request.deadlineMs }),
	});
	recordUsage(session, resolved, asked.message, request.purpose);
	const usage = asked.message.usage as { cost?: { total?: unknown }; totalTokens?: unknown } | undefined;
	const cost = usage?.cost?.total;
	const tokens = usage?.totalTokens;
	return {
		text: asked.text,
		model: resolved.used.model,
		role: resolved.used.role,
		modelRef: resolved.model,
		preferred: resolved.preferred,
		...(typeof cost === "number" ? { usd: cost } : {}),
		...(typeof tokens === "number" ? { tokens } : {}),
	};
}
