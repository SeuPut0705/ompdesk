import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SttModelFacts } from "../../resources/gui-bridge/stt-language-core";
import {
	float32ToPcm16,
	IDLE_MS,
	pcm16ToFloat32,
	type SttSetup,
	type SttStreamOptions,
	type TtsChunk,
	type TtsSetup,
	type TtsStreamHandle,
	VoiceStreams,
} from "../../resources/gui-bridge/voice-stream-core";

/** Stock's catalog entries (stt/models.ts), the facts the bridge reads. */
const CATALOG: Record<string, SttModelFacts> = {
	"parakeet-tdt-0.6b-v3": { key: "parakeet-tdt-0.6b-v3", englishOnly: false, engine: "sherpa" },
	"whisper-large-v3-turbo": { key: "whisper-large-v3-turbo", englishOnly: false, engine: "transformers" },
};

/** Stock's STT client: the test plays the worker's stream through `options`, and answers whole passes itself. */
class FakeStt {
	pushed: Float32Array[] = [];
	cancelled = false;
	options!: SttStreamOptions;
	opened: { modelKey: string; language: string | undefined }[] = [];
	final = "";
	/** Stock's `stop()` stays pending until the worker answers; `cancel()` resolves it empty. */
	holdStop = false;
	#cancelStop: (() => void) | undefined;
	/** Every whole-clip pass asked of the worker (`transcribe`), with its audio. */
	passes: { modelKey: string; audio: number[]; language: string | undefined; signal: AbortSignal | undefined }[] = [];
	/** What a pass answers; a pass stays pending while `holdPass` is set, until `answerPass()`. */
	passText = "";
	holdPass = false;
	#answerPass: (() => void) | undefined;
	/** Models the worker was asked to have loaded (`downloadModel`). */
	loaded: string[] = [];

	answerPass(): void {
		this.#answerPass?.();
	}

	setup(language?: string): SttSetup {
		return {
			selected: CATALOG["parakeet-tdt-0.6b-v3"] as SttModelFacts,
			model: key => CATALOG[key] ?? (CATALOG["parakeet-tdt-0.6b-v3"] as SttModelFacts),
			language,
			client: {
				startStream: (modelKey, options) => {
					this.options = options;
					this.opened.push({ modelKey, language: options.language });
					return {
						pushAudio: audio => void this.pushed.push(audio),
						stop: () => {
							if (!this.holdStop) return Promise.resolve(this.final);
							const { promise, resolve } = Promise.withResolvers<string>();
							this.#cancelStop = () => resolve("");
							return promise;
						},
						cancel: () => {
							this.cancelled = true;
							this.#cancelStop?.();
						},
					};
				},
				transcribe: (modelKey, audio, options = {}) => {
					this.passes.push({ modelKey, audio: [...audio], language: options.language, signal: options.signal });
					if (!this.holdPass) return Promise.resolve(this.passText);
					const { promise, resolve, reject } = Promise.withResolvers<string>();
					this.#answerPass = () => resolve(this.passText);
					options.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
					return promise;
				},
				downloadModel: async modelKey => {
					this.loaded.push(modelKey);
					return { ok: true };
				},
			},
		};
	}
}

/** Stock's TTS stream: segments pushed by the bridge, chunks produced by the test. */
class FakeTts {
	segments: string[] = [];
	ended = false;
	signal!: AbortSignal;
	#queue: TtsChunk[] = [];
	#waiter: (() => void) | undefined;
	#closed = false;
	#failure: Error | undefined;

	emit(...samples: number[][]): void {
		for (const pcm of samples) this.#queue.push({ pcm: Float32Array.from(pcm), sampleRate: 24_000 });
		this.#wake();
	}

	finish(): void {
		this.#closed = true;
		this.#wake();
	}

	fail(error: Error): void {
		this.#failure = error;
		this.#wake();
	}

	#wake(): void {
		this.#waiter?.();
		this.#waiter = undefined;
	}

	setup(segment: (text: string) => string[] = text => (text ? [text] : [])): TtsSetup {
		return {
			modelKey: "kokoro",
			voice: "af_heart",
			sampleRate: 24_000,
			segment,
			client: {
				synthesizeStream: (_modelKey, options): TtsStreamHandle => {
					this.signal = options.signal;
					options.signal.addEventListener("abort", () => this.finish());
					const self = this;
					return {
						push: text => void this.segments.push(text),
						end: () => {
							this.ended = true;
						},
						chunks: (async function* () {
							while (true) {
								const next = self.#queue.shift();
								if (next) {
									yield next;
									continue;
								}
								if (self.#failure) throw self.#failure;
								if (self.#closed) return;
								const { promise, resolve } = Promise.withResolvers<void>();
								self.#waiter = resolve;
								await promise;
							}
						})(),
					};
				},
			},
		};
	}
}

function pcm(...samples: number[]): string {
	const out = new Int16Array(samples);
	return Buffer.from(out.buffer).toString("base64");
}

let stt: FakeStt;
let tts: FakeTts;
let streams: VoiceStreams<null>;

/** Stock's speech-model cache: what is here, and every download asked for (each lands at once). */
class FakeModels {
	cached = new Set(["parakeet-tdt-0.6b-v3"]);
	downloads: string[] = [];
	isCached = async (key: string) => this.cached.has(key);
	download = async (key: string, onProgress: (loaded: number, total: number) => void) => {
		this.downloads.push(key);
		onProgress(1, 1);
		this.cached.add(key);
	};
}

let models: FakeModels;

beforeEach(() => {
	vi.useFakeTimers();
	stt = new FakeStt();
	tts = new FakeTts();
	models = new FakeModels();
	streams = new VoiceStreams<null>({
		stt: async () => stt.setup("ko"),
		tts: async () => tts.setup(),
		sttModels: models,
	});
});

afterEach(() => {
	vi.useRealTimers();
});

describe("PCM16 over the bridge", () => {
	it("round-trips samples between PCM16 and the floats stock's workers take", () => {
		expect([...pcm16ToFloat32(pcm(0, 16384, -32768))]).toEqual([0, 0.5, -1]);
		const back = pcm16ToFloat32(float32ToPcm16(Float32Array.from([0, 0.5, -1, 2, -2])));
		expect([...back].map(sample => Math.round(sample * 1000) / 1000)).toEqual([0, 0.5, -1, 1, -1]);
	});

	it("refuses half a sample", () => {
		expect(() => pcm16ToFloat32(Buffer.from([1, 2, 3]).toString("base64"))).toThrow(/whole number/);
	});
});

describe("stt_stream_*", () => {
	it("opens English on the selected Parakeet, and has Korean's Whisper large-v3-turbo loaded once it is here", async () => {
		models.cached.add("whisper-large-v3-turbo");
		await streams.sttStart({ language: "en" }, null);
		await streams.sttStart({}, null);
		await streams.sttStart({ language: "ko-KR" }, null);
		expect(stt.opened).toEqual([{ modelKey: "parakeet-tdt-0.6b-v3", language: "en" }]);
		expect(stt.loaded).toEqual(["whisper-large-v3-turbo", "whisper-large-v3-turbo"]);
		expect(models.downloads).toEqual([]);
	});

	it("never makes a stream wait for the language's model: before it is here the selected model hears it", async () => {
		await streams.sttStart({}, null);
		expect(stt.opened).toEqual([{ modelKey: "parakeet-tdt-0.6b-v3", language: "ko" }]);
		expect(models.downloads).toEqual([]);
	});

	it("prepares the language's model: Korean downloads Whisper large-v3-turbo, English is ready on Parakeet", async () => {
		expect(await streams.sttPrepare({ language: "en" }, null)).toEqual({
			language: "en",
			modelKey: "parakeet-tdt-0.6b-v3",
			state: "ready",
		});
		expect(await streams.sttPrepare({}, null)).toMatchObject({
			language: "ko",
			modelKey: "whisper-large-v3-turbo",
			state: "downloading",
		});
		expect(models.downloads).toEqual(["whisper-large-v3-turbo"]);
		expect(await streams.sttPrepare({}, null)).toEqual({
			language: "ko",
			modelKey: "whisper-large-v3-turbo",
			state: "ready",
		});
		await streams.sttStart({}, null);
		expect(stt.loaded).toEqual(["whisper-large-v3-turbo"]);
	});

	it("a whole clip waits for the language's model, and says so when it cannot be had", async () => {
		expect(await streams.sttModel({}, null, "batch")).toMatchObject({
			modelKey: "whisper-large-v3-turbo",
			language: "ko",
		});
		expect(models.downloads).toEqual(["whisper-large-v3-turbo"]);
		models.cached.delete("whisper-large-v3-turbo");
		models.download = async () => {
			throw new Error("Failed to download speech model (onnx-community/whisper-large-v3-turbo): offline");
		};
		await expect(streams.sttModel({}, null, "batch")).rejects.toThrow(
			/whisper-large-v3-turbo for ko speech: .*offline/,
		);
	});

	it("feeds floats to the worker and answers the committed segments plus the current partial", async () => {
		const { streamId } = await streams.sttStart({}, null);
		expect(await streams.sttPush({ streamId, pcm16: pcm(16384, -16384) })).toEqual({ text: "" });
		expect([...(stt.pushed[0] ?? [])]).toEqual([0.5, -0.5]);

		stt.options.onPartial("hel");
		expect(await streams.sttPush({ streamId, pcm16: pcm(0) })).toEqual({ text: "hel" });
		stt.options.onSegment("hello there", 0);
		expect(await streams.sttPush({ streamId, pcm16: pcm(0) })).toEqual({ text: "hello there" });
		stt.options.onPartial("how are");
		expect(await streams.sttPush({ streamId, pcm16: pcm(0) })).toEqual({ text: "hello there how are" });
		stt.options.onSegment("how are you", 1);
		stt.options.onPartial("  ");
		expect(await streams.sttPush({ streamId, pcm16: pcm(0) })).toEqual({ text: "hello there how are you" });
	});

	it("stop answers the worker's final transcript and forgets the stream", async () => {
		const { streamId } = await streams.sttStart({}, null);
		stt.final = "hello there how are you";
		expect(await streams.sttStop({ streamId })).toEqual({ text: "hello there how are you" });
		await expect(streams.sttPush({ streamId, pcm16: pcm(0) })).rejects.toThrow("unknown_stream");
		await expect(streams.sttStop({ streamId })).rejects.toThrow("unknown_stream");
	});

	it("cancel tears the worker's stream down and forgets it", async () => {
		const { streamId } = await streams.sttStart({}, null);
		expect(await streams.sttCancel({ streamId })).toEqual({});
		expect(stt.cancelled).toBe(true);
		await expect(streams.sttPush({ streamId, pcm16: pcm(0) })).rejects.toThrow("unknown_stream");
		await expect(streams.sttCancel({ streamId })).rejects.toThrow("unknown_stream");
	});

	it("drops a stream nothing pushed to for 30 s, and a push keeps it alive", async () => {
		const { streamId } = await streams.sttStart({}, null);
		await vi.advanceTimersByTimeAsync(IDLE_MS - 1_000);
		await streams.sttPush({ streamId, pcm16: pcm(0) });
		await vi.advanceTimersByTimeAsync(IDLE_MS - 1_000);
		expect(stt.cancelled).toBe(false);
		await streams.sttPush({ streamId, pcm16: pcm(0) });

		await vi.advanceTimersByTimeAsync(IDLE_MS);
		expect(stt.cancelled).toBe(true);
		await expect(streams.sttPush({ streamId, pcm16: pcm(0) })).rejects.toThrow("unknown_stream");
	});

	it("cancels a stop the worker never answers once the stream has been idle that long", async () => {
		const { streamId } = await streams.sttStart({}, null);
		stt.holdStop = true;
		const stopping = streams.sttStop({ streamId });
		await vi.advanceTimersByTimeAsync(IDLE_MS);
		expect(stt.cancelled).toBe(true);
		expect(await stopping).toEqual({ text: "" });
		await expect(streams.sttPush({ streamId, pcm16: pcm(0) })).rejects.toThrow("unknown_stream");
	});

	it("knows no stream it never opened", async () => {
		await expect(streams.sttPush({ streamId: "nope", pcm16: pcm(0) })).rejects.toThrow("unknown_stream");
		await expect(streams.sttPush({ pcm16: pcm(0) })).rejects.toThrow("Missing streamId");
	});
});

// The owner's decision (3 Nov 2026): Whisper is an offline model, so a call in its language is transcribed once, after the
// speech ended. Its running text cost a whole pass of the utterance every few hundred ms (about 6 s each for
// large-v3-turbo on this Mac), and the final text came 14.9 s after the speech.
describe("a stream on Whisper large-v3-turbo", () => {
	beforeEach(() => {
		models.cached.add("whisper-large-v3-turbo");
	});

	it("asks no pass while the person speaks, and one pass of the whole utterance after the stop", async () => {
		stt.passText = "안녕하세요";
		const { streamId } = await streams.sttStart({ language: "ko" }, null);
		expect(await streams.sttPush({ streamId, pcm16: pcm(16384) })).toEqual({ text: "" });
		expect(await streams.sttPush({ streamId, pcm16: pcm(-16384, 0) })).toEqual({ text: "" });
		expect(stt.passes).toEqual([]);
		expect(stt.opened).toEqual([]);

		expect(await streams.sttStop({ streamId })).toEqual({ text: "안녕하세요" });
		expect(stt.passes).toEqual([
			{ modelKey: "whisper-large-v3-turbo", audio: [0.5, -0.5, 0], language: "ko", signal: expect.any(AbortSignal) },
		]);
		await expect(streams.sttPush({ streamId, pcm16: pcm(0) })).rejects.toThrow("unknown_stream");
	});

	it("has the model loaded from the stream's start, so the pass after the speech does not load it too", async () => {
		await streams.sttStart({ language: "ko" }, null);
		expect(stt.loaded).toEqual(["whisper-large-v3-turbo"]);
	});

	it("asks no pass of an utterance that carried no audio", async () => {
		const { streamId } = await streams.sttStart({ language: "ko" }, null);
		expect(await streams.sttStop({ streamId })).toEqual({ text: "" });
		expect(stt.passes).toEqual([]);
	});

	it("cancel aborts a pass under way, and its stop answers nothing", async () => {
		stt.holdPass = true;
		stt.passText = "안녕하세요";
		const { streamId } = await streams.sttStart({ language: "ko" }, null);
		await streams.sttPush({ streamId, pcm16: pcm(16384) });
		const stopped = streams.sttStop({ streamId });
		await vi.advanceTimersByTimeAsync(0);
		expect(stt.passes).toHaveLength(1);
		expect(await streams.sttCancel({ streamId })).toEqual({});
		expect(stt.passes[0]?.signal?.aborted).toBe(true);
		expect(await stopped).toEqual({ text: "" });
	});

	it("leaves English on Parakeet with its running words", async () => {
		const { streamId } = await streams.sttStart({ language: "en" }, null);
		expect(stt.opened).toEqual([{ modelKey: "parakeet-tdt-0.6b-v3", language: "en" }]);
		stt.options.onPartial("hello");
		expect(await streams.sttPush({ streamId, pcm16: pcm(0) })).toEqual({ text: "hello" });
		expect(stt.passes).toEqual([]);
		expect(stt.loaded).toEqual([]);
	});
});

describe("tts_stream_*", () => {
	it("feeds the speakable segments to the worker, then ends its input, and reports the model's rate", async () => {
		streams = new VoiceStreams<null>({
			stt: async () => stt.setup(),
			tts: async () => tts.setup(text => text.split(". ")),
			sttModels: models,
		});
		const started = await streams.ttsStart({ text: "One. Two. Three" }, null);
		expect(started).toMatchObject({ sampleRate: 24_000 });
		expect(started.streamId).toBeTruthy();
		expect(tts.segments).toEqual(["One", "Two", "Three"]);
		expect(tts.ended).toBe(true);
	});

	it("long-polls: answers at once with what is ready, else when a chunk lands, else empty after waitMs", async () => {
		const { streamId } = await streams.ttsStart({ text: "hello" }, null);

		const empty = streams.ttsNext({ streamId, waitMs: 1_000 });
		await vi.advanceTimersByTimeAsync(999);
		let settled = false;
		void empty.then(() => {
			settled = true;
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(await empty).toEqual({ chunks: [], done: false });

		const waiting = streams.ttsNext({ streamId, waitMs: 5_000 });
		await vi.advanceTimersByTimeAsync(300);
		tts.emit([0.5]);
		const got = await waiting;
		expect(got.done).toBe(false);
		expect(got.chunks.map(chunk => [...pcm16ToFloat32(chunk)].map(sample => Math.round(sample * 10) / 10))).toEqual([
			[0.5],
		]);

		tts.emit([0.25]);
		await vi.advanceTimersByTimeAsync(0);
		const ready = await streams.ttsNext({ streamId });
		expect(ready.chunks).toHaveLength(1);
	});

	it("keeps chunks in order across polls, answers done once drained, then forgets the stream", async () => {
		const { streamId } = await streams.ttsStart({ text: "hello" }, null);
		tts.emit([0.1], [0.2]);
		await vi.advanceTimersByTimeAsync(0);
		const first = await streams.ttsNext({ streamId });
		tts.emit([0.3]);
		tts.finish();
		await vi.advanceTimersByTimeAsync(0);
		const last = await streams.ttsNext({ streamId });
		const level = (chunk: string) => Math.round((pcm16ToFloat32(chunk)[0] ?? 0) * 10);
		expect(first.chunks.map(level)).toEqual([1, 2]);
		expect(first.done).toBe(false);
		expect(last.chunks.map(level)).toEqual([3]);
		expect(last.done).toBe(true);
		await expect(streams.ttsNext({ streamId })).rejects.toThrow("unknown_stream");
	});

	it("answers done without chunks for text with nothing to speak", async () => {
		streams = new VoiceStreams<null>({
			stt: async () => stt.setup(),
			tts: async () => tts.setup(() => []),
			sttModels: models,
		});
		const { streamId } = await streams.ttsStart({ text: "```code```" }, null);
		await vi.advanceTimersByTimeAsync(0);
		tts.finish();
		expect(await streams.ttsNext({ streamId })).toEqual({ chunks: [], done: true });
	});

	it("clamps the wait to 5 s", async () => {
		const { streamId } = await streams.ttsStart({ text: "hello" }, null);
		const poll = streams.ttsNext({ streamId, waitMs: 60_000 });
		await vi.advanceTimersByTimeAsync(5_000);
		expect(await poll).toEqual({ chunks: [], done: false });
	});

	it("cancel aborts the worker's stream and ends a poll in flight", async () => {
		const { streamId } = await streams.ttsStart({ text: "hello" }, null);
		const poll = streams.ttsNext({ streamId, waitMs: 5_000 });
		await vi.advanceTimersByTimeAsync(100);
		expect(await streams.ttsCancel({ streamId })).toEqual({});
		expect(tts.signal.aborted).toBe(true);
		expect(await poll).toEqual({ chunks: [], done: true });
		await expect(streams.ttsNext({ streamId })).rejects.toThrow("unknown_stream");
		await expect(streams.ttsCancel({ streamId })).rejects.toThrow("unknown_stream");
	});

	it("drops a stream nothing polled for 30 s", async () => {
		const { streamId } = await streams.ttsStart({ text: "hello" }, null);
		await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
		const poll = streams.ttsNext({ streamId, waitMs: 0 });
		await vi.advanceTimersByTimeAsync(0);
		await poll;
		await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
		expect(tts.signal.aborted).toBe(false);

		await vi.advanceTimersByTimeAsync(2);
		expect(tts.signal.aborted).toBe(true);
		await expect(streams.ttsNext({ streamId })).rejects.toThrow("unknown_stream");
	});

	it("hands over the chunks made before a failure, then raises it", async () => {
		const { streamId } = await streams.ttsStart({ text: "hello" }, null);
		tts.emit([0.1]);
		tts.fail(new Error("worker crashed"));
		await vi.advanceTimersByTimeAsync(0);
		const first = await streams.ttsNext({ streamId });
		expect(first.chunks).toHaveLength(1);
		expect(first.done).toBe(false);
		await expect(streams.ttsNext({ streamId })).rejects.toThrow("worker crashed");
		await expect(streams.ttsNext({ streamId })).rejects.toThrow("unknown_stream");
	});

	it("refuses a stream that ends without any audio for text it had to speak, as the batch path does", async () => {
		const { streamId } = await streams.ttsStart({ text: "hello" }, null);
		tts.finish();
		await vi.advanceTimersByTimeAsync(0);
		await expect(streams.ttsNext({ streamId })).rejects.toThrow("Local TTS model is unavailable");
	});
});

describe("closeAll", () => {
	it("cancels every open stream when the session ends", async () => {
		const { streamId: spoken } = await streams.sttStart({}, null);
		const { streamId: heard } = await streams.ttsStart({ text: "hello" }, null);
		streams.closeAll();
		expect(stt.cancelled).toBe(true);
		expect(tts.signal.aborted).toBe(true);
		await expect(streams.sttPush({ streamId: spoken, pcm16: pcm(0) })).rejects.toThrow("unknown_stream");
		await expect(streams.ttsNext({ streamId: heard })).rejects.toThrow("unknown_stream");
	});
});
