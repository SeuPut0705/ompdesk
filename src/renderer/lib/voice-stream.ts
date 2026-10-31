/**
 * The voice call's streaming speech: the bridge's `stt_stream_*` / `tts_stream_*` commands, the mic PCM tap and
 * gapless chunk playback. Only the call (`voice-call.ts`, in the bot's lazy chunk) imports it, so the phone's first
 * screen does not carry it.
 */
import {
	base64ToBytes,
	bytesToBase64,
	classifyTranscribeError,
	type DictationResult,
	type SpeechEnd,
	STT_SAMPLE_RATE,
} from "./voice";

// ---------------------------------------------------------------------------
// Streaming STT (the voice call): the bridge's stt_stream_* commands
// ---------------------------------------------------------------------------

/** What a streaming voice command answers: the usual RPC reply, reduced to what the call reads. */
export type StreamReply = { success: true; data?: unknown } | { success: false; error: string; code?: string };

/**
 * The bridge's streaming voice commands, named and shaped as `rpc.<name>` carries them. The voice call takes this as a
 * parameter ({@link ompVoiceStreams} by default) so tests inject fakes.
 */
export interface VoiceStreams {
	/** `{ streamId }`. Rejects like `transcribe_audio` when the dictation model is missing. */
	sttStreamStart(language?: string): Promise<StreamReply>;
	/** `pcm16`: base64 little-endian PCM16 mono 16 kHz. Answers `{ text }`: the committed segments and the current partial. */
	sttStreamPush(streamId: string, pcm16: string): Promise<StreamReply>;
	/** `{ text }`: the final transcript. */
	sttStreamStop(streamId: string): Promise<StreamReply>;
	sttStreamCancel(streamId: string): Promise<StreamReply>;
	/** `{ streamId, sampleRate }`. */
	ttsStreamStart(text: string): Promise<StreamReply>;
	/** `{ chunks, done }`: base64 PCM16 mono at the stream's sample rate; long-polls until a chunk is ready. */
	ttsStreamNext(streamId: string, waitMs?: number): Promise<StreamReply>;
	ttsStreamCancel(streamId: string): Promise<StreamReply>;
}

/** The streaming commands on the app's RPC client (an omp without them answers `unsupported_omp`). */
export function ompVoiceStreams(): VoiceStreams {
	const rpc = () => window.omp.rpc;
	return {
		sttStreamStart: language => rpc().sttStreamStart(language),
		sttStreamPush: (streamId, pcm16) => rpc().sttStreamPush(streamId, pcm16),
		sttStreamStop: streamId => rpc().sttStreamStop(streamId),
		sttStreamCancel: streamId => rpc().sttStreamCancel(streamId),
		ttsStreamStart: text => rpc().ttsStreamStart(text),
		ttsStreamNext: (streamId, waitMs) => rpc().ttsStreamNext(streamId, waitMs),
		ttsStreamCancel: streamId => rpc().ttsStreamCancel(streamId),
	};
}

/** An omp without the streaming commands, or one that does not know the stream: the call falls back to whole clips. */
export function isStreamUnsupported(reply: { error: string; code?: string }): boolean {
	return reply.code === "unsupported_omp" || /unsupported_omp|unknown[ _]command|unknown_stream/i.test(reply.error);
}

/** A streaming command's reply; a command that throws is a failed reply. */
async function settled(call: () => Promise<StreamReply>): Promise<StreamReply> {
	try {
		return await call();
	} catch (cause) {
		return { success: false, error: cause instanceof Error ? cause.message : String(cause) };
	}
}

/** One field of a streaming command's `data`, unchecked beyond "it is an object". */
function field(data: unknown, key: string): unknown {
	return typeof data === "object" && data !== null ? Reflect.get(data, key) : undefined;
}

function textOf(data: unknown): string {
	const text = field(data, "text");
	return typeof text === "string" ? text : "";
}

export type SttOpen =
	| { kind: "open" }
	/** The omp has no streaming transcription: use {@link transcribeBlob}. */
	| { kind: "unsupported" }
	| { kind: "failed"; result: DictationResult };

/**
 * One utterance on the bridge's streaming transcription: frames go out in order (one request in flight, so a slow
 * partial never reorders them), each answer's running text goes to `onText`, and {@link stop} settles to the final text.
 * Streams are independent of each other: stopping one does not hold up the next.
 */
export class SttStream {
	/** How the start was answered. */
	readonly opened: Promise<SttOpen>;
	readonly #streams: VoiceStreams;
	readonly #onText: (text: string) => void;
	#id: string | null = null;
	#queue: Promise<void> = Promise.resolve();
	#inFlight = 0;
	#closed = false;

	constructor(streams: VoiceStreams, onText: (text: string) => void) {
		this.#streams = streams;
		this.#onText = onText;
		this.opened = this.#open();
	}

	/** A frame is still being sent: the caller skips a beat instead of queueing behind it. */
	get busy(): boolean {
		return this.#inFlight > 0;
	}

	async #open(): Promise<SttOpen> {
		const reply = await settled(() => this.#streams.sttStreamStart());
		if (!reply.success) {
			if (isStreamUnsupported(reply)) return { kind: "unsupported" };
			return { kind: "failed", result: { error: reply.error, failure: classifyTranscribeError(reply.error) } };
		}
		const id = field(reply.data, "streamId");
		if (typeof id !== "string" || !id) {
			return { kind: "failed", result: { error: "stt stream start answered no streamId", failure: "failed" } };
		}
		this.#id = id;
		return { kind: "open" };
	}

	/** Queue `pcm` (16 kHz mono) behind the frames already sent. */
	push(pcm: Int16Array): void {
		if (this.#closed || pcm.length === 0) return;
		const audio = bytesToBase64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
		this.#inFlight++;
		this.#queue = this.#queue.then(async () => {
			try {
				const open = await this.opened;
				const id = this.#id;
				if (open.kind !== "open" || id === null || this.#closed) return;
				const reply = await settled(() => this.#streams.sttStreamPush(id, audio));
				if (reply.success && !this.#closed) this.#onText(textOf(reply.data));
			} finally {
				this.#inFlight--;
			}
		});
	}

	/** Send the rest of the audio and ask for the final text. */
	async stop(tail: Int16Array): Promise<DictationResult> {
		this.push(tail);
		await this.#queue;
		const open = await this.opened;
		if (open.kind === "failed") return open.result;
		const id = this.#id;
		if (open.kind !== "open" || id === null) return { error: "unsupported_omp", failure: "failed" };
		const reply = await settled(() => this.#streams.sttStreamStop(id));
		this.#closed = true;
		if (!reply.success) return { error: reply.error, failure: classifyTranscribeError(reply.error) };
		return { text: textOf(reply.data) };
	}

	/** Throw the utterance away; the sidecar frees the stream. */
	cancel(): void {
		if (this.#closed) return;
		this.#closed = true;
		void this.opened.then(open => {
			const id = this.#id;
			if (open.kind === "open" && id !== null) void settled(() => this.#streams.sttStreamCancel(id));
		});
	}
}

// ---------------------------------------------------------------------------
// Mic PCM for the call: raw frames from the call's one mic stream, as 16 kHz mono PCM16
// ---------------------------------------------------------------------------

/** How much audio before an utterance's confirmation goes out with it: its first syllable (and a barge-in's 250 ms) must survive. */
const PRE_ROLL_MS = 400;
/** The script processor's block (frames per callback): about 85 ms at 48 kHz. */
const PCM_BLOCK_FRAMES = 4096;

/**
 * Streaming box-filter resampler to the STT rate: each output sample is the mean of the input stretch it covers, so
 * the fractional ratios (44.1 kHz → 16 kHz) lose no input and carry their remainder across blocks.
 */
class Downsampler {
	readonly #step: number;
	#need: number;
	#sum = 0;

	constructor(inputRate: number, outputRate: number) {
		this.#step = inputRate / outputRate;
		this.#need = this.#step;
	}

	convert(input: Float32Array): Int16Array {
		const out = new Int16Array(Math.ceil(input.length / this.#step) + 1);
		let count = 0;
		for (let i = 0; i < input.length; i += 1) {
			const sample = input[i]!;
			let weight = 1;
			while (weight > 1e-9) {
				const take = Math.min(weight, this.#need);
				this.#sum += sample * take;
				this.#need -= take;
				weight -= take;
				if (this.#need <= 1e-9) {
					const mean = this.#sum / this.#step;
					const clamped = mean > 1 ? 1 : mean < -1 ? -1 : mean;
					out[count++] = Math.round(clamped < 0 ? clamped * 32_768 : clamped * 32_767);
					this.#sum = 0;
					this.#need = this.#step;
				}
			}
		}
		return out.subarray(0, count);
	}
}

export interface PcmTap {
	/** Start keeping audio for an utterance; returns the pre-roll (the last {@link PRE_ROLL_MS} before now). */
	begin(): Int16Array;
	/** What came in since `begin` or the last `drain`. */
	drain(): Int16Array;
	/** What came in since the last `drain`; stops keeping audio. */
	end(): Int16Array;
	/** Release the node. */
	close(): void;
}

function joinPcm(parts: Int16Array[]): Int16Array {
	const joined = new Int16Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		joined.set(part, offset);
		offset += part.length;
	}
	return joined;
}

/**
 * Tap the mic `source` for raw PCM: a ScriptProcessorNode, not an AudioWorklet. The worklet's module would have to
 * load from a Blob URL (or a packaged asset), and the renderer's CSP is `script-src 'self'`, which refuses a blob:
 * script; the asset route cannot be proven under the packaged app's origin from here. A script processor needs
 * neither, is still shipped in Chromium, and its main-thread block (about 85 ms) is far below the 200 ms frame pace.
 * The node is wired to the destination only because Chromium does not run an unconnected one; it outputs silence.
 */
export function createPcmTap(context: AudioContext, source: AudioNode): PcmTap {
	const processor = context.createScriptProcessor(PCM_BLOCK_FRAMES, 1, 1);
	const down = new Downsampler(context.sampleRate, STT_SAMPLE_RATE);
	const capacity = Math.round((STT_SAMPLE_RATE * PRE_ROLL_MS) / 1000);
	const ring = new Int16Array(capacity);
	let written = 0;
	let held: Int16Array[] | null = null;
	processor.onaudioprocess = event => {
		const pcm = down.convert(event.inputBuffer.getChannelData(0));
		for (let i = 0; i < pcm.length; i += 1) ring[(written + i) % capacity] = pcm[i]!;
		written += pcm.length;
		held?.push(pcm);
	};
	source.connect(processor);
	processor.connect(context.destination);
	const drain = (): Int16Array => {
		const parts = held ?? [];
		held = held ? [] : null;
		return joinPcm(parts);
	};
	return {
		begin() {
			const count = Math.min(written, capacity);
			const preRoll = new Int16Array(count);
			for (let i = 0; i < count; i += 1) preRoll[i] = ring[(written - count + i) % capacity]!;
			held = [];
			return preRoll;
		},
		drain,
		end() {
			const rest = drain();
			held = null;
			return rest;
		},
		close() {
			processor.onaudioprocess = null;
			processor.disconnect();
			source.disconnect(processor);
		},
	};
}

export type StreamSpeechEnd = SpeechEnd | { status: "unsupported" };

export interface StreamSpeechPlayback {
	/** Stop at once: every scheduled source, and the stream on the sidecar. Resolves {@link finished} as stopped. */
	stop(): void;
	/** `unsupported`: the omp has no streaming synthesis and nothing played; the caller uses {@link playSpeech}. */
	readonly finished: Promise<StreamSpeechEnd>;
}

/** A new chunk starts this far ahead of the context's clock when nothing is queued, so it is never scheduled in the past. */
const SPEECH_LEAD_SECONDS = 0.03;

/**
 * Synthesize `text` as a stream and play each chunk as it arrives: the chunks are scheduled gaplessly on `context` (each
 * source starts where the last one ends), so the first sound waits only for the first chunk. Playback ends when the
 * stream is done and its last source ended.
 */
export function playSpeechStream(text: string, streams: VoiceStreams, context: AudioContext): StreamSpeechPlayback {
	let stopped = false;
	let streamId: string | null = null;
	let endsAt = 0;
	const live = new Set<AudioBufferSourceNode>();
	const interrupted = Promise.withResolvers<void>();

	const cancelStream = (): void => {
		const id = streamId;
		streamId = null;
		if (id !== null) void settled(() => streams.ttsStreamCancel(id));
	};
	const silence = (): void => {
		for (const source of live) {
			source.onended = null;
			source.stop();
			source.disconnect();
		}
		live.clear();
	};
	const schedule = (chunk: string, sampleRate: number): Promise<void> => {
		const bytes = base64ToBytes(chunk);
		const pcm = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
		if (pcm.length === 0) return Promise.resolve();
		const buffer = context.createBuffer(1, pcm.length, sampleRate);
		const samples = buffer.getChannelData(0);
		for (let i = 0; i < pcm.length; i += 1) samples[i] = pcm[i]! / 32_768;
		const source = context.createBufferSource();
		source.buffer = buffer;
		source.connect(context.destination);
		const ended = Promise.withResolvers<void>();
		source.onended = () => {
			live.delete(source);
			source.disconnect();
			ended.resolve();
		};
		const startAt = endsAt > context.currentTime ? endsAt : context.currentTime + SPEECH_LEAD_SECONDS;
		source.start(startAt);
		endsAt = startAt + buffer.duration;
		live.add(source);
		return ended.promise;
	};

	const finished = (async (): Promise<StreamSpeechEnd> => {
		try {
			const start = await settled(() => streams.ttsStreamStart(text));
			if (!start.success) {
				if (stopped) return { status: "stopped" };
				return isStreamUnsupported(start) ? { status: "unsupported" } : { status: "failed", error: start };
			}
			const id = field(start.data, "streamId");
			const sampleRate = field(start.data, "sampleRate");
			if (typeof id !== "string" || typeof sampleRate !== "number") {
				return { status: "failed", error: start };
			}
			streamId = id;
			if (stopped) {
				cancelStream();
				return { status: "stopped" };
			}
			const playing: Promise<void>[] = [];
			for (let done = false; !done; ) {
				const next = await settled(() => streams.ttsStreamNext(id));
				if (stopped) return { status: "stopped" };
				if (!next.success) {
					silence();
					cancelStream();
					return { status: "failed", error: next };
				}
				const chunks = field(next.data, "chunks");
				if (Array.isArray(chunks)) {
					for (const chunk of chunks) if (typeof chunk === "string") playing.push(schedule(chunk, sampleRate));
				}
				done = field(next.data, "done") === true;
			}
			streamId = null;
			await Promise.race([Promise.all(playing), interrupted.promise]);
			return { status: stopped ? "stopped" : "ended" };
		} catch (cause) {
			silence();
			cancelStream();
			return stopped ? { status: "stopped" } : { status: "failed", error: cause };
		}
	})();
	return {
		finished,
		stop() {
			if (stopped) return;
			stopped = true;
			silence();
			cancelStream();
			interrupted.resolve();
		},
	};
}
