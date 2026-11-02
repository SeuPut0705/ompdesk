import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Page } from "@playwright/test";

// The voice call audit's speech and page instruments (e2e/real-voice-call.e2e.ts): utterances spoken by macOS `say`,
// a microphone the test plays them into, and a log of what the call did and when.

export const SAMPLE_RATE = 48_000;

export interface Utterance {
	name: string;
	voice: string;
	text: string;
}

export interface Clip {
	name: string;
	ms: number;
	base64: string;
}

/** Mono PCM16 samples of a WAV `afconvert` wrote (any chunk layout). */
async function readPcm(file: string): Promise<Buffer> {
	const bytes = await fs.readFile(file);
	let offset = 12;
	while (offset + 8 <= bytes.length) {
		const id = bytes.toString("ascii", offset, offset + 4);
		const size = bytes.readUInt32LE(offset + 4);
		if (id === "data") return bytes.subarray(offset + 8, offset + 8 + size);
		offset += 8 + size + (size % 2);
	}
	throw new Error(`${file} has no data chunk`);
}

/** `utterance` spoken by `say` as a canonical 44-byte-header mono PCM16 WAV the page's decoder reads. */
export async function speak(dir: string, utterance: Utterance): Promise<Clip> {
	const aiff = path.join(dir, `${utterance.name}.aiff`);
	const file = path.join(dir, `${utterance.name}.wav`);
	execFileSync("say", ["-v", utterance.voice, "-o", aiff, utterance.text]);
	execFileSync("afconvert", ["-f", "WAVE", "-d", `LEI16@${SAMPLE_RATE}`, "-c", "1", aiff, file]);
	const pcm = await readPcm(file);
	const header = Buffer.alloc(44);
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVE", 8, "ascii");
	header.write("fmt ", 12, "ascii");
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(SAMPLE_RATE, 24);
	header.writeUInt32LE(SAMPLE_RATE * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36, "ascii");
	header.writeUInt32LE(pcm.length, 40);
	return {
		name: utterance.name,
		ms: (pcm.length / 2 / SAMPLE_RATE) * 1000,
		base64: Buffer.concat([header, pcm]).toString("base64"),
	};
}

export interface LogEntry {
	/** `performance.now()` in the page. */
	t: number;
	kind: string;
	[key: string]: unknown;
}

/**
 * Instrument the page before the call starts:
 * - the microphone: `getUserMedia` still asks Chromium (the fake device and fake permission UI), and hands the call
 *   a track of the test's own mixer instead, into which `__voicePlay(name)` plays a loaded clip;
 * - `bar`: every change of the call bar's phase, words and error;
 * - `rpc`: each streaming voice command and the turn's prompt/follow-up, sent and answered;
 * - `agent_start`/`agent_end`/`message_start` frames of the tab;
 * - `play`/`stopSound`: each sound the call schedules (not the mixer's).
 */
export async function instrument(page: Page, clips: readonly Clip[]): Promise<void> {
	await page.evaluate(() => {
		const log: Array<{ t: number; kind: string; [key: string]: unknown }> = [];
		const push = (kind: string, data: Record<string, unknown> = {}) =>
			log.push({ t: performance.now(), kind, ...data });
		let last = "";
		const watch = () => {
			const bar = document.querySelector("[data-bot-call-bar]");
			const phase = bar?.getAttribute("data-bot-call-phase") ?? "none";
			const heard = bar?.querySelector("[data-bot-call-heard]")?.textContent ?? "";
			const partial = bar?.querySelector("[data-bot-call-partial]") !== null && bar !== null;
			const error = bar?.querySelector("[data-bot-call-error]")?.getAttribute("data-bot-call-error") ?? "";
			const key = [phase, heard, partial, error].join("|");
			if (key === last) return;
			last = key;
			push("bar", { phase, heard, partial, error });
		};
		new MutationObserver(watch).observe(document.body, {
			subtree: true,
			childList: true,
			characterData: true,
			attributes: true,
			attributeFilter: ["data-bot-call-phase", "data-bot-call-error", "data-bot-call-partial"],
		});
		window.omp.events.onTabBatch(events => {
			for (const event of events) {
				if (event.type === "agent_start" || event.type === "agent_end") push(event.type);
				else if (event.type === "message_start") {
					const message = Reflect.get(event, "message") as { role?: string; content?: unknown } | undefined;
					const content = message?.content;
					const text =
						typeof content === "string"
							? content
							: Array.isArray(content)
								? content.map(part => (typeof part?.text === "string" ? part.text : "")).join("")
								: "";
					push("message_start", { role: message?.role, text: text.slice(0, 300) });
				}
			}
		});
		const rpc = window.omp.rpc as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
		for (const name of [
			"sttStreamStart",
			"sttStreamStop",
			"sttStreamCancel",
			"ttsStreamStart",
			"ttsStreamCancel",
			"transcribeAudio",
			"synthesizeSpeech",
		]) {
			const original = rpc[name];
			if (typeof original !== "function") continue;
			rpc[name] = async (...args: unknown[]) => {
				const id = Math.random().toString(36).slice(2, 8);
				push("rpc", { name, id, phase: "sent" });
				const reply = (await original.apply(rpc, args)) as { success?: boolean; data?: unknown; error?: string };
				push("rpc", {
					name,
					id,
					phase: "answered",
					success: reply?.success,
					data: reply?.data,
					error: reply?.error,
				});
				return reply;
			};
		}
		const mic: { context: AudioContext | null; destination: MediaStreamAudioDestinationNode | null } = {
			context: null,
			destination: null,
		};
		const decoded = new Map<string, AudioBuffer>();
		const start = AudioBufferSourceNode.prototype.start;
		AudioBufferSourceNode.prototype.start = function (when = 0, ...rest: number[]) {
			if (this.context !== mic.context) {
				const lead = Math.max(0, when - this.context.currentTime);
				push("play", { at: performance.now() + lead * 1000, ms: (this.buffer?.duration ?? 0) * 1000 });
			}
			return start.call(this, when, ...rest);
		};
		const stop = AudioBufferSourceNode.prototype.stop;
		AudioBufferSourceNode.prototype.stop = function (when?: number) {
			if (this.context !== mic.context) push("stopSound");
			return stop.call(this, when);
		};
		const play = HTMLMediaElement.prototype.play;
		HTMLMediaElement.prototype.play = function () {
			push("play", { at: performance.now(), element: true });
			return play.call(this);
		};
		const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
		navigator.mediaDevices.getUserMedia = async constraints => {
			const device = await getUserMedia(constraints);
			for (const track of device.getTracks()) track.stop();
			const context = new AudioContext({ sampleRate: 48_000 });
			await context.resume();
			const destination = context.createMediaStreamDestination();
			Object.assign(mic, { context, destination });
			push("mic");
			return destination.stream;
		};
		Object.assign(window, {
			__voiceLog: log,
			__voiceMic: mic,
			__voiceDecoded: decoded,
			__voicePlay: async (name: string) => {
				const { context, destination } = mic;
				if (!context || !destination) throw new Error("the call has no microphone yet");
				let buffer = decoded.get(name);
				if (!buffer) {
					const base64 = (Reflect.get(window, "__voiceClips") as Record<string, string>)[name];
					if (!base64) throw new Error(`no clip ${name}`);
					const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
					buffer = await context.decodeAudioData(bytes.buffer);
					decoded.set(name, buffer);
				}
				const source = context.createBufferSource();
				source.buffer = buffer;
				source.connect(destination);
				const lead = 0.05;
				source.start(context.currentTime + lead);
				const at = performance.now() + lead * 1000;
				const end = at + buffer.duration * 1000;
				push("say", { name, at, end });
				return { at, end };
			},
		});
		watch();
	});
	await page.evaluate(
		entries => Object.assign(window, { __voiceClips: Object.fromEntries(entries) }),
		clips.map(clip => [clip.name, clip.base64] as const),
	);
}

export const readLog = (page: Page): Promise<LogEntry[]> =>
	page.evaluate(() => Reflect.get(window, "__voiceLog") as LogEntry[]);

/** Play a loaded clip into the call's microphone; resolves with when it starts and ends (page clock). */
export const say = (page: Page, name: string): Promise<{ at: number; end: number }> =>
	page.evaluate(
		n => (Reflect.get(window, "__voicePlay") as (n: string) => Promise<{ at: number; end: number }>)(n),
		name,
	);
