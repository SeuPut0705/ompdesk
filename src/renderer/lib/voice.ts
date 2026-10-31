/**
 * Voice in/out for the GUI (agent settings `stt.*` / `speech.*`).
 *
 * Mirrors the TUI voice paths:
 * - STT (stt-controller): 16 kHz mono PCM is the pipeline's native rate, so
 *   the MediaRecorder capture is decoded and resampled here, shipped to the
 *   sidecar as a canonical WAV buffer, and transcribed by the worker-based
 *   whisper pipeline (`transcribe_audio` RPC).
 * - Speech (vocalizer/event-controller): `speech.mode` decides what gets
 *   spoken — "assistant" speaks finalized assistant text, "all" also speaks
 *   tool-result text, "yield" speaks only the last assistant message of a
 *   run. Synthesis runs on the sidecar's local TTS (`synthesize_speech` RPC);
 *   playback is a plain Audio element.
 *
 * Playback policy: one utterance at a time — a speak request arriving while
 * another is still synthesizing or playing is DROPPED (documented choice;
 * the TUI vocalizer chains utterances, the GUI keeps the transport simple).
 */
import type { SynthesizeSpeechResult, TranscribeAudioResult } from "../../shared/rpc-types";
import { useBotStore } from "../stores/bot";
import { useBotDeskStore } from "../stores/bot-desk";
import { useMessagesStore } from "../stores/messages";
import { useSessionStore } from "../stores/session";
import { useSettingsStore } from "../stores/settings";
import { useTabsStore } from "../stores/tabs";
import { toastError } from "../stores/toast";
import { translate } from "./i18n";
import { messageText } from "./messages";

const STT_SAMPLE_RATE = 16_000;
const WAV_HEADER_BYTES = 44;

// ---------------------------------------------------------------------------
// WAV (PCM16 mono) writer — mirrors encodeWav in the agent's tts/wav.ts; the
// GUI has no runtime dependency on the agent package, so keep these in sync.
// ---------------------------------------------------------------------------

function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
	const dataBytes = samples.length * 2;
	const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
	const view = new DataView(buffer);
	const writeAscii = (offset: number, text: string): void => {
		for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
	};
	writeAscii(0, "RIFF");
	view.setUint32(4, WAV_HEADER_BYTES - 8 + dataBytes, true);
	writeAscii(8, "WAVE");
	writeAscii(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true); // byte rate
	view.setUint16(32, 2, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	writeAscii(36, "data");
	view.setUint32(40, dataBytes, true);
	let offset = WAV_HEADER_BYTES;
	for (let i = 0; i < samples.length; i += 1) {
		const sample = samples[i]!;
		const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample;
		view.setInt16(offset, Math.round(clamped < 0 ? clamped * 32_768 : clamped * 32_767), true);
		offset += 2;
	}
	return new Uint8Array(buffer);
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
	const binary = atob(base64);
	// A fresh ArrayBuffer keeps the type BlobPart-compatible
	// (Uint8Array<ArrayBufferLike> is rejected under TS's generic ArrayBuffer).
	const bytes = new Uint8Array(new ArrayBuffer(binary.length));
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** Read one agent setting at decision time (never cached across a run). */
async function readSetting(path: string): Promise<unknown> {
	try {
		const response = await window.omp.rpc.getSettings([path]);
		if (!response.success) return undefined;
		return (response.data as { values?: Record<string, unknown> } | undefined)?.values?.[path];
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Mic dictation (stt.enabled, stt.submitTrigger)
// ---------------------------------------------------------------------------

interface ActiveVoiceRecording {
	recorder: MediaRecorder;
	stream: MediaStream;
	chunks: Blob[];
	cancelled: boolean;
}

let activeRecording: ActiveVoiceRecording | null = null;
/** `getUserMedia` is still opening the mic; a cancel then lands once it has. */
let startPending = false;
let cancelBeforeStart = false;

/** What the composer shows while dictating (all optional). */
export interface DictationListener {
	/** The mic is open and capturing (after the permission prompt and device start). */
	onRecording?: () => void;
	/** Mic level as {@link METER_BARS} bars in 0–1, a few times a second while capturing. */
	onLevels?: (levels: readonly number[]) => void;
	/** Capture ended with audio; the take is being transcribed. */
	onTranscribing?: () => void;
}

/** Bars in the dictation level meter. */
export const METER_BARS = 5;
/** How often the meter publishes a level (ms): smooth enough, without a render per frame. */
const METER_INTERVAL_MS = 60;

/**
 * The spectrum as {@link METER_BARS} bands of the speech range (≈ 0–4 kHz of an AnalyserNode's byte spectrum), each in
 * 0–1. Shared by the dictation meter and the voice call's.
 */
export function speechBandLevels(bins: Uint8Array, sampleRate: number): number[] {
	const speechBins = Math.max(METER_BARS, Math.round((4000 / (sampleRate / 2)) * bins.length));
	const perBar = Math.floor(speechBins / METER_BARS);
	const levels: number[] = [];
	for (let bar = 0; bar < METER_BARS; bar++) {
		let sum = 0;
		for (let index = bar * perBar; index < (bar + 1) * perBar; index++) sum += bins[index] ?? 0;
		levels.push(Math.min(1, sum / perBar / 200));
	}
	return levels;
}

/** Publish the stream's level as {@link METER_BARS} bands. Returns the stop function. */
function startLevelMeter(stream: MediaStream, onLevels: (levels: readonly number[]) => void): () => void {
	const context = new AudioContext();
	const analyser = context.createAnalyser();
	analyser.fftSize = 256;
	analyser.smoothingTimeConstant = 0.6;
	context.createMediaStreamSource(stream).connect(analyser);
	const bins = new Uint8Array(analyser.frequencyBinCount);
	const timer = setInterval(() => {
		analyser.getByteFrequencyData(bins);
		onLevels(speechBandLevels(bins, context.sampleRate));
	}, METER_INTERVAL_MS);
	return () => {
		clearInterval(timer);
		void context.close();
	};
}

/** Stop the active recording; the pending {@link recordAndTranscribe} then resolves with the transcript. */
export function stopVoiceRecording(): void {
	if (activeRecording && activeRecording.recorder.state !== "inactive") activeRecording.recorder.stop();
}

/** Discard the take without transcribing (Esc while dictating, composer unmount); also while the mic still opens. */
export function cancelVoiceRecording(): void {
	if (!activeRecording) {
		if (startPending) cancelBeforeStart = true;
		return;
	}
	activeRecording.cancelled = true;
	stopVoiceRecording();
}

/** Why a take failed, as far as the browser and the sidecar say; the composer maps each to its own message and next step. */
export type DictationFailure = "denied" | "no-device" | "in-use" | "busy" | "empty" | "no-model" | "failed";

export type DictationResult = { text: string } | { error: string; failure?: DictationFailure };

/** `getUserMedia` rejections by DOMException name (Chromium: NotAllowedError, NotFoundError, NotReadableError). */
export function classifyMicError(cause: unknown): DictationFailure {
	const name = typeof cause === "object" && cause !== null && "name" in cause ? String(cause.name) : "";
	if (/^(NotAllowedError|SecurityError|PermissionDeniedError)$/.test(name)) return "denied";
	if (/^(NotFoundError|DevicesNotFoundError|OverconstrainedError)$/.test(name)) return "no-device";
	if (/^(NotReadableError|TrackStartError|AbortError)$/.test(name)) return "in-use";
	return "failed";
}

/** The sidecar's failure text: only a missing or unknown dictation model is told apart ("No stt model devices configured", "Unknown stt model: x" in stock); the rest stays "failed". */
export function classifyTranscribeError(message: string): DictationFailure {
	if (
		/\bunknown (stt|dictation|speech) model\b|\b(no|missing|unset)\b[^.]*\b(dictation|stt|transcription)\b[^.]*\b(model|role)\b|\b(dictation|stt|transcription)\s+(model|role)\b[^.]*\b(not|unset|missing|configured|found|available)\b/i.test(
			message,
		)
	)
		return "no-model";
	return "failed";
}

/**
 * Capture mic audio until {@link stopVoiceRecording} fires, resample to the
 * STT pipeline's 16 kHz mono PCM, and transcribe via the sidecar. Resolves
 * with `{ text }` (possibly empty) or `{ error }` (empty string when the
 * take was discarded; otherwise `failure` says why). `listener` follows the phases for the composer's overlay.
 */
export async function recordAndTranscribe(listener: DictationListener = {}): Promise<DictationResult> {
	if (activeRecording || startPending) return { error: translate("voice.mic.busy"), failure: "busy" };
	startPending = true;
	cancelBeforeStart = false;
	let stream: MediaStream;
	try {
		stream = await navigator.mediaDevices.getUserMedia({
			audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
		});
	} catch (cause) {
		return { error: cause instanceof Error ? cause.message : String(cause), failure: classifyMicError(cause) };
	} finally {
		startPending = false;
	}
	if (cancelBeforeStart) {
		for (const track of stream.getTracks()) track.stop();
		return { error: "" };
	}
	const recorder = new MediaRecorder(stream);
	const state: ActiveVoiceRecording = { recorder, stream, chunks: [], cancelled: false };
	activeRecording = state;
	const stopped = Promise.withResolvers<void>();
	recorder.ondataavailable = event => {
		if (event.data.size > 0) state.chunks.push(event.data);
	};
	recorder.onerror = () => stopped.resolve();
	recorder.onstop = () => stopped.resolve();
	recorder.start();
	const stopMeter = listener.onLevels ? startLevelMeter(stream, listener.onLevels) : undefined;
	listener.onRecording?.();
	await stopped.promise;
	stopMeter?.();
	for (const track of stream.getTracks()) track.stop();
	if (activeRecording === state) activeRecording = null;
	if (state.cancelled) return { error: "" };
	if (state.chunks.length === 0) return { error: translate("voice.mic.empty"), failure: "empty" };
	listener.onTranscribing?.();
	return transcribeBlob(new Blob(state.chunks, { type: recorder.mimeType || "audio/webm" }));
}

/**
 * One recorded take (whatever the browser's recorder produced) to text: decoded, resampled to the STT pipeline's 16 kHz
 * mono PCM, shipped to the sidecar as a WAV and transcribed. Dictation and the voice call share it.
 */
export async function transcribeBlob(blob: Blob): Promise<DictationResult> {
	try {
		const encoded = await blob.arrayBuffer();
		const context = new AudioContext();
		let wav: Uint8Array;
		try {
			const decoded = await context.decodeAudioData(encoded);
			// Offline render resamples whatever the mic produced to 16 kHz mono.
			const offline = new OfflineAudioContext(
				1,
				Math.max(1, Math.ceil(decoded.duration * STT_SAMPLE_RATE)),
				STT_SAMPLE_RATE,
			);
			const source = offline.createBufferSource();
			source.buffer = decoded;
			source.connect(offline.destination);
			source.start(0);
			const rendered = await offline.startRendering();
			wav = encodeWavPcm16(rendered.getChannelData(0), STT_SAMPLE_RATE);
		} finally {
			void context.close();
		}
		const response = await window.omp.rpc.transcribeAudio(bytesToBase64(wav), "audio/wav");
		if (!response.success) return { error: response.error, failure: classifyTranscribeError(response.error) };
		return { text: (response.data as TranscribeAudioResult | undefined)?.text ?? "" };
	} catch (cause) {
		return { error: cause instanceof Error ? cause.message : String(cause), failure: "failed" };
	}
}

// ---------------------------------------------------------------------------
// `stt.submitTrigger` evaluation — mirrors evaluateSubmitTrigger in the
// agent's stt/submit-trigger.ts. Keep the two in sync.
// ---------------------------------------------------------------------------

export type SttSubmitTrigger = "never" | "release" | "release-complete" | "say-submit";

const STT_SUBMIT_TRIGGERS: Record<string, true> = {
	never: true,
	release: true,
	"release-complete": true,
	"say-submit": true,
};

/** Read the live `stt.submitTrigger` setting (schema default "never"). */
export async function readSttSubmitTrigger(): Promise<SttSubmitTrigger> {
	const value = await readSetting("stt.submitTrigger");
	return typeof value === "string" && value in STT_SUBMIT_TRIGGERS ? (value as SttSubmitTrigger) : "never";
}

/** Whether to auto-submit a dictated utterance, and how many trailing chars to strip first. */
export function evaluateSttSubmitTrigger(
	utterance: string,
	trigger: SttSubmitTrigger,
): { submit: boolean; trimTrailing: number } {
	const trimmed = utterance.trim();
	if (!trimmed) return { submit: false, trimTrailing: 0 };
	if (trigger === "release") {
		return { submit: trimmed.split(/\s+/).filter(Boolean).length >= 2, trimTrailing: 0 };
	}
	if (trigger === "release-complete") {
		return { submit: /[.?!…。？！]\s*$/.test(trimmed), trimTrailing: 0 };
	}
	if (trigger === "say-submit") {
		const match = utterance.match(/(?:^|\s+)(\S*submit\S*)[.?!…。？！]*\s*$/i);
		if (match?.index !== undefined) return { submit: true, trimTrailing: utterance.length - match.index };
	}
	return { submit: false, trimTrailing: 0 };
}

// ---------------------------------------------------------------------------
// Speech output (speech.enabled, speech.mode, speech.voice)
// ---------------------------------------------------------------------------

let speaking = false;
let voiceCallActive = false;

/** The voice call (`voice-call.ts`) sets this while it is on: it speaks the bot's replies itself, so auto-speak stays silent. */
export function setVoiceCallActive(active: boolean): void {
	voiceCallActive = active;
}

export function isVoiceCallActive(): boolean {
	return voiceCallActive;
}

/** How one {@link playSpeech} ended: played out, stopped by the caller, or failed (`error` is the RPC reply or the cause). */
export type SpeechEnd = { status: "ended" | "stopped" } | { status: "failed"; error: unknown };

export interface SpeechPlayback {
	/** Stop at once, also while the text is still being synthesized (then nothing plays). Resolves {@link finished} as stopped. */
	stop(): void;
	readonly finished: Promise<SpeechEnd>;
}

/**
 * Synthesize `text` on the sidecar's local TTS and play it, stoppable at any moment. Nothing here is streamed: the
 * bridge answers with the whole clip, so the first sound waits for the full synthesis.
 */
export function playSpeech(text: string): SpeechPlayback {
	let stopped = false;
	let audio: HTMLAudioElement | null = null;
	let release = (): void => {};
	const finished = (async (): Promise<SpeechEnd> => {
		try {
			const response = await window.omp.rpc.synthesizeSpeech(text);
			if (stopped) return { status: "stopped" };
			if (!response.success) return { status: "failed", error: response };
			const data = response.data as SynthesizeSpeechResult | undefined;
			if (!data?.audioBase64) return { status: "ended" };
			const url = URL.createObjectURL(
				new Blob([base64ToBytes(data.audioBase64)], { type: data.mimeType || "audio/wav" }),
			);
			const playback = Promise.withResolvers<void>();
			release = (): void => {
				URL.revokeObjectURL(url);
				playback.resolve();
			};
			audio = new Audio(url);
			audio.onended = release;
			audio.onerror = release;
			// Autoplay-policy rejections are not user-facing failures.
			audio.play().catch(release);
			await playback.promise;
			return { status: stopped ? "stopped" : "ended" };
		} catch (cause) {
			return stopped ? { status: "stopped" } : { status: "failed", error: cause };
		}
	})();
	return {
		finished,
		stop() {
			if (stopped) return;
			stopped = true;
			audio?.pause();
			release();
		},
	};
}

/**
 * Speak one utterance through the sidecar's local TTS. Dropped silently when
 * another utterance is still active (see the module header); RPC failures
 * surface as an error toast.
 */
export function speakText(text: string): void {
	const trimmed = text.trim();
	if (!trimmed || speaking) return;
	speaking = true;
	void playSpeech(trimmed).finished.then(end => {
		speaking = false;
		if (end.status === "failed") toastError({ title: translate("voice.speak.failed"), error: end.error });
	});
}

// ---------------------------------------------------------------------------
// Auto-speak watcher: finalized store messages → speakText, gated on
// `speech.enabled` (synced store) and `speech.mode` (read at decision time).
// ---------------------------------------------------------------------------

/** True when this window's active tab is the bot (or a side chat of it) and its desk wants replies read aloud. */
function activeTabIsSpokenBot(): boolean {
	if (typeof document !== "undefined" && document.visibilityState === "hidden") return false;
	const { tabs, activeTabId } = useTabsStore.getState();
	const tab = tabs.find(candidate => candidate.id === activeTabId);
	if (!tab?.sessionPath) return false;
	const entry = useBotDeskStore.getState().desks[tab.device ?? "local"];
	if (!entry?.desk.voice.speakReplies) return false;
	if (entry.desk.channels.some(channel => channel.sessionPath === tab.sessionPath)) return true;
	if (tab.device !== undefined) return false;
	const bot = useBotStore.getState();
	return bot.enabled && bot.path === tab.sessionPath;
}

/**
 * Subscribe to the messages store and speak new finalized output while
 * `speech.enabled` is on (TUI event-controller parity):
 * - assistant|all: each finalized assistant message speaks as it lands
 *   (all also speaks tool-result text);
 * - yield: only the last assistant message of a run speaks, when the run
 *   goes idle.
 * Returns the unsubscribe function.
 */
export function startVoiceAutoSpeak(): () => void {
	// Last assistant text of the in-flight run, buffered SYNCHRONOUSLY as
	// messages land and spoken at run end (yield mode). Must not wait on the
	// async mode read: agent_end flips isStreaming in the same batch tick as
	// the final message_end append, ahead of any awaited continuation.
	let lastRunAssistantText: string | null = null;

	const unsubscribeMessages = useMessagesStore.subscribe((state, previous) => {
		// lastAppended changes only on genuinely new finalized messages —
		// hydration/pagination replaces `messages` without touching it, so
		// history is never spoken.
		if (state.lastAppended === previous.lastAppended) return;
		const appended = state.lastAppended;
		for (const message of appended) {
			// TUI: never speak the aborted partial.
			if (message.role === "assistant" && message.stopReason !== "aborted") {
				const text = messageText(message);
				if (text) lastRunAssistantText = text;
			}
		}
		void (async () => {
			if (!useSettingsStore.getState().speechEnabled) return;
			const modeValue = await readSetting("speech.mode");
			// Yield messages are spoken by the run-end watcher below.
			if (modeValue === "yield" || isVoiceCallActive()) return;
			const all = modeValue === "all";
			for (const message of appended) {
				if (message.stopReason === "aborted") continue;
				const isAssistant = message.role === "assistant";
				if (!isAssistant && !(all && message.role === "toolResult")) continue;
				const text = messageText(message);
				if (text) speakText(text);
			}
		})();
	});

	const unsubscribeSession = useSessionStore.subscribe((state, previous) => {
		// Run end (agent_end): yield mode speaks the run's final assistant text.
		if (!previous.isStreaming || state.isStreaming) return;
		const pending = lastRunAssistantText;
		lastRunAssistantText = null;
		if (!pending || isVoiceCallActive()) return;
		if (!useSettingsStore.getState().speechEnabled) {
			// speech.enabled is off: the bot's own tab still reads its reply when the desk asks for it.
			if (activeTabIsSpokenBot()) speakText(pending);
			return;
		}
		void (async () => {
			if ((await readSetting("speech.mode")) !== "yield" || isVoiceCallActive()) return;
			speakText(pending);
		})();
	});

	return () => {
		unsubscribeMessages();
		unsubscribeSession();
	};
}
