/**
 * Loop mode for the GUI: re-submit the loop prompt after every turn. Port of the
 * TUI loop (`handleLoopCommand`, `#runLoopIteration`, `#submitLoopPromptWhenReady`,
 * `pauseLoop`) on stock's own parser and condition runner (`modes/loop-limit`,
 * `modes/loop-condition`), so `/loop` arguments, `--while`/`--until` and the
 * `loop.mode` action behave exactly as in the terminal.
 *
 * It lives in the sidecar, not the GUI's main process, because it must see what
 * main cannot: every host prompt (the RPC `input` hook), each turn's end and
 * whether it was aborted (session events), and in-place session changes.
 *
 * - Every non-slash host prompt while enabled becomes the loop prompt and un-pauses.
 * - An aborted turn pauses the loop (TUI Esc): the prompt is dropped, the mode stays on.
 * - Any session change the loop did not start itself (`reset` action) disables it.
 * Kept: stock InteractiveMode owns the private TUI loop scheduler; its
 * exported parser/condition helpers cannot supply the GUI event lifecycle.
 */
import type { LoopConditionConfig, LoopLimitRuntime } from "@oh-my-pi/pi-tui/status-line/loop";
import type { LoopConditionVerdict } from "@oh-my-pi/pi-coding-agent/modes/loop-condition";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { guard } from "../health";
import type { BridgeMethods } from "../types";
import { attach, emit, errorMessage, onHostInput, onSessionEvent, onSessionSwitch, record } from "./shared";

/** Grace period between iterations (the TUI's Esc window). */
const ITERATION_DELAY_MS = 800;

let enabled = false;
let paused = false;
let loopPrompt: string | undefined;
let limit: LoopLimitRuntime | undefined;
let condition: LoopConditionConfig | undefined;
let timer: NodeJS.Timeout | undefined;
let conditionAbort: AbortController | undefined;
/** The loop's own `reset` is starting a new session: not a reason to stop. */
let resetting = false;
let loopSession: AgentSession | undefined;

function loopState() {
	return {
		enabled,
		state: !enabled ? "off" : paused ? "paused" : loopPrompt ? "running" : "waiting",
		prompt: loopPrompt,
		limit,
	};
}

function publish(): void {
	emit({ type: "loop_mode_update", state: loopState() });
}

function cancelTimer(): void {
	clearTimeout(timer);
	timer = undefined;
}

function abortCondition(): void {
	conditionAbort?.abort();
	conditionAbort = undefined;
}

function disable(message?: string): void {
	const wasEnabled = enabled;
	enabled = false;
	paused = false;
	loopPrompt = undefined;
	limit = undefined;
	condition = undefined;
	cancelTimer();
	abortCondition();
	if (!wasEnabled) return;
	publish();
	if (message) emit({ type: "notice", level: "info", message, source: "loop" });
}

function pause(): void {
	if (!enabled) return;
	loopPrompt = undefined;
	paused = true;
	cancelTimer();
	abortCondition();
	publish();
}

function setLoopPrompt(text: string): void {
	if (!enabled) return;
	// A new prompt supersedes any condition still gating the previous iteration.
	abortCondition();
	loopPrompt = text;
	paused = false;
	publish();
}

function isBlocked(session: AgentSession): boolean {
	return session.isStreaming || session.isCompacting || session.hasPostPromptWork;
}

function fail(error: unknown): void {
	disable(`Loop failed: ${errorMessage(error)}. Loop mode disabled.`);
}

function defer(step: () => Promise<void>): void {
	cancelTimer();
	timer = setTimeout(() => {
		timer = undefined;
		if (enabled) void step().catch(fail);
	}, ITERATION_DELAY_MS);
}

function dispatch(session: AgentSession, text: string): void {
	void session.prompt(text, { streamingBehavior: "followUp" }).catch(error => {
		emit({ type: "notice", level: "error", message: `Loop turn failed: ${errorMessage(error)}`, source: "loop" });
	});
}

function vibeBlocksReset(session: AgentSession, action: string): boolean {
	if (action !== "reset" || !session.getVibeModeState()?.enabled) return false;
	disable("Exit vibe mode before using reset loops. Loop mode disabled.");
	return true;
}

/** Whether the `--while`/`--until` condition lets another iteration run (TUI `#passesLoopCondition`). */
async function passesCondition(session: AgentSession, text: string): Promise<boolean> {
	const gate = condition;
	if (!gate) return true;
	const { evaluateLoopCondition } = await import("@oh-my-pi/pi-coding-agent/modes/loop-condition");
	const { cfgLoopConditionTimeoutMs } = await import("@oh-my-pi/pi-coding-agent/modes/settings");
	abortCondition();
	const controller = new AbortController();
	conditionAbort = controller;
	let verdict: LoopConditionVerdict;
	try {
		verdict = await evaluateLoopCondition(gate, {
			cwd: session.sessionManager.getCwd(),
			timeoutMs: cfgLoopConditionTimeoutMs.get(session.settings),
			signal: controller.signal,
			sessionId: session.sessionManager.getSessionId(),
		});
	} finally {
		if (conditionAbort === controller) conditionAbort = undefined;
	}
	// Pause, disable or a new prompt can land while the command runs.
	if (!enabled || loopPrompt !== text) return false;
	if (verdict.kind === "continue") return true;
	if (verdict.kind !== "aborted") disable(verdict.message);
	return false;
}

async function submitWhenReady(session: AgentSession, text: string): Promise<void> {
	if (!enabled || loopPrompt !== text) return;
	const { isLoopDurationExpired } = await import("@oh-my-pi/pi-coding-agent/modes/loop-limit");
	if (isLoopDurationExpired(limit)) {
		disable("Loop time limit reached. Loop mode disabled.");
		return;
	}
	if (isBlocked(session)) {
		defer(() => submitWhenReady(session, text));
		return;
	}
	dispatch(session, text);
}

async function runIteration(session: AgentSession, action: string, text: string): Promise<void> {
	if (!enabled || loopPrompt !== text) return;
	if (isBlocked(session)) {
		defer(() => runIteration(session, action, text));
		return;
	}
	if (vibeBlocksReset(session, action)) return;
	const { consumeLoopLimitIteration, isLoopLimitExhausted } = await import(
		"@oh-my-pi/pi-coding-agent/modes/loop-limit"
	);
	// An exhausted budget ends the loop before the condition command runs one last time for nothing.
	if (isLoopLimitExhausted(limit)) {
		disable("Loop limit reached. Loop mode disabled.");
		return;
	}
	if (!(await passesCondition(session, text))) return;
	// The condition awaited a child process; a turn may have started meanwhile.
	if (isBlocked(session)) {
		defer(() => runIteration(session, action, text));
		return;
	}
	if (vibeBlocksReset(session, action)) return;
	if (!consumeLoopLimitIteration(limit)) {
		disable("Loop limit reached. Loop mode disabled.");
		return;
	}
	publish();
	try {
		if (action === "compact") {
			await session.compact();
		} else if (action === "reset") {
			resetting = true;
			try {
				await session.newSession();
			} finally {
				resetting = false;
			}
		}
	} catch (error) {
		disable(`Loop ${action} failed: ${errorMessage(error)}. Loop mode disabled.`);
		return;
	}
	await submitWhenReady(session, text);
}

async function onTurnEnd(event: AgentSessionEvent, session: AgentSession): Promise<void> {
	if (event.type !== "agent_end" || event.isTerminal === false || !enabled || session !== loopSession) return;
	const last = event.messages.at(-1);
	if (last?.role === "assistant" && last.stopReason === "aborted") {
		pause();
		return;
	}
	if (!loopPrompt) return;
	const text = loopPrompt;
	const { cfgLoopMode } = await import("@oh-my-pi/pi-coding-agent/modes/settings");
	const action = cfgLoopMode.get(session.settings);
	defer(() => runIteration(session, action, text));
}

onSessionEvent((event, session) => {
	void onTurnEnd(event, session).catch(fail);
});

onHostInput(text => {
	// Slash commands (`/compact`, `/btw …`) are never the thing being looped.
	if (!text.trim().startsWith("/")) setLoopPrompt(text);
});

onSessionSwitch(() => {
	if (!resetting) disable("Session changed. Loop mode disabled.");
});

async function enable(session: AgentSession, args: string): Promise<void> {
	const { createLoopLimitRuntime, parseLoopArgs } = await import("@oh-my-pi/pi-coding-agent/modes/loop-limit");
	const parsed = parseLoopArgs(args);
	if (typeof parsed === "string") throw new Error(parsed);
	enabled = true;
	paused = false;
	loopPrompt = undefined;
	limit = createLoopLimitRuntime(parsed.limit);
	condition = parsed.condition;
	loopSession = session;
	publish();
	// The first iteration always runs; the condition gates the ones after it.
	if (parsed.prompt) {
		setLoopPrompt(parsed.prompt);
		dispatch(session, parsed.prompt);
	}
}

export const methods: BridgeMethods = guard("loopMode", {
	"modes.get_loop_mode": async (_params, env) => {
		attach(env);
		return loopState();
	},
	"modes.set_loop_mode": async (params, env) => {
		const session = attach(env);
		const { enabled: wanted, args } = record(params);
		if (wanted !== true) disable();
		else if (!enabled) await enable(session, typeof args === "string" ? args : "");
		return loopState();
	},
});
