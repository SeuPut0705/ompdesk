import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The streaming voice methods (resources/gui-bridge/voice.ts) on the installed omp: every stock internal they need
 * resolves (`sttClient.startStream`, `ttsClient.synthesizeStream`, `tts/speakable`), and, when the dictation model is
 * already in the user's cache, a real stream opens on stock's worker, takes audio and is cancelled. Nothing is
 * downloaded: without the cached model the second test skips.
 */
const omp = join(homedir(), ".bun", "bin", "omp");
/** Opt-in (never on CI); needs OMP_GUI_ALLOW_REAL_HOME=1, because it downloads into the real model cache. */
const REAL = process.env.OMPDESK_VOICE_STREAM_REAL === "1";
const userAgentCache = join(homedir(), ".omp", "agent", "cache");

const PROBE = `
import { methods } from "./voice";
import { probe } from "./health";
import { isSttModelCached } from "@oh-my-pi/pi-coding-agent/stt/downloader";
import { DEFAULT_STT_MODEL_KEY } from "@oh-my-pi/pi-coding-agent/stt/models";
export default function (pi) {
 pi.on("session_start", async () => {
  const out = {};
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = { pi, session: () => session, context: () => undefined, emit: () => {} };
   out.unavailable = await probe(env, ["voice", "voiceStream"]);
   out.cached = await isSttModelCached(DEFAULT_STT_MODEL_KEY);
   if (out.cached && out.unavailable.length === 0) {
    const { streamId } = await methods.stt_stream_start({}, env);
    const silence = Buffer.alloc(16000 * 2).toString("base64");
    out.push = await methods.stt_stream_push({ streamId, pcm16: silence }, env);
    out.cancel = await methods.stt_stream_cancel({ streamId }, env);
    try {
     await methods.stt_stream_push({ streamId, pcm16: silence }, env);
     out.afterCancel = "accepted";
    } catch (error) {
     out.afterCancel = String(error && error.message || error);
    }
   }
  } catch (err) {
   out.error = String((err && err.stack) || err);
  }
  console.error("VOICE_PROBE=" + JSON.stringify(out));
  process.exit(0);
 });
}
`;

interface Probe {
	unavailable?: Array<{ feature: string; missing: string[] }>;
	cached?: boolean;
	push?: { text: string };
	cancel?: Record<string, never>;
	afterCancel?: string;
	error?: string;
}

function run<T>(source: string, marker: string, extraEnv: Record<string, string>, timeout: number): T {
	const isolated = mkdtempSync(join(tmpdir(), "ompdesk-voice-stream-"));
	chmodSync(isolated, 0o700);
	try {
		cpSync(resolve("resources/gui-bridge"), join(isolated, "bridge"), { recursive: true });
		writeFileSync(join(isolated, "bridge", "voice-probe.ts"), source);
		// The user's model cache: the isolated agent dir would otherwise look like a machine with no model.
		if (REAL) mkdirSync(userAgentCache, { recursive: true });
		if (existsSync(userAgentCache)) symlinkSync(userAgentCache, join(isolated, "cache"));
		const project = join(isolated, "project");
		mkdirSync(project, { recursive: true });
		const env: Record<string, string | undefined> = {
			...process.env,
			PI_CODING_AGENT_DIR: isolated,
			PI_CONFIG_DIR: isolated,
			OMP_PROFILE: "",
			PI_PROFILE: "",
			OPENAI_API_KEY: "probe-not-a-real-key",
			...extraEnv,
		};
		for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENROUTER_API_KEY"])
			Reflect.deleteProperty(env, key);
		const result = spawnSync(
			omp,
			[
				"--mode",
				"rpc",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-rules",
				"-e",
				join(isolated, "bridge", "voice-probe.ts"),
			],
			{ cwd: project, env, encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024, input: "" },
		);
		const line = result.stderr.split("\n").find(value => value.startsWith(`${marker}=`));
		expect(line, result.stderr.slice(-2500)).toMatch(new RegExp(`^${marker}=`));
		return JSON.parse(line?.slice(marker.length + 1) ?? "{}") as T;
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
}

describe.skipIf(!existsSync(omp))("streaming voice, on stock omp", () => {
	let probe: Probe;
	beforeAll(() => {
		probe = run<Probe>(PROBE, "VOICE_PROBE", {}, 170_000);
	}, 180_000);

	it("finds every stock internal the stream methods need", () => {
		expect(probe.error).toBeUndefined();
		expect(probe.unavailable).toEqual([]);
	});

	it("opens, feeds and cancels a stream on the cached dictation model", ctx => {
		if (!probe.cached) ctx.skip();
		expect(probe.push).toEqual({ text: expect.any(String) });
		expect(probe.cancel).toEqual({});
		expect(probe.afterCancel).toBe("unknown_stream");
	});
});

const REPLY =
	"Good morning. The weather today is sunny with a light breeze. I will remind you about your meeting at three o'clock.";

const REAL_PROBE = `
import { methods } from "./voice";
import { roleCandidatePool } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { resolveRoleChain } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { downloadSttModel, isSttModelCached } from "@oh-my-pi/pi-coding-agent/stt/downloader";
import { resolveSttModelSpec } from "@oh-my-pi/pi-coding-agent/stt/models";
import { resolveSpeechCandidates } from "@oh-my-pi/pi-coding-agent/tools/tts";
import { TTS_LOCAL_MODELS } from "@oh-my-pi/pi-coding-agent/tts/models";
import { downloadTtsModel, isTtsModelCached } from "@oh-my-pi/pi-coding-agent/tts/downloader";
const REPLY = ${JSON.stringify(REPLY)};
const now = () => performance.now();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const round = value => Math.round(value);

async function ttsStream(env) {
 const t0 = now();
 const { streamId, sampleRate } = await methods.tts_stream_start({ text: REPLY }, env);
 const startMs = now() - t0;
 const arrivals = [];
 const parts = [];
 for (;;) {
  const { chunks, done } = await methods.tts_stream_next({ streamId, waitMs: 5000 }, env);
  for (const chunk of chunks) { arrivals.push(round(now() - t0)); parts.push(Buffer.from(chunk, "base64")); }
  if (done) break;
 }
 const pcm = Buffer.concat(parts);
 return { sampleRate, startMs: round(startMs), firstChunkMs: arrivals[0], totalMs: round(now() - t0), chunkArrivalsMs: arrivals, audioMs: round((pcm.length / 2 / sampleRate) * 1000), pcm };
}

async function ttsBatch(env) {
 const t0 = now();
 const { audioBase64 } = await methods.synthesize_speech({ text: REPLY }, env);
 const totalMs = round(now() - t0);
 const wav = Buffer.from(audioBase64, "base64");
 const sampleRate = wav.readUInt32LE(24);
 return { sampleRate, totalMs, audioMs: round(((wav.length - 44) / 2 / sampleRate) * 1000) };
}

function resample16k(pcm, from) {
 const input = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
 const out = new Int16Array(Math.floor((input.length * 16000) / from));
 for (let i = 0; i < out.length; i += 1) {
  const pos = (i * from) / 16000;
  const base = Math.floor(pos);
  const frac = pos - base;
  out[i] = Math.round(input[base] * (1 - frac) + (input[Math.min(base + 1, input.length - 1)]) * frac);
 }
 return Buffer.from(out.buffer);
}

function wav16k(pcm) {
 const header = Buffer.alloc(44);
 header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8); header.write("fmt ", 12);
 header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24);
 header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
 return Buffer.concat([header, pcm]).toString("base64");
}

async function sttStream(env, pcm) {
 const t0 = now();
 const { streamId } = await methods.stt_stream_start({}, env);
 const startMs = round(now() - t0);
 const step = 3200 * 2;
 const partials = [];
 let last = "";
 const t1 = now();
 let pushes = 0;
 for (let offset = 0; offset < pcm.length; offset += step) {
  pushes += 1;
  const due = t1 + pushes * 200;
  if (due > now()) await sleep(due - now());
  const { text } = await methods.stt_stream_push({ streamId, pcm16: pcm.subarray(offset, offset + step).toString("base64") }, env);
  if (text !== last) { partials.push({ atMs: round(now() - t1), text }); last = text; }
 }
 const tLast = now();
 const { text } = await methods.stt_stream_stop({ streamId }, env);
 return { startMs, audioMs: round((pcm.length / 2 / 16000) * 1000), pushes, partials, lastPushToStopMs: round(now() - tLast), text };
}

async function sttBatch(env, pcm) {
 const t0 = now();
 const { text } = await methods.transcribe_audio({ audioBase64: wav16k(pcm) }, env);
 return { totalMs: round(now() - t0), text };
}

export default function (pi) {
 pi.on("session_start", async () => {
  const out = {};
  try {
   const session = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID).session;
   const env = { pi, session: () => session, context: () => undefined, emit: () => {} };
   const pool = roleCandidatePool("dictation", session.settings, session.modelRegistry);
   const stt = resolveSttModelSpec(resolveRoleChain("dictation", session.settings, pool)[0]?.model.id);
   const local = resolveSpeechCandidates(session.settings, session.modelRegistry, false).find(candidate => candidate.model.api === "local-inference");
   const ttsKey = local?.model.id ?? TTS_LOCAL_MODELS[0].key;
   out.models = { stt: { key: stt.key, repo: stt.repo, sizeHint: stt.sizeHint }, tts: { key: ttsKey }, sttCached: await isSttModelCached(stt.key), ttsCached: await isTtsModelCached(ttsKey) };
   if (process.env.VOICE_PROBE_MODE === "setup") {
    const t0 = now();
    if (!out.models.sttCached) await downloadSttModel(stt.key);
    out.sttDownloadMs = round(now() - t0);
    const t1 = now();
    if (!out.models.ttsCached) out.ttsDownloaded = await downloadTtsModel(ttsKey);
    out.ttsDownloadMs = round(now() - t1);
    out.after = { sttCached: await isSttModelCached(stt.key), ttsCached: await isTtsModelCached(ttsKey) };
   } else {
    out.ttsStreamCold = await ttsStream(env);
    out.ttsBatchWarm1 = await ttsBatch(env);
    const warm = await ttsStream(env);
    out.ttsStreamWarm = { ...warm, pcm: undefined };
    out.ttsBatchWarm2 = await ttsBatch(env);
    const pcm16k = resample16k(out.ttsStreamCold.pcm, out.ttsStreamCold.sampleRate);
    out.ttsStreamCold.pcm = undefined;
    out.sttStreamCold = await sttStream(env, pcm16k);
    out.sttBatchWarm1 = await sttBatch(env, pcm16k);
    out.sttStreamWarm = await sttStream(env, pcm16k);
    out.sttBatchWarm2 = await sttBatch(env, pcm16k);
   }
  } catch (err) {
   out.error = String((err && err.stack) || err);
  }
  console.error("VOICE_REAL=" + JSON.stringify(out));
  process.exit(0);
 });
}
`;

interface RealResult {
	models: {
		stt: { key: string; repo: string; sizeHint: string };
		tts: { key: string };
		sttCached: boolean;
		ttsCached: boolean;
	};
	error?: string;
	sttStreamCold?: { text: string };
	[key: string]: unknown;
}

/** Downloads the speech models into the user's cache, then times the real streams. */
describe.skipIf(!existsSync(omp) || !REAL)("streaming voice end to end, on the user's models", () => {
	it("streams a spoken reply out and the same speech back in", () => {
		const setup = run<RealResult & { after?: { sttCached: boolean; ttsCached: boolean } }>(
			REAL_PROBE,
			"VOICE_REAL",
			{ VOICE_PROBE_MODE: "setup" },
			3_600_000,
		);
		console.log(`VOICE_REAL setup ${JSON.stringify(setup)}`);
		expect(setup.error).toBeUndefined();
		// Stock's `isTtsModelCached` looks under tiny-models, while kokoro-js's own transformers keeps the weights in the runtime's own cache (omp 18.14.1): the TTS download's result is what counts.
		expect(setup.after?.sttCached).toBe(true);
		expect(setup.ttsDownloaded).toBe(true);

		const measured = run<RealResult>(REAL_PROBE, "VOICE_REAL", { VOICE_PROBE_MODE: "measure" }, 600_000);
		console.log(`VOICE_REAL measure ${JSON.stringify(measured, null, 1)}`);
		expect(measured.error).toBeUndefined();
		const heard = String(measured.sttStreamCold?.text ?? "").toLowerCase();
		expect(heard).toContain("weather");
		expect(heard).toContain("meeting");
	}, 4_300_000);
});
