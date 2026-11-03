/**
 * Streaming voice over stock's STT and TTS workers (`stt_stream_*`, `tts_stream_*`), behind the seam in `VoiceStock`
 * so `voice.ts` loads stock lazily and `src/main/bridge-voice-stream.test.ts` runs it over fakes. Pure: no omp imports.
 *
 * Audio crosses the bridge as base64 little-endian PCM16 mono: 16 kHz into STT, the model's rate out of TTS. A stream
 * a client stops using (a closed window, a lost link) is cancelled after `IDLE_MS` without a push or poll, so the
 * worker's model never keeps decoding for nobody.
 */
import { asRecord, requiredString } from "./params";
import type { SttPrepareResult } from "./stt-language-contracts";
import {
	type SttModelFacts,
	type SttModelStore,
	SttModels,
	sttLanguageCode,
	sttModelForLanguage,
	sttPreviewsSpeech,
} from "./stt-language-core";

export const IDLE_MS = 30_000;
const DEFAULT_WAIT_MS = 1_500;
const MAX_WAIT_MS = 5_000;
const UNKNOWN_STREAM = "unknown_stream";
const TTS_UNAVAILABLE = "Local TTS model is unavailable — download it from the TUI speech settings first";

/** Stock's `SttStreamHandle` (stt/asr-client). */
export interface SttStreamHandle {
	pushAudio(audio: Float32Array): void;
	stop(): Promise<string>;
	cancel(): void;
}

export interface SttStreamOptions {
	language?: string;
	onPartial(text: string): void;
	onSegment(text: string, index: number): void;
}

/** Stock's `TtsAudioChunk` (tts/tts-client), the part read here. */
export interface TtsChunk {
	pcm: Float32Array;
	sampleRate: number;
}

/** Stock's `TtsStreamHandle` (tts/tts-client). */
export interface TtsStreamHandle {
	push(text: string): void;
	end(): void;
	chunks: AsyncIterable<TtsChunk>;
}

export interface SttSetup {
	/** Stock's `SttClient` (stt/asr-client), the part used here. */
	client: {
		startStream(modelKey: string, options: SttStreamOptions): SttStreamHandle;
		/** One whole-clip pass. */
		transcribe(
			modelKey: string,
			audio: Float32Array,
			options?: { language?: string; signal?: AbortSignal },
		): Promise<string>;
		/** Stock's download request: fetches what is missing, then loads the weights into the worker and keeps them warm. */
		downloadModel(modelKey: string): Promise<unknown>;
	};
	/** The dictation role's model, as stock's catalog describes it. */
	selected: SttModelFacts;
	/** Any model of stock's catalog by key. */
	model(key: string): SttModelFacts;
	/** The language speech is in when a request names none: the conversation language, else the `stt.language` setting. */
	language: string | undefined;
}

export interface TtsSetup {
	client: { synthesizeStream(modelKey: string, options: { voice: string; signal: AbortSignal }): TtsStreamHandle };
	modelKey: string;
	voice: string;
	sampleRate: number;
	/** Stock's `SpeakableStream`: markdown out, sentence-sized segments the worker can synthesize as-is. */
	segment(text: string): string[];
}

/** What the stock side resolves from the live session; each runs on the stream's first use, never at install. */
export interface VoiceStock<Ctx> {
	stt(ctx: Ctx): Promise<SttSetup>;
	tts(ctx: Ctx): Promise<TtsSetup>;
	/** Stock's speech-model downloader. */
	sttModels: SttModelStore;
}

/** A client's streams by id; a stream idle for `idleMs` is dropped through `onDrop`. */
class StreamTable<T> {
	readonly #entries = new Map<string, { value: T; timer: NodeJS.Timeout }>();

	constructor(
		private readonly idleMs: number,
		private readonly onDrop: (value: T) => void,
	) {}

	add(value: T): string {
		const id = crypto.randomUUID();
		this.#entries.set(id, { value, timer: this.#arm(id) });
		return id;
	}

	/** The stream, with its idle clock restarted. */
	use(id: string): T {
		const entry = this.#entries.get(id);
		if (!entry) throw new Error(UNKNOWN_STREAM);
		clearTimeout(entry.timer);
		entry.timer = this.#arm(id);
		return entry.value;
	}

	/** Forget a stream that finished on its own. */
	release(id: string): void {
		const entry = this.#entries.get(id);
		if (!entry) return;
		clearTimeout(entry.timer);
		this.#entries.delete(id);
	}

	/** Forget a stream and cancel it. */
	drop(id: string): void {
		const value = this.use(id);
		this.release(id);
		this.onDrop(value);
	}

	dropAll(): void {
		for (const id of [...this.#entries.keys()]) this.drop(id);
	}

	#arm(id: string): NodeJS.Timeout {
		const timer = setTimeout(() => {
			if (this.#entries.has(id)) this.drop(id);
		}, this.idleMs);
		timer.unref?.();
		return timer;
	}
}

/** What the worker reported so far: committed segments in order, and the segment still being spoken. */
interface SttText {
	committed: string[];
	partial: string;
}

interface SttEntry {
	handle: SttStreamHandle;
	text: SttText;
}

interface TtsEntry {
	queue: string[];
	finished: boolean;
	failure: Error | undefined;
	closed: boolean;
	waiters: Set<() => void>;
	cancel(): void;
}

/** Committed segments, then the segment still being spoken. */
function transcript(text: SttText): string {
	return [...text.committed, text.partial]
		.map(part => part.trim())
		.filter(Boolean)
		.join(" ");
}

/**
 * A stream on a model that does not preview speech ({@link sttPreviewsSpeech}): the utterance's audio is kept as it comes
 * and transcribed in one pass at the stop. The model starts loading now, as stock's stream does at its start, so that
 * pass does not also load the weights.
 */
function transcribeOnStop(setup: SttSetup, modelKey: string, language: string | undefined): SttStreamHandle {
	const parts: Float32Array[] = [];
	const abort = new AbortController();
	setup.client.downloadModel(modelKey).catch(() => {});
	return {
		pushAudio: audio => {
			if (!abort.signal.aborted) parts.push(audio);
		},
		stop: async () => {
			const audio = new Float32Array(parts.reduce((length, part) => length + part.length, 0));
			let offset = 0;
			for (const part of parts.splice(0)) {
				audio.set(part, offset);
				offset += part.length;
			}
			if (audio.length === 0 || abort.signal.aborted) return "";
			try {
				return await setup.client.transcribe(modelKey, audio, { language, signal: abort.signal });
			} catch (cause) {
				// Cancelled, as stock's stream resolves a cancelled stop: with nothing.
				if (abort.signal.aborted) return "";
				throw cause;
			}
		},
		cancel: () => {
			parts.length = 0;
			abort.abort();
		},
	};
}

export function pcm16ToFloat32(base64: string): Float32Array {
	const bytes = Buffer.from(base64, "base64");
	if (bytes.length % 2 !== 0) throw new Error("pcm16 must be a whole number of 16-bit samples");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const samples = new Float32Array(bytes.length / 2);
	for (let i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(i * 2, true) / 32768;
	return samples;
}

/** Same quantization as stock's `encodeWav` (tts/wav). */
export function float32ToPcm16(samples: Float32Array): string {
	const out = Buffer.alloc(samples.length * 2);
	for (let i = 0; i < samples.length; i += 1) {
		const sample = samples[i] ?? 0;
		const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample;
		out.writeInt16LE(
			clamped < 0 ? Math.max(-32768, Math.round(clamped * 32768)) : Math.min(32767, Math.round(clamped * 32767)),
			i * 2,
		);
	}
	return out.toString("base64");
}

/** Stock's `SpeakableStream` (tts/speakable), the part read here. */
export interface Speakable {
	push(delta: string): string[];
	flush(): string[];
}

/**
 * `text`'s speakable segments, fed to stock's segmenter word by word as a model's deltas reach it. Its live-speech
 * rules then apply: the first segment cuts early at a clause so the sound starts soon, and a long sentence goes out
 * in clause-sized pieces. One push of the whole reply cuts only at sentence ends: a 276-character first sentence was
 * one segment, and the call heard nothing for 6 s while Kokoro synthesized it (omp 18.15.0, measured).
 */
export function speakableSegments(text: string, speakable: Speakable): string[] {
	const segments: string[] = [];
	for (const piece of text.match(/\S+\s*|\s+/g) ?? []) segments.push(...speakable.push(piece));
	segments.push(...speakable.flush());
	return segments;
}

function waitMsOf(params: unknown): number {
	const raw = asRecord(params).waitMs;
	return typeof raw === "number" && Number.isFinite(raw) ? Math.min(MAX_WAIT_MS, Math.max(0, raw)) : DEFAULT_WAIT_MS;
}

export class VoiceStreams<Ctx> {
	readonly #stt: StreamTable<SttEntry>;
	readonly #tts: StreamTable<TtsEntry>;
	readonly #models: SttModels;

	constructor(
		private readonly stock: VoiceStock<Ctx>,
		idleMs = IDLE_MS,
	) {
		this.#stt = new StreamTable(idleMs, entry => entry.handle.cancel());
		this.#tts = new StreamTable(idleMs, entry => this.#close(entry));
		this.#models = new SttModels(stock.sttModels);
	}

	/** The speech's language (a `language` the request names wins) and the model the rule picks for it. */
	async #route(params: unknown, ctx: Ctx): Promise<{ setup: SttSetup; language: string | undefined; wanted: string }> {
		const requested = asRecord(params).language;
		const setup = await this.stock.stt(ctx);
		const language = sttLanguageCode((typeof requested === "string" && requested) || setup.language);
		return { setup, language, wanted: sttModelForLanguage(setup.selected, language) };
	}

	/**
	 * The model an utterance is transcribed on. `batch` (dictation's whole clip) waits for the language's model to
	 * download. A stream never does: until `stt_prepare` has the language's model here (or after its download failed),
	 * it opens on the selected model, which downloads as it always did.
	 */
	async sttModel(
		params: unknown,
		ctx: Ctx,
		mode: "stream" | "batch",
	): Promise<{ setup: SttSetup; modelKey: string; language?: string }> {
		const { setup, language, wanted } = await this.#route(params, ctx);
		if (wanted !== setup.selected.key) {
			if (mode === "batch") {
				try {
					await this.#models.ensure(wanted);
				} catch (cause) {
					const message = cause instanceof Error ? cause.message : String(cause);
					throw new Error(`Could not download ${wanted} for ${language} speech: ${message}`);
				}
				return { setup, modelKey: wanted, language };
			}
			if (await this.#models.isReady(wanted)) return { setup, modelKey: wanted, language };
		}
		await this.#models.ensure(setup.selected.key);
		return { setup, modelKey: setup.selected.key, language };
	}

	/** Start getting the model the speech's language needs, without waiting; the call asks again until it is ready. */
	async sttPrepare(params: unknown, ctx: Ctx): Promise<SttPrepareResult> {
		const { language, wanted } = await this.#route(params, ctx);
		return { language: language ?? null, modelKey: wanted, ...(await this.#models.prepare(wanted)) };
	}

	async sttStart(params: unknown, ctx: Ctx): Promise<{ streamId: string }> {
		const { setup, modelKey, language } = await this.sttModel(params, ctx, "stream");
		const text: SttText = { committed: [], partial: "" };
		const handle = sttPreviewsSpeech(setup.model(modelKey))
			? setup.client.startStream(modelKey, {
					language,
					onPartial: partial => {
						text.partial = partial;
					},
					onSegment: segment => {
						text.committed.push(segment);
						text.partial = "";
					},
				})
			: transcribeOnStop(setup, modelKey, language);
		return { streamId: this.#stt.add({ handle, text }) };
	}

	async sttPush(params: unknown): Promise<{ text: string }> {
		const entry = this.#stt.use(requiredString(params, "streamId"));
		entry.handle.pushAudio(pcm16ToFloat32(requiredString(params, "pcm16")));
		return { text: transcript(entry.text) };
	}

	async sttStop(params: unknown): Promise<{ text: string }> {
		const id = requiredString(params, "streamId");
		const entry = this.#stt.use(id);
		try {
			return { text: await entry.handle.stop() };
		} finally {
			this.#stt.release(id);
		}
	}

	async sttCancel(params: unknown): Promise<Record<string, never>> {
		this.#stt.drop(requiredString(params, "streamId"));
		return {};
	}

	async ttsStart(params: unknown, ctx: Ctx): Promise<{ streamId: string; sampleRate: number }> {
		const raw = asRecord(params).text;
		const text = typeof raw === "string" ? raw : "";
		const setup = await this.stock.tts(ctx);
		const segments = setup.segment(text);
		const abort = new AbortController();
		const entry: TtsEntry = {
			queue: [],
			finished: false,
			failure: undefined,
			closed: false,
			waiters: new Set(),
			cancel: () => abort.abort(),
		};
		const handle = setup.client.synthesizeStream(setup.modelKey, { voice: setup.voice, signal: abort.signal });
		for (const segment of segments) handle.push(segment);
		handle.end();
		void this.#drain(entry, handle, segments.length > 0);
		return { streamId: this.#tts.add(entry), sampleRate: setup.sampleRate };
	}

	async ttsNext(params: unknown): Promise<{ chunks: string[]; done: boolean }> {
		const id = requiredString(params, "streamId");
		const entry = this.#tts.use(id);
		if (entry.queue.length === 0 && !entry.finished) {
			const { promise, resolve } = Promise.withResolvers<void>();
			const wake = () => {
				clearTimeout(timer);
				entry.waiters.delete(wake);
				resolve();
			};
			const timer = setTimeout(wake, waitMsOf(params));
			entry.waiters.add(wake);
			await promise;
		}
		if (entry.closed) return { chunks: [], done: true };
		this.#tts.use(id);
		const chunks = entry.queue.splice(0);
		if (chunks.length === 0 && entry.failure) {
			this.#tts.release(id);
			throw entry.failure;
		}
		const done = entry.finished && !entry.failure;
		if (done) this.#tts.release(id);
		return { chunks, done };
	}

	async ttsCancel(params: unknown): Promise<Record<string, never>> {
		this.#tts.drop(requiredString(params, "streamId"));
		return {};
	}

	/** The session ended: no worker keeps a stream nobody can read. */
	closeAll(): void {
		this.#stt.dropAll();
		this.#tts.dropAll();
	}

	async #drain(entry: TtsEntry, handle: TtsStreamHandle, expectAudio: boolean): Promise<void> {
		try {
			let count = 0;
			for await (const chunk of handle.chunks) {
				if (entry.closed) return;
				entry.queue.push(float32ToPcm16(chunk.pcm));
				count += 1;
				this.#wake(entry);
			}
			if (expectAudio && count === 0 && !entry.closed) throw new Error(TTS_UNAVAILABLE);
		} catch (error) {
			if (!entry.closed) entry.failure = error instanceof Error ? error : new Error(String(error));
		} finally {
			entry.finished = true;
			this.#wake(entry);
		}
	}

	#close(entry: TtsEntry): void {
		entry.closed = true;
		entry.cancel();
		this.#wake(entry);
	}

	#wake(entry: TtsEntry): void {
		for (const wake of [...entry.waiters]) wake();
	}
}
