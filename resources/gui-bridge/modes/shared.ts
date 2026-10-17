/**
 * Plumbing shared by the session-mode bridge methods: param narrowing, omp's
 * prompt templates, and one subscription to the live session's events, the
 * extension `session_switch` event and RPC `input` (host prompts).
 *
 * Subscriptions attach on the first modes call, not at bridge load: nothing a
 * mode reacts to can happen before the GUI has armed that mode through a call.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { BridgeEnv, BridgeEvent } from "../types";

export function record(params: unknown): Record<string, unknown> {
	return typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
}

/**
 * Lets `emit` reach the GUI before any modes call attached (index.ts binds its env at start): a frame sent from
 * a stock seam, like the desktop slot's acquire, must not depend on the renderer having asked for state first.
 */
export function bindEnv(env: BridgeEnv): void {
	attachedEnv = env;
}

/** Push a frame to the GUI through the env of the latest modes call. */
export function emit(event: BridgeEvent): void {
	attachedEnv?.emit(event);
}

/** omp's live package index (`pi.pi`) as seen by the latest modes call. */
export function ompPackage(): BridgeEnv["pi"]["pi"] {
	if (!attachedEnv) throw new Error("gui-bridge modes are not attached");
	return attachedEnv.pi.pi;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Start a turn without aborting one in flight: queue behind it, falling back to a
 * follow-up on the busy race (the TUI's streaming guard). Resolves once admitted.
 */
export async function submitTurn(session: AgentSession, text: string, synthetic: boolean): Promise<void> {
	if (session.isStreaming) {
		await session.followUp(text, undefined, { synthetic });
		return;
	}
	try {
		await session.prompt(text, { synthetic });
	} catch (error) {
		if (!(error instanceof Error) || error.name !== "AgentBusyError") throw error;
		await session.followUp(text, undefined, { synthetic });
	}
}

const promptCache = new Map<string, string>();

/**
 * Where omp keeps a prompt template, by its path under `src/prompts` (e.g.
 * `system/omfg-user.md`). omp bundles its prompts into `dist/cli.js`, where the
 * extension shim cannot reach them, but the published package also ships
 * `src/`, next to the `dist/` the CLI runs from.
 */
export function ompPromptPath(relative: string): string {
	return path.join(path.dirname(path.dirname(fs.realpathSync(Bun.main))), "src", "prompts", relative);
}

/** An omp prompt template (see `ompPromptPath`). */
export function ompPrompt(relative: string): string {
	const cached = promptCache.get(relative);
	if (cached !== undefined) return cached;
	let text: string;
	try {
		text = fs.readFileSync(ompPromptPath(relative), "utf8");
	} catch (error) {
		throw new Error(`This omp install has no prompt ${relative} (${errorMessage(error)})`);
	}
	promptCache.set(relative, text);
	return text;
}

type SessionListener = (event: AgentSessionEvent, session: AgentSession) => void;
type SwitchListener = (reason: string) => void;

const sessionListeners = new Set<SessionListener>();
const switchListeners = new Set<SwitchListener>();
const subscribed = new WeakSet<AgentSession>();
let extensionHooked = false;
let attachedEnv: BridgeEnv | undefined;

/** Live session events, for every session a modes call has attached to. */
export function onSessionEvent(listener: SessionListener): void {
	sessionListeners.add(listener);
}

/** The session was replaced in place (`new`, `resume`, `fork`). */
export function onSessionSwitch(listener: SwitchListener): void {
	switchListeners.add(listener);
}

/** The live session, with the modes subscriptions attached. */
export function attach(env: BridgeEnv): AgentSession {
	attachedEnv = env;
	if (!extensionHooked) {
		extensionHooked = true;
		env.pi.on("session_switch", event => {
			for (const listener of switchListeners) listener(event.reason);
		});
	}
	const session = env.session();
	if (!subscribed.has(session)) {
		subscribed.add(session);
		session.subscribe(event => {
			for (const listener of sessionListeners) listener(event, session);
		});
	}
	return session;
}
