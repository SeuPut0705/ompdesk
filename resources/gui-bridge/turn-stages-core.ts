/**
 * Where a turn's time went before the model answered, kept in memory and written only when it matters.
 *
 * Why (28 Oct 2026, this Mac, 14:42-14:54: a main session sat on "thinking" for six minutes twice with no error and
 * no retry): nothing recorded which stage the turn was in. This notes a timestamp per stage from stock's own events
 * (the `input` hook, `before_agent_start` handlers, session events, `before_provider_request`,
 * `after_provider_response`) and OMPdesk's own slow spots (memory recall, prompt sections). It changes nothing, arms
 * no timer and aborts nothing: a normal turn costs a few array writes and sends no frame.
 *
 * One frame per model call, only when
 * - its first output (the first `message_update` of the assistant message) came more than `lateMs` after the wait
 *   began (the prompt for a run's first call, its `turn_start` for the calls after a tool batch), sent as that output
 *   arrives, or
 * - the run ended (`agent_end`) aborted or errored with the call having produced nothing.
 * A stall that never ends (the process killed first) writes nothing: no timer watches for it.
 *
 * No omp imports (not even types): the GUI's vitest drives it with plain events.
 */
import {
	LATE_FIRST_OUTPUT_MS,
	TURN_STAGES_EVENT,
	type TurnSlowSpot,
	type TurnStageName,
	type TurnStagesDetails,
	type TurnStagesFrame,
} from "./turn-stages-contracts";

/** A prompt that arrived this long ago and started no run is not this run's prompt (a slash command ran locally). */
const PENDING_PROMPT_MAX_MS = 10 * 60_000;
const ERROR_MAX = 300;
/** Stages of the run as a whole (`Mark.call`); every other stage belongs to the model call it came in. */
const RUN_LEVEL = -1;
/** A stage that comes more than once keeps its first time; the rest keep their last. */
const FIRST_TIME: Partial<Record<TurnStageName, true>> = { handlers_start: true, agent_start: true, compaction: true };

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
	/** The wait began at a typed prompt (`input`), not at the run's first event. */
	viaPrompt: boolean;
	/** `agent_start` came: provider hooks before it belong to side requests (compaction, memory judge), not this run's call. */
	started: boolean;
	marks: Mark[];
	spots: Map<TurnSlowSpot, number>;
	call: Call;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function isAssistant(message: unknown): boolean {
	return record(message)?.role === "assistant";
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
	#pendingPrompt: number | undefined;
	#run: Run | undefined;

	constructor(options: TurnStagesOptions) {
		this.#emit = options.emit;
		this.#now = options.now ?? Date.now;
		this.#lateMs = options.lateMs ?? LATE_FIRST_OUTPUT_MS;
		this.#model = options.model ?? (() => undefined);
	}

	/**
	 * Stock's `input` hook: a prompt reached the session. A steer or follow-up (the session is streaming) and a slash
	 * command (it may run locally and start nothing) never begin a wait; a run they start counts from its own first event.
	 */
	promptReceived(text: string, streaming: boolean): void {
		if (streaming || text.trimStart().startsWith("/")) return;
		this.#pendingPrompt = this.#now();
	}

	/** Entering stock's `before_agent_start` handlers (every extension's). Only a run not yet started takes them. */
	handlersStart(): void {
		const run = this.#ensureRun();
		if (!run.started) this.#mark(run, "handlers_start", RUN_LEVEL);
	}

	handlersEnd(): void {
		const run = this.#run;
		if (run && !run.started) this.#mark(run, "handlers_end", RUN_LEVEL);
	}

	/** Stock's `before_provider_request` hook. */
	providerRequest(): void {
		const run = this.#run;
		if (!run?.started) return;
		run.call.requests++;
		this.#mark(run, "provider_request", run.call.index);
	}

	/** Stock's `after_provider_response` hook. */
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
				// A pre-prompt compaction can run before any handler did: a prompt in flight opens the run for it.
				const run = this.#run ?? (this.#freshPrompt() === undefined ? undefined : this.#ensureRun());
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

	#mark(run: Run, name: TurnStageName, call: number): void {
		run.marks.push({ name, at: this.#now(), call });
	}

	#freshPrompt(): number | undefined {
		const at = this.#pendingPrompt;
		return at !== undefined && this.#now() - at <= PENDING_PROMPT_MAX_MS ? at : undefined;
	}

	#ensureRun(): Run {
		if (this.#run) return this.#run;
		const prompt = this.#freshPrompt();
		this.#pendingPrompt = undefined;
		const t0 = prompt ?? this.#now();
		this.#run = {
			t0,
			viaPrompt: prompt !== undefined,
			started: false,
			marks: [],
			spots: new Map(),
			call: newCall(0, t0),
		};
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
		this.#pendingPrompt = undefined;
		if (!run || run.call.reported || run.call.output) return;
		const messages = record(event)?.messages;
		const reply = record(Array.isArray(messages) ? messages.findLast(isAssistant) : undefined);
		const stop = reply?.stopReason;
		if (stop !== "aborted" && stop !== "error") return;
		run.call.reported = true;
		this.#emit(this.#frame(run, run.call, stop, "agent_end", this.#now(), reply));
	}

	#frame(
		run: Run,
		call: Call,
		outcome: "late" | "aborted" | "error",
		endStage: "first_output" | "agent_end",
		endAt: number,
		reply: Record<string, unknown> | undefined,
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
		const error = typeof reply?.errorMessage === "string" ? oneLine(reply.errorMessage, ERROR_MAX) : undefined;

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
		if (provider) details.provider = provider;
		if (modelId) details.model = modelId;
		if (error) details.error = error;
		for (const [spot, ms] of run.spots) details[spot] = Math.round(ms);
		for (const { name, at } of ordered) details[`at.${name}`] = at - run.t0;

		const where = `last stage ${before}, longest wait ${longest.from} > ${longest.to} (${seconds(longest.ms)})`;
		const start = run.viaPrompt || call.index > 0 ? "" : " (no prompt seen: counted from the run's first event)";
		const message =
			outcome === "late"
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
