import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
	decodeWav,
	FakeAudioContext,
	FakeMediaRecorder,
	type FakeMic,
	FakeOfflineAudioContext,
	FakeStream,
	installFakeMic,
	RENDERED_SAMPLE,
	SPECTRUM_LEVEL,
	uninstallFakeMic,
} from "../test-support/dictation";
import { translate } from "./i18n";
import { cancelVoiceRecording, METER_BARS, recordAndTranscribe, stopVoiceRecording } from "./voice";

interface RpcReply {
	success: boolean;
	data?: unknown;
	error?: string;
}

let mic: FakeMic;
let transcribeAudio: Mock<(audio: string, mimeType: string) => Promise<RpcReply>>;

/** Resolve pending promise callbacks (the recorder starts after `getUserMedia` resolves). */
async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
	vi.useFakeTimers();
	mic = installFakeMic();
	transcribeAudio = vi.fn(async () => ({ success: true, data: { text: "hello there" } }));
	vi.stubGlobal("window", { omp: { rpc: { transcribeAudio } } });
});

afterEach(() => {
	// A failed test must not leave the module's single recording slot taken.
	cancelVoiceRecording();
	vi.useRealTimers();
	uninstallFakeMic();
});

describe("recordAndTranscribe", () => {
	it("follows recording → levels → transcribing and sends a 16 kHz mono WAV", async () => {
		const phases: string[] = [];
		const levels: (readonly number[])[] = [];
		const take = recordAndTranscribe({
			onRecording: () => phases.push("recording"),
			onLevels: next => levels.push(next),
			onTranscribing: () => phases.push("transcribing"),
		});
		await flush();
		expect(mic.getUserMedia).toHaveBeenCalledWith({
			audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
		});
		expect(phases).toEqual(["recording"]);
		expect(FakeMediaRecorder.instances[0]?.state).toBe("recording");

		vi.advanceTimersByTime(130);
		expect(levels).toHaveLength(2);
		expect(levels[0]).toHaveLength(METER_BARS);
		expect(levels[0]?.every(level => level === SPECTRUM_LEVEL / 200)).toBe(true);

		stopVoiceRecording();
		await expect(take).resolves.toEqual({ text: "hello there" });
		expect(phases).toEqual(["recording", "transcribing"]);
		expect(mic.streams[0]?.track.stopped).toBe(true);
		// The meter's context and the decode context are both closed.
		expect(FakeAudioContext.instances.map(context => context.closed)).toEqual([true, true]);
		// The meter stops publishing once the take ends.
		vi.advanceTimersByTime(500);
		expect(levels).toHaveLength(2);

		// A quarter second at 16 kHz.
		expect(FakeOfflineAudioContext.last).toMatchObject({ channels: 1, length: 4000, sampleRate: 16_000 });
		expect(transcribeAudio).toHaveBeenCalledTimes(1);
		const [audio, mimeType] = transcribeAudio.mock.calls[0]!;
		expect(mimeType).toBe("audio/wav");
		const wav = decodeWav(audio);
		expect(wav.byteLength).toBe(44 + 4000 * 2);
		expect(wav.getUint16(22, true)).toBe(1);
		expect(wav.getUint32(24, true)).toBe(16_000);
		expect(wav.getInt16(44, true)).toBe(Math.round(RENDERED_SAMPLE * 32_767));
	});

	it("skips the meter when nobody listens for levels", async () => {
		const take = recordAndTranscribe();
		await flush();
		expect(FakeAudioContext.instances).toHaveLength(0);
		stopVoiceRecording();
		await expect(take).resolves.toEqual({ text: "hello there" });
	});

	it("discards a take cancelled while recording, without transcribing", async () => {
		const onTranscribing = vi.fn();
		const take = recordAndTranscribe({ onTranscribing });
		await flush();
		cancelVoiceRecording();
		await expect(take).resolves.toEqual({ error: "" });
		expect(onTranscribing).not.toHaveBeenCalled();
		expect(transcribeAudio).not.toHaveBeenCalled();
		expect(mic.streams[0]?.track.stopped).toBe(true);
	});

	it("discards a take cancelled while the mic still opens and releases the mic once it has", async () => {
		const opened = Promise.withResolvers<FakeStream>();
		mic.getUserMedia.mockImplementationOnce(() => opened.promise);
		const onRecording = vi.fn();
		const take = recordAndTranscribe({ onRecording });
		cancelVoiceRecording();
		const stream = new FakeStream();
		opened.resolve(stream);
		await expect(take).resolves.toEqual({ error: "" });
		expect(FakeMediaRecorder.instances).toHaveLength(0);
		expect(onRecording).not.toHaveBeenCalled();
		expect(stream.track.stopped).toBe(true);
	});

	it("refuses a second take while one is opening or recording", async () => {
		const first = recordAndTranscribe();
		await expect(recordAndTranscribe()).resolves.toEqual({ error: translate("voice.mic.busy") });
		await flush();
		await expect(recordAndTranscribe()).resolves.toEqual({ error: translate("voice.mic.busy") });
		stopVoiceRecording();
		await expect(first).resolves.toEqual({ text: "hello there" });
		// The slot frees up after the take.
		const next = recordAndTranscribe();
		await flush();
		stopVoiceRecording();
		await expect(next).resolves.toEqual({ text: "hello there" });
	});

	it("reports an empty take instead of transcribing silence", async () => {
		FakeMediaRecorder.nextChunks = [new Blob([])];
		const take = recordAndTranscribe();
		await flush();
		stopVoiceRecording();
		await expect(take).resolves.toEqual({ error: translate("voice.mic.empty") });
		expect(transcribeAudio).not.toHaveBeenCalled();
	});

	it("passes a refused mic and a failed transcription through as errors", async () => {
		mic.getUserMedia.mockImplementationOnce(async () => {
			throw new Error("Permission denied");
		});
		await expect(recordAndTranscribe()).resolves.toEqual({ error: "Permission denied" });

		transcribeAudio.mockImplementationOnce(async () => ({ success: false, error: "stt unavailable" }));
		const take = recordAndTranscribe();
		await flush();
		stopVoiceRecording();
		await expect(take).resolves.toEqual({ error: "stt unavailable" });
	});
});
