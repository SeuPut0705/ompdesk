import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/** Stock's STT stream: the test plays the worker through `options`. */
class FakeStt {
	pushed: Float32Array[] = [];
	cancelled = false;
	options!: SttStreamOptions;
	opened: { modelKey: string; language: string | undefined }[] = [];
	final = "";
	/** Stock's `stop()` stays pending until the worker answers; `cancel()` resolves it empty. */
	holdStop = false;
	#cancelStop: (() => void) | undefined;

	setup(language?: string): SttSetup {
		return {
			modelKey: "parakeet",
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

beforeEach(() => {
	vi.useFakeTimers();
	stt = new FakeStt();
	tts = new FakeTts();
	streams = new VoiceStreams<null>({ stt: async () => stt.setup("ko"), tts: async () => tts.setup() });
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
	it("opens on the dictation model, the request's language over the setting's", async () => {
		await streams.sttStart({}, null);
		await streams.sttStart({ language: "en" }, null);
		expect(stt.opened).toEqual([
			{ modelKey: "parakeet", language: "ko" },
			{ modelKey: "parakeet", language: "en" },
		]);
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

describe("tts_stream_*", () => {
	it("feeds the speakable segments to the worker, then ends its input, and reports the model's rate", async () => {
		streams = new VoiceStreams<null>({
			stt: async () => stt.setup(),
			tts: async () => tts.setup(text => text.split(". ")),
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
		streams = new VoiceStreams<null>({ stt: async () => stt.setup(), tts: async () => tts.setup(() => []) });
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
