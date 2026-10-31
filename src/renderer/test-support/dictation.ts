/**
 * A fake microphone for dictation tests: `getUserMedia` hands out a stream
 * whose track records being released, `MediaRecorder` flushes the queued
 * chunks on stop like the real one, the analyser reports a fixed spectrum and
 * the offline render returns a constant signal. `install()` stubs the globals;
 * the test stubs `window.omp.rpc.transcribeAudio` itself. For the streaming voice call the context also hands out
 * script processors (fed `FakeAudioContext.level` blocks by a timer, as the mic would) and buffer sources a test can
 * finish by hand.
 */
import { type Mock, vi } from "vitest";

/** A mic track that records whether it was released. */
export class FakeTrack {
	enabled = true;
	stopped = false;
	stop(): void {
		this.stopped = true;
	}
}

export class FakeStream {
	readonly track = new FakeTrack();
	getTracks(): FakeTrack[] {
		return [this.track];
	}
}

/** A non-empty take, as a webm chunk. */
export const AUDIO_CHUNK = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "audio/webm" });

export class FakeMediaRecorder {
	static instances: FakeMediaRecorder[] = [];
	/** What the next take hands over through `ondataavailable` on stop. */
	static nextChunks: Blob[] = [AUDIO_CHUNK];
	state: "inactive" | "recording" = "inactive";
	mimeType = "audio/webm";
	ondataavailable: ((event: { data: Blob }) => void) | null = null;
	onstop: (() => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(readonly stream: FakeStream) {
		FakeMediaRecorder.instances.push(this);
	}
	start(): void {
		this.state = "recording";
	}
	stop(): void {
		this.state = "inactive";
		for (const data of FakeMediaRecorder.nextChunks) this.ondataavailable?.({ data });
		this.onstop?.();
	}
}

/** Every byte of the analyser's spectrum, so the meter's bars are predictable. */
export const SPECTRUM_LEVEL = 100;

/** A scheduled chunk of reply audio: it plays until the test calls {@link finish}, or until it is stopped. */
export class FakeBufferSource {
	buffer: { duration: number; length: number; sampleRate: number } | null = null;
	onended: (() => void) | null = null;
	/** The context time `start` was given. */
	startedAt: number | null = null;
	stopped = false;
	start(when: number): void {
		this.startedAt = when;
	}
	stop(): void {
		this.stopped = true;
	}
	connect(): void {}
	disconnect(): void {}
	/** The source played to its end. */
	finish(): void {
		this.onended?.();
	}
}

/** The mic's raw PCM node: every block is `FakeAudioContext.level` for as long as the block would last. */
export class FakeScriptProcessor {
	onaudioprocess: ((event: { inputBuffer: { getChannelData(channel: number): Float32Array } }) => void) | null = null;
	readonly #timer: ReturnType<typeof setInterval>;
	constructor(sampleRate: number, blockFrames: number) {
		this.#timer = setInterval(
			() => {
				const block = new Float32Array(blockFrames).fill(FakeAudioContext.level);
				this.onaudioprocess?.({ inputBuffer: { getChannelData: () => block } });
			},
			(blockFrames / sampleRate) * 1000,
		);
	}
	connect(): void {}
	disconnect(): void {
		clearInterval(this.#timer);
	}
}

export class FakeAudioContext {
	static instances: FakeAudioContext[] = [];
	/** The mic's instantaneous level (every time-domain sample), which the voice call's VAD reads as RMS; tests move it. */
	static level = 0;
	readonly sampleRate = 48_000;
	/** Moved by the test; reply chunks are scheduled against it. */
	currentTime = 0;
	readonly destination = {};
	/** Every buffer source the context handed out, oldest first. */
	readonly sources: FakeBufferSource[] = [];
	readonly #processors: FakeScriptProcessor[] = [];
	closed = false;
	constructor() {
		FakeAudioContext.instances.push(this);
	}
	createAnalyser() {
		return {
			fftSize: 0,
			smoothingTimeConstant: 0,
			frequencyBinCount: 128,
			getByteFrequencyData: (bins: Uint8Array) => bins.fill(SPECTRUM_LEVEL),
			getFloatTimeDomainData: (samples: Float32Array) => samples.fill(FakeAudioContext.level),
		};
	}
	createMediaStreamSource() {
		return { connect: () => undefined, disconnect: () => undefined };
	}
	createScriptProcessor(blockFrames: number): FakeScriptProcessor {
		const processor = new FakeScriptProcessor(this.sampleRate, blockFrames);
		this.#processors.push(processor);
		return processor;
	}
	createBuffer(_channels: number, length: number, sampleRate: number) {
		const data = new Float32Array(length);
		return { length, sampleRate, duration: length / sampleRate, getChannelData: () => data };
	}
	createBufferSource(): FakeBufferSource {
		const source = new FakeBufferSource();
		this.sources.push(source);
		return source;
	}
	/** A quarter-second take. */
	async decodeAudioData() {
		return { duration: 0.25 };
	}
	async close(): Promise<void> {
		this.closed = true;
		for (const processor of this.#processors) processor.disconnect();
	}
}

/** The rendered signal: every sample at this level. */
export const RENDERED_SAMPLE = 0.5;

export class FakeOfflineAudioContext {
	static last: FakeOfflineAudioContext | null = null;
	readonly destination = {};
	constructor(
		readonly channels: number,
		readonly length: number,
		readonly sampleRate: number,
	) {
		FakeOfflineAudioContext.last = this;
	}
	createBufferSource() {
		return { buffer: null, connect: () => undefined, start: () => undefined };
	}
	async startRendering() {
		const samples = new Float32Array(this.length).fill(RENDERED_SAMPLE);
		return { getChannelData: () => samples };
	}
}

export interface FakeMic {
	/** Every stream `getUserMedia` handed out, oldest first. */
	streams: FakeStream[];
	getUserMedia: Mock<(constraints: MediaStreamConstraints) => Promise<FakeStream>>;
}

/** Stub the audio globals and `navigator.mediaDevices`; undo with {@link uninstallFakeMic}. */
export function installFakeMic(): FakeMic {
	const streams: FakeStream[] = [];
	const getUserMedia = vi.fn(async (_constraints: MediaStreamConstraints): Promise<FakeStream> => {
		const stream = new FakeStream();
		streams.push(stream);
		return stream;
	});
	FakeMediaRecorder.instances = [];
	FakeMediaRecorder.nextChunks = [AUDIO_CHUNK];
	FakeAudioContext.instances = [];
	FakeAudioContext.level = 0;
	FakeOfflineAudioContext.last = null;
	vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
	vi.stubGlobal("AudioContext", FakeAudioContext);
	vi.stubGlobal("OfflineAudioContext", FakeOfflineAudioContext);
	Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
	return { streams, getUserMedia };
}

export function uninstallFakeMic(): void {
	vi.unstubAllGlobals();
	Reflect.deleteProperty(navigator, "mediaDevices");
}

/** The WAV a `transcribeAudio` call carried. */
export function decodeWav(base64: string): DataView {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return new DataView(bytes.buffer);
}
