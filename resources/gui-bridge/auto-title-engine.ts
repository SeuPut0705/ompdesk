/**
 * Automatic session titles for GUI tabs (contracts in ./auto-title-contracts.ts, rules in
 * ./auto-title-core.ts, guarded wiring in ./modes/auto-title.ts). Stock names a session only in its TUI
 * (`autoTitle` is a session option; `main.ts` sets it for the TUI, and `PI_NO_TITLE` for `rpc-ui`), so
 * this runs stock's own title machinery from the live session's events:
 *
 * - First title: the operator's first message goes to `AgentSession.generateTitle` (the title model:
 *   stock's `tiny` role, then `commit`, `smol`; never the session model unless no cheap model resolves)
 *   and `renameTitle(title)` heads it with a card per `title.icons`, exactly as `/rename` does. A message
 *   the title model declines (a greeting) is retried from the conversation after the turn, with
 *   `renameTitle()` (stock's `/rename` without a title).
 * - Evolving: while the title is automatic ({@link titleIsAuto}), a terminal `agent_end` asks
 *   {@link EvolveGate} whether the work moved; if so `renameTitle()` makes a fresh title for the recent
 *   conversation, applied only when it is not a reword of the current one.
 * - The person's name is never replaced by a background run: a typed name is "user" source, and every
 *   write re-checks that the name and the title revision are the ones the request started from.
 * - `regenerate_title` (the editor's auto button) is `/rename` without a title on the live session; the
 *   result is automatic from then on, even over a typed name.
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
import { EvolveGate, isRewordedTitle, type TitleChangeLike, titleIsAuto } from "./auto-title-core";

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

/** The slice of stock's `AgentSession` the engine uses. */
export interface TitleSession {
	readonly sessionManager: TitleManager;
	readonly sessionName: string | undefined;
	generateTitle(firstMessage: string, customSystemPrompt?: string, signal?: AbortSignal): Promise<string | null>;
	renameTitle(title?: string, signal?: AbortSignal): Promise<string | null | undefined>;
	subscribe(listener: (event: TitleEvent) => void): () => void;
}

/** Stock functions the engine calls (loaded by modes/auto-title.ts behind the compatibility guard). */
export interface AutoTitleStock {
	/** `session/messages` `operatorTitleText`: what an operator message names, undefined for anything else. */
	operatorTitleText(message: never): string | undefined;
}

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

/** `renameTitle` the way stock's `/rename` calls it: the revision it reserves is read right after the call. */
async function retitle(
	session: TitleSession,
	title?: string,
): Promise<{ title: string | null | undefined; revision: number }> {
	requests++;
	const generation = session.renameTitle(title);
	const revision = session.sessionManager.titleRevision;
	return { title: await generation, revision };
}

/** The first title: the operator's message through the title model, then the card. */
async function firstTitle(session: TitleSession, text: string): Promise<void> {
	const manager = session.sessionManager;
	const sessionId = manager.getSessionId();
	requests++;
	const plain = await session.generateTitle(text);
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

function attach(session: TitleSession, env: AutoTitleEnv): void {
	emitFrame = event => env.emit(event);
	if (subscribed.has(session)) return;
	subscribed.add(session);
	session.subscribe(event => void onEvent(event, session).catch(() => {}));
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
		attach(env.session() as unknown as TitleSession, env);
		return { ...settings, requests };
	},
	/** The editor's auto button: a fresh automatic title for the live session. */
	regenerate_title: async (_params, env) => {
		const session = env.session() as unknown as TitleSession;
		attach(session, env);
		return regenerate(session);
	},
};

/** Tests: back to the spawn-time state. */
export function resetAutoTitleState(next: AutoTitleSettings = DEFAULT_AUTO_TITLE, now: () => number = Date.now): void {
	settings = { ...next };
	emitFrame = undefined;
	clock = now;
	requests = 0;
}

/** Tests: feed one event as the subscription would. */
export function deliverAutoTitleEvent(event: TitleEvent, session: TitleSession): Promise<void> {
	return onEvent(event, session);
}
