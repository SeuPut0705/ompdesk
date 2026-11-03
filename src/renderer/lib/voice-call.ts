/**
 * A hands-free voice conversation with the bot: the mic stays open for the whole call, an energy VAD cuts it into
 * utterances, each one is transcribed (the dictation pipeline) and sent to the bot's tab, and the bot's reply is spoken
 * (the auto-speak "yield" rule: the run's last assistant text). Talking over the reply stops it at once (barge-in).
 *
 * Shape: {@link nextPhase} is the pure state machine (what the call is doing and what it holds back); {@link VoiceActivity}
 * is the pure-ish VAD (levels in, speech signals out); {@link startVoiceCall} wires both to the mic, the recorder, the
 * RPCs and the tab's stores and runs the effects of each transition.
 *
 * Streaming: when the omp answers the bridge's `stt_stream_*` / `tts_stream_*` commands, an utterance is transcribed while
 * it is spoken (16 kHz PCM frames from the mic's script processor, every ~200 ms, the running text shown as it comes), the
 * call listens again the moment the speech ends (the stop resolves in the background, and results are sent in utterance
 * order; until it does, `finishing` counts it and the bar says it is transcribing), and a reply starts playing at its
 * first synthesized chunk. A model with no running text (Whisper: the bridge transcribes it once, at the stop) answers
 * every frame with no words. An omp without them answers `unsupported_omp` /
 * unknown-command at the first start and the call uses the whole-clip path for the rest of its life: a MediaRecorder per
 * utterance transcribed once it ended (the VAD is off meanwhile, so speech in that gap is not heard) and a reply played
 * once fully synthesized.
 */
import { parseBotSources } from "../../shared/bot-sources";
import type { AgentMessage } from "../../shared/rpc-types";
import { useMessagesStore } from "../stores/messages";
import { useSessionStore } from "../stores/session";
import { sessionRuntimeStore } from "../stores/session-runtime-context";
import { messageText } from "./messages";
import {
	classifyMicError,
	type DictationFailure,
	type DictationResult,
	METER_BARS,
	playSpeech,
	setVoiceCallActive,
	speechBandLevels,
	transcribeBlob,
} from "./voice";
import {
	createPcmTap,
	ompVoiceStreams,
	type PcmTap,
	playSpeechStream,
	prepareRecognition,
	type StreamSpeechPlayback,
	SttStream,
	type VoiceStreams,
} from "./voice-stream";

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

/** `preparing`: the speech model the conversation's language needs is downloading; the mic opens once it is here. */
export type CallPhase =
	| "starting"
	| "preparing"
	| "listening"
	| "hearing"
	| "transcribing"
	| "waiting"
	| "speaking"
	| "ended";

/**
 * A failed mic or transcription (as dictation names them), a reply that could not be played, or (`recognition`) the
 * speech model the language needs could not be downloaded, so the call hears it on the selected dictation model.
 */
export type CallError = DictationFailure | "speak" | "recognition";

export interface CallState {
	readonly phase: CallPhase;
	readonly muted: boolean;
	/** The bot has a turn running, or the person's last words were just sent to it. */
	readonly busy: boolean;
	/** The last words the person said that were heard (not blank). */
	readonly heard: string;
	/** What the person is saying right now, as far as the running transcription has it (blank: nothing yet). */
	readonly partial: string;
	/**
	 * Streamed utterances whose final text has not come back: the call listens on meanwhile. A model with no running
	 * text (Whisper) is transcribed only now, so this is when the bar says it is transcribing.
	 */
	readonly finishing: number;
	/** A reply held back while the person talks; spoken when they stop. */
	readonly pending: string | null;
	/** The reply being spoken now (set on entering `speaking`). */
	readonly playing: string | null;
	/** Why the call ended (fatal), or what went wrong with the last utterance or reply (the call goes on). */
	readonly error?: CallError;
	/** The language the call hears (a code), once the bridge named it; null before or when none is set. */
	readonly language: string | null;
	/** How far the speech model's download got (0–100) while `preparing`; null otherwise. */
	readonly preparing: number | null;
}

export type CallEvent =
	| { type: "micReady" }
	/** The speech model for `language` is downloading. */
	| { type: "preparing"; language: string | null; percent: number }
	/** It could not be downloaded: the call goes on with the selected dictation model. */
	| { type: "recognitionFailed"; language: string | null }
	| { type: "speechStart" }
	/** `streamed`: the words are transcribed on a stream that goes on after this, so the call listens again at once instead of waiting in `transcribing`. */
	| { type: "speechEnd"; streamed?: boolean }
	/** The utterance was too short to be speech. */
	| { type: "speechDropped" }
	| { type: "transcript"; text: string }
	/** The words of a streamed utterance (blank: none) whenever its transcription settles: unlike `transcript` it lands in any phase. */
	| { type: "streamTranscript"; text: string }
	/** The running text of the utterance being heard. */
	| { type: "partial"; text: string }
	/** The words never reached the bot. */
	| { type: "sendFailed" }
	/** The bot's turn began. */
	| { type: "replyStarted" }
	/** The bot's turn ended; `text` is what it said last (blank: nothing to speak). */
	| { type: "reply"; text: string }
	| { type: "playbackEnded" }
	/** The person talks over the reply. */
	| { type: "bargeIn" }
	| { type: "mute"; on: boolean }
	/** Something went wrong with one utterance or reply; the call goes on. */
	| { type: "warn"; error: CallError }
	/** The call cannot go on. */
	| { type: "fail"; error: CallError }
	| { type: "end" };

export const INITIAL_CALL_STATE: CallState = {
	phase: "starting",
	muted: false,
	busy: false,
	heard: "",
	partial: "",
	finishing: 0,
	pending: null,
	playing: null,
	language: null,
	preparing: null,
};

function withoutError(state: CallState): CallState {
	const { error: _error, ...rest } = state;
	return rest;
}

/** Where the call settles once nobody is talking and nothing plays: a held reply first, else waiting on the bot, else listening. */
function rest(state: CallState): CallState {
	if (state.pending !== null) return { ...state, phase: "speaking", playing: state.pending, pending: null };
	return { ...state, phase: state.busy ? "waiting" : "listening", playing: null };
}

/** The next state; the same object when the event changes nothing. An ended call ignores everything. */
export function nextPhase(state: CallState, event: CallEvent): CallState {
	if (state.phase === "ended") return state;
	switch (event.type) {
		case "end":
			return { ...state, phase: "ended", playing: null, pending: null };
		case "fail":
			return { ...state, phase: "ended", playing: null, pending: null, error: event.error };
		case "mute": {
			if (event.on === state.muted) return state;
			const next = { ...state, muted: event.on };
			return event.on && state.phase === "hearing" ? rest(next) : next;
		}
		case "micReady":
			return state.phase === "starting" || state.phase === "preparing" ? rest({ ...state, preparing: null }) : state;
		case "preparing":
			return state.phase === "starting" || state.phase === "preparing"
				? { ...state, phase: "preparing", language: event.language, preparing: event.percent }
				: state;
		case "recognitionFailed":
			return { ...state, language: event.language, error: "recognition" };
		case "speechStart":
			return (state.phase === "listening" || state.phase === "waiting") && !state.muted
				? { ...withoutError(state), phase: "hearing" }
				: state;
		case "speechEnd":
			if (state.phase !== "hearing") return state;
			return event.streamed
				? rest({ ...state, finishing: state.finishing + 1 })
				: { ...state, phase: "transcribing" };
		case "speechDropped":
			return state.phase === "hearing" ? rest(state) : state;
		case "transcript": {
			if (state.phase !== "transcribing") return state;
			const text = event.text.trim();
			return text ? rest({ ...state, heard: text, busy: true }) : rest(state);
		}
		case "streamTranscript": {
			const text = event.text.trim();
			const settled = state.finishing > 0 ? { ...state, finishing: state.finishing - 1 } : state;
			if (!text) return settled;
			const next = { ...settled, heard: text, busy: true };
			return state.phase === "listening" ? rest(next) : next;
		}
		case "partial":
			return event.text === state.partial ? state : { ...state, partial: event.text };
		case "sendFailed": {
			const next = { ...state, busy: false };
			return state.phase === "waiting" ? rest(next) : next;
		}
		case "replyStarted": {
			const next = state.busy ? state : { ...state, busy: true };
			return state.phase === "listening" ? rest(next) : next;
		}
		case "reply": {
			const text = event.text.trim();
			const next = { ...state, busy: false, ...(text ? { pending: text } : {}) };
			return state.phase === "listening" || state.phase === "waiting" ? rest(next) : next;
		}
		case "playbackEnded":
			return state.phase === "speaking" ? rest({ ...state, playing: null }) : state;
		case "bargeIn":
			return state.phase === "speaking" && !state.muted ? { ...state, phase: "hearing", playing: null } : state;
		case "warn": {
			const next = { ...state, error: event.error };
			return state.phase === "transcribing" || state.phase === "speaking" ? rest({ ...next, playing: null }) : next;
		}
		default: {
			const unreachable: never = event;
			return unreachable;
		}
	}
}

/** What the bot says aloud: its last assistant text without a closing `Sources:` / `출처:` line. */
export function spokenReply(text: string): string {
	return (parseBotSources(text)?.body ?? text).trim();
}

// ---------------------------------------------------------------------------
// The VAD
// ---------------------------------------------------------------------------

export const CALL_TUNING = {
	/** The VAD's pace. */
	tickMs: 30,
	/** Speech starts after this long above the threshold. */
	startMs: 150,
	/** An utterance ends after this long below it. */
	endMs: 900,
	/** Less voiced time than this is a click or a cough, not an utterance. */
	minVoicedMs: 300,
	/** One utterance never runs past this. */
	maxUtteranceMs: 60_000,
	/** Talking over the reply: sustained this long above the (higher) barge-in threshold. */
	bargeInMs: 250,
	/** A speech candidate survives a dip this short (the gap between syllables). */
	gapMs: 100,
	/**
	 * Loud stretches closer than this are one run of speech: a confirmed utterance reaches back to the run's first one, so
	 * a short word before a pause ("Wait, stop…" over a reply) is not cut off.
	 */
	runGapMs: 500,
	/** Ticks that only measure the noise floor after the mic opens. */
	calibrationTicks: 6,
	minThreshold: 0.02,
	/** The threshold is this many times the tracked noise floor. */
	floorMargin: 2.5,
	minBargeThreshold: 0.06,
	/** The barge-in threshold is this many times the listening one, against the reply's own echo. */
	bargeFactor: 2,
} as const;

export type VadMode = "off" | "listen" | "speak";

export type VadSignal =
	/** Loud enough to be speech, not yet sure: the caller starts recording so the first syllable is kept. */
	| { kind: "candidate" }
	/** The candidate was not speech. */
	| { kind: "dropped" }
	/** `since`: the first loud tick of the run of speech it belongs to (see `runGapMs`). */
	| { kind: "speech"; since: number }
	| { kind: "bargeIn"; since: number }
	/** `voicedMs`: from the speech's start to its last loud tick. */
	| { kind: "end"; voicedMs: number };

const listenThreshold = (floor: number): number => Math.max(CALL_TUNING.minThreshold, floor * CALL_TUNING.floorMargin);

/**
 * Energy voice-activity detector on the mic's RMS: the noise floor is tracked while listening (rising slowly, falling
 * fast), speech is a stretch above a multiple of it, an utterance ends after a stretch below it.
 */
export class VoiceActivity {
	#floor = 0;
	#ticks = 0;
	#candidateAt: number | null = null;
	#candidateMode: VadMode = "listen";
	#startedAt: number | null = null;
	#lastLoudAt = 0;
	/** The run of speech under way: its first loud tick, and the mode it was heard in; null when none. */
	#run: { since: number; mode: VadMode } | null = null;

	/** An utterance is under way (speech was confirmed, it has not ended). */
	get active(): boolean {
		return this.#startedAt !== null;
	}

	get floor(): number {
		return this.#floor;
	}

	reset(): void {
		this.#candidateAt = null;
		this.#startedAt = null;
	}

	step(rms: number, now: number, mode: VadMode): VadSignal | null {
		if (this.#ticks < CALIBRATION_TICKS) {
			this.#floor += (rms - this.#floor) * 0.3;
			this.#ticks++;
			return null;
		}
		if (mode === "off") {
			const had = this.#candidateAt !== null;
			this.reset();
			this.#run = null;
			return had ? { kind: "dropped" } : null;
		}
		const quiet = listenThreshold(this.#floor);
		if (this.#startedAt !== null) {
			if (rms > quiet) this.#lastLoudAt = now;
			const length = now - this.#startedAt;
			if (length >= CALL_TUNING.maxUtteranceMs || now - this.#lastLoudAt >= CALL_TUNING.endMs) {
				const voicedMs = this.#lastLoudAt - this.#startedAt;
				// A noise that never lets up is the new floor, not endless speech.
				if (length >= CALL_TUNING.maxUtteranceMs)
					this.#floor = Math.max(this.#floor, rms / CALL_TUNING.floorMargin);
				this.reset();
				return { kind: "end", voicedMs };
			}
			return null;
		}
		if (this.#candidateAt !== null && (this.#candidateMode !== mode || now - this.#lastLoudAt > CALL_TUNING.gapMs)) {
			this.reset();
			return { kind: "dropped" };
		}
		const bar = mode === "speak" ? Math.max(CALL_TUNING.minBargeThreshold, quiet * CALL_TUNING.bargeFactor) : quiet;
		if (rms > bar) {
			if (this.#run === null || this.#run.mode !== mode || now - this.#lastLoudAt > CALL_TUNING.runGapMs)
				this.#run = { since: now, mode };
			this.#lastLoudAt = now;
			if (this.#candidateAt === null) {
				this.#candidateAt = now;
				this.#candidateMode = mode;
				return { kind: "candidate" };
			}
			const need = mode === "speak" ? CALL_TUNING.bargeInMs : CALL_TUNING.startMs;
			if (now - this.#candidateAt >= need) {
				this.#startedAt = this.#candidateAt;
				const since = this.#run.since;
				this.#run = null;
				return { kind: mode === "speak" ? "bargeIn" : "speech", since };
			}
			return null;
		}
		if (this.#candidateAt === null && mode === "listen") {
			this.#floor += (rms - this.#floor) * (rms > this.#floor ? 0.01 : 0.2);
		}
		return null;
	}
}

const CALIBRATION_TICKS = CALL_TUNING.calibrationTicks;

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

export interface CallSnapshot extends CallState {
	/** The mic's level in {@link METER_BARS} bands, 0–1 (zeros while muted). */
	readonly levels: readonly number[];
	/** How loud the reply that plays is, 0–1 in steps of {@link OUTPUT_LEVEL_STEP}; 0 in every other phase. */
	readonly outputLevel: number;
}

export interface VoiceCall {
	/** Hang up: the mic, the playback and every timer are released. */
	end(): void;
	setMuted(muted: boolean): void;
}

export interface VoiceCallOptions {
	/** The bot's tab: its own stores say when its turn runs and what it said. */
	tabId: string;
	/**
	 * Hand the person's words to the bot: the tab's prompt, or its follow-up while `streaming`. Resolves false when they
	 * did not arrive (the caller says why).
	 */
	send: (text: string, context: { streaming: boolean }) => Promise<boolean>;
	/** Every change of the call, and of the mic level a few times a second. */
	onState: (snapshot: CallSnapshot) => void;
	/** The bridge's streaming voice commands; the app's RPC client by default. */
	streams?: VoiceStreams;
}

interface Watchable<T> {
	getState(): T;
	subscribe(listener: (state: T, previous: T) => void): () => void;
}

interface Capture {
	recorder: MediaRecorder;
	chunks: Blob[];
	stopped: Promise<void>;
}

const SILENT_LEVELS: readonly number[] = Array.from({ length: METER_BARS }, () => 0);
/** The reply's RMS that reads as full level: speech sits well under full scale, so it is raised to fill 0–1. */
const OUTPUT_LEVEL_GAIN = 4;
/** The reply's level goes out in this many steps per unit (every 0.05), so it publishes only when it visibly moves. */
const OUTPUT_LEVEL_STEP = 0.05;
/** The meter publishes every this many VAD ticks (≈ 60 ms). */
const METER_EVERY_TICKS = 2;
/** While hearing, a frame of mic audio goes to the transcription at most this often. */
const PUSH_EVERY_MS = 200;

let activeCall: VoiceCall | null = null;

function vadMode(state: CallState): VadMode {
	if (state.muted) return "off";
	switch (state.phase) {
		case "listening":
		case "waiting":
		case "hearing":
			return "listen";
		case "speaking":
			return "speak";
		default:
			return "off";
	}
}

/** Start a call on the bot's tab. One call at a time: starting another ends the one that runs. */
export function startVoiceCall(options: VoiceCallOptions): VoiceCall {
	activeCall?.end();
	const sessionStore: Watchable<{ isStreaming: boolean }> =
		sessionRuntimeStore<{ isStreaming: boolean }>(options.tabId, "session") ?? useSessionStore;
	const messagesStore: Watchable<{ lastAppended: AgentMessage[] }> =
		sessionRuntimeStore<{ lastAppended: AgentMessage[] }>(options.tabId, "messages") ?? useMessagesStore;

	let state = INITIAL_CALL_STATE;
	let levels = SILENT_LEVELS;
	let stream: MediaStream | null = null;
	let context: AudioContext | null = null;
	let stopTicking = (): void => {};
	let capture: Capture | null = null;
	let playback: StreamSpeechPlayback | null = null;
	let tap: PcmTap | null = null;
	/** Whether utterances stream: unknown until the first stream start answers; `batch` for the rest of the call once it was refused. */
	let sttMode: "unknown" | "stream" | "batch" = "unknown";
	let ttsBatch = false;
	/** The utterance being heard, and the one whose running text the bar shows (it outlives the hearing until its stop settles). */
	let utterance: { stream: SttStream; lastPushAt: number } | null = null;
	let latest: SttStream | null = null;
	/** Streams whose stop has not settled: ended with the call. */
	const inflight = new Set<SttStream>();
	/** Results go out in utterance order, whichever stream settles first. */
	let delivery: Promise<void> = Promise.resolve();
	const streams = options.streams ?? ompVoiceStreams();
	let outputLevel = 0;
	let lastAssistantText: string | null = null;
	const unsubscribers: Array<() => void> = [];
	const vad = new VoiceActivity();

	const publish = (): void => options.onState({ ...state, levels, outputLevel });

	function beginCapture(): void {
		if (capture || !stream) return;
		const recorder = new MediaRecorder(stream);
		const chunks: Blob[] = [];
		const stopped = Promise.withResolvers<void>();
		recorder.ondataavailable = event => {
			if (event.data.size > 0) chunks.push(event.data);
		};
		recorder.onstop = () => stopped.resolve();
		recorder.onerror = () => stopped.resolve();
		recorder.start();
		capture = { recorder, chunks, stopped: stopped.promise };
	}

	function discardCapture(): void {
		const taken = capture;
		capture = null;
		if (!taken) return;
		taken.recorder.ondataavailable = null;
		if (taken.recorder.state !== "inactive") taken.recorder.stop();
	}

	async function finishCapture(): Promise<Blob | null> {
		const taken = capture;
		capture = null;
		if (!taken) return null;
		if (taken.recorder.state !== "inactive") taken.recorder.stop();
		await taken.stopped;
		return taken.chunks.length > 0 ? new Blob(taken.chunks, { type: taken.recorder.mimeType || "audio/webm" }) : null;
	}

	function stopPlayback(): void {
		const taken = playback;
		playback = null;
		taken?.stop();
	}

	function startPlayback(text: string): void {
		const target = context;
		const meter = outputAnalyser;
		const started =
			ttsBatch || !target
				? playSpeech(text, target && meter ? { context: target, output: meter } : undefined)
				: playSpeechStream(text, streams, target, meter ?? undefined);
		playback = started;
		void started.finished.then(end => {
			if (playback !== started) return;
			playback = null;
			if (end.status === "unsupported") {
				ttsBatch = true;
				startPlayback(text);
				return;
			}
			dispatch(end.status === "failed" ? { type: "warn", error: "speak" } : { type: "playbackEnded" });
		});
	}

	/** The utterance's stream goes away; the bar stops showing its text. */
	function forget(stream: SttStream): void {
		stream.cancel();
		inflight.delete(stream);
		if (latest !== stream) return;
		latest = null;
		dispatch({ type: "partial", text: "" });
	}

	function discardUtterance(): void {
		const taken = utterance;
		utterance = null;
		if (!taken) return;
		tap?.end();
		forget(taken.stream);
	}

	/** `since`: the first loud tick of the speech (`Date.now()` clock); the pre-roll reaches back to it. */
	function beginUtterance(since: number): void {
		if (!tap || sttMode === "batch" || utterance) return;
		const stream = new SttStream(streams, text => {
			if (latest === stream) dispatch({ type: "partial", text });
		});
		utterance = { stream, lastPushAt: Date.now() };
		latest = stream;
		inflight.add(stream);
		stream.push(tap.begin(Date.now() - since));
		void stream.opened.then(open => {
			if (open.kind === "unsupported") {
				sttMode = "batch";
			} else if (open.kind === "open") {
				sttMode = "stream";
				// The recorder that ran for the first utterance, before the call knew streaming works, is not needed.
				if (utterance?.stream === stream) discardCapture();
			}
		});
	}

	function teardown(): void {
		stopTicking();
		for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
		discardCapture();
		discardUtterance();
		for (const open of inflight) open.cancel();
		inflight.clear();
		stopPlayback();
		tap?.close();
		tap = null;
		vad.reset();
		if (stream) for (const track of stream.getTracks()) track.stop();
		stream = null;
		const closing = context;
		context = null;
		if (closing) void closing.close();
		if (activeCall === call) {
			activeCall = null;
			setVoiceCallActive(false);
		}
	}

	function dispatch(event: CallEvent): void {
		const previous = state;
		const next = nextPhase(previous, event);
		if (next === previous) return;
		state = next;
		if (next.phase === "speaking" && previous.phase !== "speaking" && next.playing !== null) {
			startPlayback(next.playing);
		} else if (previous.phase === "speaking" && next.phase !== "speaking") {
			stopPlayback();
		}
		// Hearing that ends any way but into transcription or a stream (muted, too short) leaves nothing to keep.
		if (previous.phase === "hearing" && next.phase !== "hearing" && next.phase !== "transcribing") {
			vad.reset();
			discardCapture();
			discardUtterance();
		}
		if (next.muted !== previous.muted) {
			if (stream) for (const track of stream.getTracks()) track.enabled = !next.muted;
			if (next.muted) {
				vad.reset();
				discardCapture();
				discardUtterance();
				levels = SILENT_LEVELS;
			}
		}
		if (next.phase === "ended") {
			teardown();
			levels = SILENT_LEVELS;
		}
		if (next.phase !== "speaking") outputLevel = 0;
		publish();
	}

	async function deliver(text: string): Promise<void> {
		const streaming = sessionStore.getState().isStreaming;
		let delivered = false;
		try {
			delivered = await options.send(text, { streaming });
		} catch {
			delivered = false;
		}
		if (delivered) return;
		dispatch({ type: "sendFailed" });
		if (sessionStore.getState().isStreaming) dispatch({ type: "replyStarted" });
	}

	function transcribeRecording(blob: Blob | null): Promise<DictationResult> {
		return blob ? transcribeBlob(blob) : Promise.resolve({ text: "" });
	}

	/** `background`: the call listens on while this settles (a stream), so nothing waits in `transcribing`. */
	async function applyTranscript(result: DictationResult, background: boolean): Promise<void> {
		if ("text" in result) {
			const text = result.text.trim();
			dispatch(background ? { type: "streamTranscript", text } : { type: "transcript", text });
			if (text) await deliver(text);
			return;
		}
		const failure = result.failure ?? "failed";
		// A stream that settled without words is no longer being transcribed.
		if (background) dispatch({ type: "streamTranscript", text: "" });
		if (failure === "no-model") dispatch({ type: "fail", error: "no-model" });
		else if (failure === "empty" || failure === "busy") {
			if (!background) dispatch({ type: "transcript", text: "" });
		} else dispatch({ type: "warn", error: "failed" });
		// The words never became text: a turn that still runs keeps the call waiting.
		if (sessionStore.getState().isStreaming) dispatch({ type: "replyStarted" });
	}

	/** Queue one utterance's outcome behind the earlier ones, so what the person said goes to the bot in the order they said it. */
	function conclude(stream: SttStream | null, result: Promise<DictationResult>, background: boolean): void {
		delivery = delivery.then(async () => {
			const outcome = await result;
			if (stream) forget(stream);
			if (state.phase === "ended") return;
			await applyTranscript(outcome, background);
		});
	}

	/** The stream's final text, or (the omp refused streaming at the first start) the whole recording transcribed. */
	async function streamedTranscript(
		stream: SttStream,
		tail: Int16Array,
		recording: Promise<Blob | null>,
	): Promise<DictationResult> {
		const open = await stream.opened;
		if (open.kind === "unsupported") return transcribeRecording(await recording);
		return stream.stop(tail);
	}

	function onSignal(signal: VadSignal): void {
		switch (signal.kind) {
			case "candidate":
				if (sttMode !== "stream") beginCapture();
				return;
			case "dropped":
				discardCapture();
				return;
			case "speech":
			case "bargeIn":
				dispatch({ type: signal.kind === "speech" ? "speechStart" : "bargeIn" });
				if (state.phase !== "hearing") {
					vad.reset();
					discardCapture();
					return;
				}
				beginUtterance(signal.since);
				return;
			case "end": {
				if (state.phase !== "hearing") {
					discardCapture();
					discardUtterance();
					return;
				}
				if (signal.voicedMs < CALL_TUNING.minVoicedMs) {
					discardCapture();
					discardUtterance();
					dispatch({ type: "speechDropped" });
					return;
				}
				const recording = finishCapture();
				const heard = utterance;
				utterance = null;
				const tail = heard ? (tap?.end() ?? new Int16Array(0)) : null;
				const streamed = sttMode === "stream";
				dispatch({ type: "speechEnd", streamed });
				if (heard && tail) conclude(heard.stream, streamedTranscript(heard.stream, tail, recording), streamed);
				else conclude(null, recording.then(transcribeRecording), false);
				return;
			}
		}
	}

	let analyser: AnalyserNode | null = null;
	let outputAnalyser: AnalyserNode | null = null;
	let samples = new Float32Array(0);
	let outputSamples = new Float32Array(0);
	let bins = new Uint8Array(0);
	let ticks = 0;

	/** The reply's loudness now, quantized; 0 while nothing is speaking. */
	function measureOutput(): number {
		if (!outputAnalyser || state.phase !== "speaking") return 0;
		outputAnalyser.getFloatTimeDomainData(outputSamples);
		let sum = 0;
		for (const sample of outputSamples) sum += sample * sample;
		const rms = Math.sqrt(sum / Math.max(1, outputSamples.length));
		return Math.round(Math.min(1, rms * OUTPUT_LEVEL_GAIN) / OUTPUT_LEVEL_STEP) / (1 / OUTPUT_LEVEL_STEP);
	}

	function tick(): void {
		if (!analyser || state.phase === "starting" || state.phase === "ended") return;
		analyser.getFloatTimeDomainData(samples);
		let sum = 0;
		for (const sample of samples) sum += sample * sample;
		const rms = Math.sqrt(sum / Math.max(1, samples.length));
		ticks++;
		if (ticks % METER_EVERY_TICKS === 0 && !state.muted) {
			analyser.getByteFrequencyData(bins);
			const next = speechBandLevels(bins, context?.sampleRate ?? 48_000);
			if (next.some((level, index) => level !== levels[index])) {
				levels = next;
				publish();
			}
		}
		const measured = measureOutput();
		if (measured !== outputLevel) {
			outputLevel = measured;
			publish();
		}
		const now = Date.now();
		const pushDue = utterance && !utterance.stream.busy && now - utterance.lastPushAt >= PUSH_EVERY_MS;
		if (utterance && pushDue && state.phase === "hearing") {
			utterance.stream.push(tap?.drain() ?? new Int16Array(0));
			utterance.lastPushAt = now;
		}
		const signal = vad.step(rms, now, vadMode(state));
		if (signal) onSignal(signal);
	}

	async function open(): Promise<void> {
		// A function, not a narrowed check: `state` changes while each await below is pending.
		const ended = () => state.phase === "ended";
		// The language's speech model first: the mic is not held while hundreds of MB download.
		const prepared = await prepareRecognition(
			streams,
			(language, percent) => dispatch({ type: "preparing", language, percent }),
			ended,
		);
		if (ended()) return;
		if (prepared.kind === "failed") dispatch({ type: "recognitionFailed", language: prepared.language });
		let opened: MediaStream;
		try {
			if (!navigator.mediaDevices?.getUserMedia) {
				// Browsers expose no microphone to a page that is not on a secure origin.
				dispatch({ type: "fail", error: "denied" });
				return;
			}
			opened = await navigator.mediaDevices.getUserMedia({
				audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
			});
		} catch (cause) {
			dispatch({ type: "fail", error: classifyMicError(cause) });
			return;
		}
		if (ended()) {
			for (const track of opened.getTracks()) track.stop();
			return;
		}
		stream = opened;
		try {
			context = new AudioContext();
			analyser = context.createAnalyser();
			analyser.fftSize = 1024;
			analyser.smoothingTimeConstant = 0.6;
			const source = context.createMediaStreamSource(opened);
			source.connect(analyser);
			try {
				tap = createPcmTap(context, source);
			} catch {
				// No raw PCM from this page: every utterance goes the whole-clip way.
				sttMode = "batch";
			}
			if (context.state === "suspended") void context.resume();
			samples = new Float32Array(analyser.fftSize);
			bins = new Uint8Array(analyser.frequencyBinCount);
			outputAnalyser = context.createAnalyser();
			outputAnalyser.fftSize = 512;
			outputAnalyser.smoothingTimeConstant = 0.5;
			outputAnalyser.connect(context.destination);
			outputSamples = new Float32Array(outputAnalyser.fftSize);
		} catch {
			dispatch({ type: "fail", error: "failed" });
			return;
		}
		if (state.muted) for (const track of opened.getTracks()) track.enabled = false;
		const handle = setInterval(tick, CALL_TUNING.tickMs);
		stopTicking = () => clearInterval(handle);
		dispatch({ type: "micReady" });
	}

	const call: VoiceCall = {
		end: () => dispatch({ type: "end" }),
		setMuted: muted => dispatch({ type: "mute", on: muted }),
	};
	activeCall = call;
	setVoiceCallActive(true);

	unsubscribers.push(
		messagesStore.subscribe((current, previous) => {
			if (current.lastAppended === previous.lastAppended) return;
			for (const message of current.lastAppended) {
				if (message.role !== "assistant" || message.stopReason === "aborted") continue;
				const text = messageText(message);
				if (text) lastAssistantText = text;
			}
		}),
		sessionStore.subscribe((current, previous) => {
			if (!previous.isStreaming && current.isStreaming) {
				lastAssistantText = null;
				dispatch({ type: "replyStarted" });
			} else if (previous.isStreaming && !current.isStreaming) {
				const text = lastAssistantText;
				lastAssistantText = null;
				dispatch({ type: "reply", text: text === null ? "" : spokenReply(text) });
			}
		}),
	);
	if (sessionStore.getState().isStreaming) dispatch({ type: "replyStarted" });
	publish();
	void open();
	return call;
}
