/**
 * A fake microphone for dictation tests: `getUserMedia` hands out a stream
 * whose track records being released, `MediaRecorder` flushes the queued
 * chunks on stop like the real one, the analyser reports a fixed spectrum and
 * the offline render returns a constant signal. `install()` stubs the globals;
 * the test stubs `window.omp.rpc.transcribeAudio` itself.
 */
import { type Mock, vi } from "vitest";

/** A mic track that records whether it was released. */
export class FakeTrack {
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

export class FakeAudioContext {
	static instances: FakeAudioContext[] = [];
	readonly sampleRate = 48_000;
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
		};
	}
	createMediaStreamSource() {
		return { connect: () => undefined };
	}
	/** A quarter-second take. */
	async decodeAudioData() {
		return { duration: 0.25 };
	}
	async close(): Promise<void> {
		this.closed = true;
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
