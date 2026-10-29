/**
 * Where a turn's time went before the model answered, kept in memory and written only when it matters.
 *
 * Why (28 Oct 2026, this Mac, 14:42-14:54: a main session sat on "thinking" for six minutes twice with no error and
 * no retry): nothing recorded which stage the turn was in. This notes a timestamp per stage from stock's own events
 * (the `input` hook, the session's `prompt` call, `before_agent_start` handlers, session events, the payload and
 * response callbacks of the main loop's own provider requests) and OMPdesk's own slow spots (memory recall, prompt
 * sections).
 * It changes nothing, arms no timer and aborts nothing: a normal turn costs a few array writes and sends no frame.
 *
 * One frame per model call, only when
 * - its first output (the first `message_update` of the assistant message) came more than `lateMs` after the wait
 *   began (the prompt for a run's first call, its `turn_start` for the calls after a tool batch), sent as that output
 *   arrives, or
 * - the run ended (`agent_end`) aborted or errored with the call having produced nothing, or
 * - a prompt's setup ended (its `prompt` call returned or threw) more than `lateMs` after the prompt without starting a
 *   run: stock's Stop, a newer prompt or a refusal before `agent_start` emits no agent event at all.
 * A stall that never ends (the process killed first) writes nothing: no timer watches for it.
 *
 * A wait counts from its prompt only inside that prompt's own `prompt` call (`promptStarted` .. `promptSettled`); a run
 * that starts outside one (a queued follow-up, a continue, a retry) counts from its own first event. Every state a
 * prompt leaves behind is dropped when the next prompt comes, so nothing of one prompt reaches another.
 *
 * No omp imports (not even types): the GUI's vitest drives it with plain events.
 */
import {
	LATE_FIRST_OUTPUT_MS,
	type ModelRequestPhase,
	TURN_STAGES_EVENT,
	TURN_STAGES_MAX_DETAILS,
	type TurnSlowSpot,
	type TurnStageName,
	type TurnStagesDetails,
	type TurnStagesFrame,
} from "./turn-stages-contracts";

/** The `input` hook's time is taken for the `prompt` call with the same text only if it came this recently. */
const PENDING_PROMPT_MAX_MS = 10 * 60_000;
const ERROR_MAX = 300;
/** Stages of the run as a whole (`Mark.call`); every other stage belongs to the model call it came in. */
const RUN_LEVEL = -1;
/**
 * A stage that comes more than once keeps its first time; the rest keep their last. `provider_request`: stock's
 * Anthropic provider sends a rebuilt body again inside the same call after some 400s, and the wait for the first
 * answer is the provider's, not a stall before the request.
 */
const FIRST_TIME: Partial<Record<TurnStageName, true>> = {
	handlers_start: true,
	agent_start: true,
	compaction: true,
	provider_request: true,
};

/** The slice of a stock session event read here; every stock event has a `type`. */
export interface TurnSessionEvent {
	type: string;
}

export interface TurnModel {
	provider?: string;
	id?: string;
}

export interface TurnStagesOptions {
	emit(frame: TurnStagesFrame): void;
	now?(): number;
	lateMs?: number;
	/** The session's current model, read when a line is built. */
	model?(): TurnModel | undefined;
}

/** One `prompt` call of the session, from its start until it returns: the wait its first run counts from. */
export interface PromptSetup {
	t0: number;
	/** A slash command: it may run locally and start nothing, so its end without a run is no stall. */
	command: boolean;
	/** A run started inside it; runs after that count from their own first event. */
	ran: boolean;
}

/** One stage reached, in arrival order (which breaks ties between stages in the same millisecond). */
interface Mark {
	name: TurnStageName;
	at: number;
	call: number;
}

interface Call {
	index: number;
	/** When this call's wait began: the prompt for call 0, its `turn_start` after that. */
	waitStart: number;
	turnStarted: boolean;
	output: boolean;
	requests: number;
	reported: boolean;
}

interface Run {
	t0: number;
	/** The wait began at a prompt, not at the run's first event. */
	viaPrompt: boolean;
	/** `agent_start` came: provider hooks before it belong to side requests (compaction, memory judge), not this run's call. */
	started: boolean;
	marks: Mark[];
	spots: Map<TurnSlowSpot, number>;
	call: Call;
}

type Outcome = "late" | "aborted" | "error" | "cancelled";
type EndStage = "first_output" | "agent_end" | "setup_end";

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function isAssistant(message: unknown): boolean {
	return record(message)?.role === "assistant";
}

function isCommand(text: string): boolean {
	return text.trimStart().startsWith("/");
}

function newCall(index: number, waitStart: number): Call {
	return { index, waitStart, turnStarted: false, output: false, requests: 0, reported: false };
}

function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function seconds(ms: number): string {
	return `${(ms / 1000).toFixed(1)} s`;
}

export class TurnStageRecorder {
	readonly #emit: (frame: TurnStagesFrame) => void;
	readonly #now: () => number;
	readonly #lateMs: number;
	readonly #model: () => TurnModel | undefined;
	#pendingPrompt: { at: number; text: string } | undefined;
	#setup: PromptSetup | undefined;
	#run: Run | undefined;

	constructor(options: TurnStagesOptions) {
		this.#emit = options.emit;
		this.#now = options.now ?? Date.now;
		this.#lateMs = options.lateMs ?? LATE_FIRST_OUTPUT_MS;
		this.#model = options.model ?? (() => undefined);
	}

	/**
	 * Stock's `input` hook: a prompt reached the session (it runs before the session's `prompt` call, whose wait then
	 * counts from here). A steer or follow-up (the session is streaming) and a slash command are no new prompt.
	 */
	promptReceived(text: string, streaming: boolean): void {
		if (streaming || isCommand(text)) return;
		this.#dropUnstarted();
		this.#pendingPrompt = { at: this.#now(), text };
	}

	/**
	 * The session's `prompt` call began. While the session streams it only queues (a steer or follow-up): undefined,
	 * nothing tracked. Otherwise anything an earlier prompt left unstarted is dropped and this call's wait begins, at
	 * the `input` hook of the same text if one came.
	 */
	promptStarted(text: string, streaming: boolean): PromptSetup | undefined {
		if (streaming) return undefined;
		const now = this.#now();
		const pending = this.#pendingPrompt;
		this.#pendingPrompt = undefined;
		this.#dropUnstarted();
		const claimed = pending && pending.text === text && now - pending.at <= PENDING_PROMPT_MAX_MS;
		this.#setup = { t0: claimed ? pending.at : now, command: isCommand(text), ran: false };
		return this.#setup;
	}

	/**
	 * The `prompt` call `setup` returned (or threw `error`). Without a run started inside it, its setup ended before
	 * `agent_start` (stock's Stop, a newer prompt, a refusal, a failure): a line when that took longer than `lateMs`.
	 */
	promptSettled(setup: PromptSetup | undefined, error?: unknown): void {
		if (!setup || this.#setup !== setup) return;
		this.#setup = undefined;
		if (setup.ran) return;
		const run = this.#run && !this.#run.started ? this.#run : undefined;
		this.#run = undefined;
		const now = this.#now();
		if (setup.command || now - setup.t0 <= this.#lateMs) return;
		const ended = run ?? this.#newRun(setup.t0, true);
		const reason = error === undefined ? undefined : error instanceof Error ? error.message : String(error);
		this.#emit(this.#frame(ended, ended.call, error === undefined ? "cancelled" : "error", "setup_end", now, reason));
	}

	/**
	 * Entering stock's `before_agent_start` handlers (every extension's). Only a run not yet started takes them. A run
	 * whose handlers already ended belongs to setup that went no further (a queued message's, cancelled), unless the
	 * same `prompt` call runs them again (stock re-runs them when the tool set changed meanwhile).
	 */
	handlersStart(): void {
		const run = this.#run;
		const sameSetup = this.#setup !== undefined && !this.#setup.ran;
		if (run && !run.started && !sameSetup && run.marks.some(mark => mark.name === "handlers_end")) {
			this.#run = undefined;
		}
		const current = this.#ensureRun();
		if (!current.started) this.#mark(current, "handlers_start", RUN_LEVEL);
	}

	handlersEnd(): void {
		const run = this.#run;
		if (run && !run.started) this.#mark(run, "handlers_end", RUN_LEVEL);
	}

	/** A provider request of the main loop's own model call went out (its payload callback). */
	providerRequest(): void {
		const run = this.#run;
		if (!run?.started) return;
		run.call.requests++;
		this.#mark(run, "provider_request", run.call.index);
	}

	/** That request's response headers arrived (its response callback). */
	providerResponse(): void {
		const run = this.#run;
		if (run?.started) this.#mark(run, "provider_response", run.call.index);
	}

	/** Time OMPdesk itself spent in a handler of this wait; added up over the run. */
	note(spot: TurnSlowSpot, ms: number): void {
		const run = this.#run;
		if (!run || run.started || !(ms > 0)) return;
		run.spots.set(spot, (run.spots.get(spot) ?? 0) + ms);
	}

	/** Every event of the main session's `subscribe`. */
	sessionEvent(event: TurnSessionEvent): void {
		switch (event.type) {
			case "message_update":
				this.#output(event);
				return;
			case "agent_start": {
				const run = this.#ensureRun();
				run.started = true;
				if (this.#setup) this.#setup.ran = true;
				this.#mark(run, "agent_start", RUN_LEVEL);
				return;
			}
			case "turn_start": {
				const run = this.#run;
				if (!run?.started) return;
				if (run.call.turnStarted) {
					run.call = newCall(run.call.index + 1, this.#now());
					// A long run keeps the marks of the call it is in and of the run, not of every call before.
					run.marks = run.marks.filter(mark => mark.call === RUN_LEVEL);
				}
				run.call.turnStarted = true;
				this.#mark(run, "turn_start", run.call.index);
				return;
			}
			case "message_start": {
				const run = this.#run;
				if (run?.started && isAssistant(record(event)?.message)) this.#mark(run, "stream_open", run.call.index);
				return;
			}
			case "auto_compaction_start": {
				// A compaction of a prompt's setup (before its handlers or after them) opens that prompt's run.
				const run = this.#run ?? (this.#setup && !this.#setup.ran ? this.#ensureRun() : undefined);
				if (run) this.#mark(run, "compaction", RUN_LEVEL);
				return;
			}
			case "auto_compaction_end":
				if (this.#run) this.#mark(this.#run, "compaction_end", RUN_LEVEL);
				return;
			case "agent_end":
				this.#end(event);
				return;
		}
	}

	#dropUnstarted(): void {
		if (this.#run && !this.#run.started) this.#run = undefined;
	}

	#mark(run: Run, name: TurnStageName, call: number): void {
		run.marks.push({ name, at: this.#now(), call });
	}

	#newRun(t0: number, viaPrompt: boolean): Run {
		return { t0, viaPrompt, started: false, marks: [], spots: new Map(), call: newCall(0, t0) };
	}

	/** The run in progress, or a new one: from its prompt inside that prompt's `prompt` call, else from now. */
	#ensureRun(): Run {
		if (this.#run) return this.#run;
		const setup = this.#setup && !this.#setup.ran ? this.#setup : undefined;
		this.#run = this.#newRun(setup?.t0 ?? this.#now(), setup !== undefined);
		return this.#run;
	}

	#output(event: TurnSessionEvent): void {
		const run = this.#run;
		if (!run?.started || run.call.output || !isAssistant(record(event)?.message)) return;
		const call = run.call;
		call.output = true;
		this.#mark(run, "first_output", call.index);
		const at = this.#now();
		if (at - call.waitStart <= this.#lateMs || call.reported) return;
		call.reported = true;
		this.#emit(this.#frame(run, call, "late", "first_output", at, undefined));
	}

	#end(event: TurnSessionEvent): void {
		const run = this.#run;
		this.#run = undefined;
		if (!run || run.call.reported || run.call.output) return;
		const messages = record(event)?.messages;
		const reply = record(Array.isArray(messages) ? messages.findLast(isAssistant) : undefined);
		const stop = reply?.stopReason;
		if (stop !== "aborted" && stop !== "error") return;
		run.call.reported = true;
		const error = typeof reply?.errorMessage === "string" ? reply.errorMessage : undefined;
		this.#emit(this.#frame(run, run.call, stop, "agent_end", this.#now(), error, reply));
	}

	#frame(
		run: Run,
		call: Call,
		outcome: Outcome,
		endStage: EndStage,
		endAt: number,
		errorText: string | undefined,
		reply?: Record<string, unknown>,
	): TurnStagesFrame {
		// This wait's stages: the run's and the call's own, from where the wait began, one time per stage.
		const chosen = new Map<TurnStageName, { at: number; order: number }>();
		run.marks.forEach((mark, order) => {
			if ((mark.call !== RUN_LEVEL && mark.call !== call.index) || mark.at < call.waitStart) return;
			if (mark.name === endStage) return;
			if (FIRST_TIME[mark.name] && chosen.has(mark.name)) return;
			chosen.set(mark.name, { at: mark.at, order });
		});
		const ordered = [...chosen]
			.map(([name, stage]) => ({ name: name as string, ...stage }))
			.sort((a, b) => a.at - b.at || a.order - b.order);
		ordered.push({ name: endStage, at: endAt, order: Number.POSITIVE_INFINITY });

		const origin = call.index === 0 ? "prompt" : "previous_turn";
		let from = { name: origin, at: call.waitStart };
		let longest = { from: origin, to: endStage as string, ms: -1 };
		for (const point of ordered) {
			if (point.at - from.at > longest.ms) longest = { from: from.name, to: point.name, ms: point.at - from.at };
			from = point;
		}
		const before = ordered.length > 1 ? ordered[ordered.length - 2].name : origin;
		const waited = endAt - call.waitStart;
		const model = this.#model();
		const provider = typeof reply?.provider === "string" ? reply.provider : model?.provider;
		const modelId = typeof reply?.model === "string" ? reply.model : model?.id;

		// What says where the time went comes first and always fits; the rest fills the log's key limit in order.
		const details: TurnStagesDetails = {
			level: "warn",
			outcome,
			call: call.index,
			waitedMs: waited,
			lastStage: before,
			longestGap: `${longest.from}>${longest.to} ${longest.ms}ms`,
			providerRequestSent: call.requests > 0,
			providerRequests: call.requests,
		};
		for (const { name, at } of ordered) details[`at.${name}`] = at - run.t0;
		const optional: Array<[string, string | number | undefined]> = [
			["error", errorText === undefined ? undefined : oneLine(errorText, ERROR_MAX)],
			["provider", provider],
			["model", modelId],
			...[...run.spots].map(([spot, ms]): [string, number] => [spot, Math.round(ms)]),
		];
		for (const [key, value] of optional) {
			if (value === undefined || value === "" || Object.keys(details).length >= TURN_STAGES_MAX_DETAILS) continue;
			details[key] = value;
		}

		const where = `last stage ${before}, longest wait ${longest.from} > ${longest.to} (${seconds(longest.ms)})`;
		const start = run.viaPrompt || call.index > 0 ? "" : " (no prompt seen: counted from the run's first event)";
		const message =
			endStage === "setup_end"
				? `Prompt setup ended after ${seconds(waited)} without starting the model run (Stop, a newer prompt, a refusal or a failure): ${where}`
				: outcome === "late"
					? `First model output came ${seconds(waited)} after ${origin === "prompt" ? "the prompt" : "the model call began"}: ${where}${start}`
					: `Turn ${outcome} with no model output after ${seconds(waited)}: ${where}${start}`;
		return { type: TURN_STAGES_EVENT, message, details };
	}
}

/** The recorder this bridge process feeds; set by turn-stages.ts, read by the modules that note their own slow spots. */
let active: TurnStageRecorder | undefined;

export function setActiveRecorder(recorder: TurnStageRecorder | undefined): void {
	active = recorder;
}

/** OMPdesk's own handler time inside the current wait (a no-op outside one, and while the feature is not installed). */
export function noteSlowSpot(spot: TurnSlowSpot, ms: number): void {
	active?.note(spot, ms);
}

const STREAM_WRAPPED = Symbol.for("ompdesk.turn-stages.stream");
type Callback = (...args: unknown[]) => unknown;
interface StreamOptions {
	onPayload?: Callback;
	onResponse?: Callback;
}

/** A response the provider can stream from: an error status (429, 5xx, a 400 stock rebuilds for) is no answer. */
function answers(response: unknown): boolean {
	const status = record(response)?.status;
	return typeof status !== "number" || status < 400;
}

/**
 * Feeds `recorder` the main loop's own provider requests, and `signal` the working cue's two moments of each:
 * wraps `agent.streamFn` once on that instance (turn-stages.ts passes the main session's agent). Stock's agent loop
 * calls it for its model calls only (stock's comment in `sdk.ts`: advisors and the session's side calls use their
 * own), so the payload callback of its options is a request of this call (`sent`) and the response callback its
 * headers (`answered` unless the status is an error); both are handed on unchanged. The shared
 * `before_provider_request` and `after_provider_response` hooks are not: stock runs them for those side requests
 * too, as the main agent. Why (28-29 Oct 2026, this Mac): 21 lines named a gap from `turn_start` with 2-12 requests
 * in one call, three of them a response before the request; a side request had replaced the main request's time while
 * that request waited minutes for Anthropic's answer. An agent without `streamFn` is left alone (those two stages
 * and the cue's signals are then missing).
 */
export function wrapStreamFn(
	agent: unknown,
	recorder: TurnStageRecorder,
	signal: (phase: ModelRequestPhase) => void,
): void {
	const target = agent as Record<string | symbol, unknown> | undefined;
	const original = target?.streamFn;
	if (!target || target[STREAM_WRAPPED] || typeof original !== "function") return;
	target[STREAM_WRAPPED] = true;
	target.streamFn = function streamFn(this: unknown, model: unknown, context: unknown, options?: StreamOptions) {
		const onPayload = options?.onPayload;
		const onResponse = options?.onResponse;
		return (original as Callback).call(this, model, context, {
			...options,
			onPayload: (...args: unknown[]) => {
				recorder.providerRequest();
				signal("sent");
				return onPayload?.(...args);
			},
			onResponse: (...args: unknown[]) => {
				recorder.providerResponse();
				if (answers(args[0])) signal("answered");
				return onResponse?.(...args);
			},
		});
	};
}
