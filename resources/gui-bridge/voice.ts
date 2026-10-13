/**
 * Voice over the live session: dictation (stock STT) and read-aloud (stock TTS).
 * Ported from the fork's rpc-mode.ts transcribe/synthesize cases. Wire shapes
 * match `src/shared/rpc-types.ts`.
 */
import { resolveRoleChain } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { roleCandidatePool } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { sttClient } from "@oh-my-pi/pi-coding-agent/stt/asr-client";
import { downloadSttModel, isSttModelCached } from "@oh-my-pi/pi-coding-agent/stt/downloader";
import { resolveSttModelSpec } from "@oh-my-pi/pi-coding-agent/stt/models";
import { DEFAULT_TTS_VOICE } from "@oh-my-pi/pi-coding-agent/tts/models";
import { ttsClient } from "@oh-my-pi/pi-coding-agent/tts/tts-client";
import { resolveLocalSpeechModelId } from "@oh-my-pi/pi-coding-agent/tts/vocalizer";
import { encodeWav } from "@oh-my-pi/pi-coding-agent/tts/wav";
import { guard } from "./health";
import { asRecord, requiredString } from "./params";
import type { BridgeMethods } from "./types";

const WAV_HEADER_BYTES = 44;

/** Canonical 44-byte-header mono PCM16 WAV → Float32 samples (the GUI mic transport's only format). */
function decodeWav(bytes: Uint8Array): { samples: Float32Array; sampleRate: number } {
	if (bytes.length < WAV_HEADER_BYTES) throw new Error("WAV buffer too short for a 44-byte header");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const ascii = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
	if (ascii(0) !== "RIFF" || ascii(8) !== "WAVE") throw new Error("Not a RIFF/WAVE buffer");
	if (ascii(12) !== "fmt " || ascii(36) !== "data") throw new Error("WAV buffer is not in canonical fmt+data layout");
	const format = view.getUint16(20, true);
	const channels = view.getUint16(22, true);
	const sampleRate = view.getUint32(24, true);
	const bits = view.getUint16(34, true);
	if (format !== 1) throw new Error(`Unsupported WAV encoding: format ${format} (only PCM is accepted)`);
	if (channels !== 1) throw new Error(`Unsupported WAV channel count: ${channels} (only mono is accepted)`);
	if (bits !== 16) throw new Error(`Unsupported WAV bit depth: ${bits} (only 16-bit PCM is accepted)`);
	const dataBytes = Math.min(view.getUint32(40, true), bytes.length - WAV_HEADER_BYTES);
	const samples = new Float32Array(Math.floor(dataBytes / 2));
	for (let i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(WAV_HEADER_BYTES + i * 2, true) / 32768;
	return { samples, sampleRate };
}

async function transcribe(session: AgentSession, audioBase64: string) {
	const { samples, sampleRate } = decodeWav(Buffer.from(audioBase64, "base64"));
	if (sampleRate !== 16_000) {
		throw new Error(`Unsupported sample rate ${sampleRate} Hz — transcribe_audio expects 16 kHz mono PCM16 WAV`);
	}
	if (samples.length === 0) return { text: "" };
	// Same resolution as the TUI stt-controller: stale/legacy keys fall back to the default model.
	const pool = roleCandidatePool("dictation", session.settings, session.modelRegistry);
	const modelKey = resolveSttModelSpec(resolveRoleChain("dictation", session.settings, pool)[0]?.model.id).key;
	if (!(await isSttModelCached(modelKey))) await downloadSttModel(modelKey);
	const language = lookup("stt.language")?.get(session.settings) as string | undefined;
	return { text: await sttClient.transcribe(modelKey, samples, { language: language || undefined }) };
}

async function synthesize(session: AgentSession, rawText: string) {
	const text = rawText.trim();
	if (!text) return { audioBase64: "", mimeType: "audio/wav" };
	const voice = (lookup("speech.voice")?.get(session.settings) as string | undefined) || DEFAULT_TTS_VOICE;
	const modelKey = resolveLocalSpeechModelId({ settings: session.settings, registry: session.modelRegistry });
	const audio = await ttsClient.synthesize(modelKey, text, { voice });
	if (!audio) throw new Error("Local TTS model is unavailable — download it from the TUI speech settings first");
	return {
		audioBase64: Buffer.from(encodeWav(audio.pcm, audio.sampleRate)).toString("base64"),
		mimeType: "audio/wav",
	};
}

export const methods: BridgeMethods = guard("voice", {
	transcribe_audio: async (params, env) => transcribe(env.session(), requiredString(params, "audioBase64")),
	synthesize_speech: async (params, env) => {
		const text = asRecord(params).text;
		return synthesize(env.session(), typeof text === "string" ? text : "");
	},
});
