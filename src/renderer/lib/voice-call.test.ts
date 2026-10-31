import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { useMessagesStore } from "../stores/messages";
import { useSessionStore } from "../stores/session";
import { useSettingsStore } from "../stores/settings";
import {
	FakeAudioContext,
	FakeMediaRecorder,
	type FakeMic,
	FakeStream,
	installFakeMic,
	uninstallFakeMic,
} from "../test-support/dictation";
import { isVoiceCallActive, METER_BARS, startVoiceAutoSpeak } from "./voice";
import {
	CALL_TUNING,
	type CallEvent,
	type CallPhase,
	type CallSnapshot,
	type CallState,
	INITIAL_CALL_STATE,
	nextPhase,
	spokenReply,
	startVoiceCall,
	type VadMode,
	type VadSignal,
	VoiceActivity,
	type VoiceCall,
} from "./voice-call";

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

const PHASES: CallPhase[] = ["starting", "listening", "hearing", "transcribing", "waiting", "speaking", "ended"];

const at = (phase: CallPhase, over: Partial<CallState> = {}): CallState => ({ ...INITIAL_CALL_STATE, phase, ...over });

const EVENTS: CallEvent[] = [
	{ type: "micReady" },
	{ type: "speechStart" },
	{ type: "speechEnd" },
	{ type: "speechDropped" },
	{ type: "transcript", text: "hi" },
	{ type: "sendFailed" },
	{ type: "replyStarted" },
	{ type: "reply", text: "ok" },
	{ type: "playbackEnded" },
	{ type: "bargeIn" },
	{ type: "mute", on: true },
	{ type: "warn", error: "failed" },
	{ type: "fail", error: "denied" },
	{ type: "end" },
];

describe("nextPhase", () => {
	it("ignores every event once the call has ended", () => {
		const ended = at("ended", { error: "denied" });
		for (const event of EVENTS) expect(nextPhase(ended, event)).toBe(ended);
	});

	it("ends from every phase, dropping what it held", () => {
		for (const phase of PHASES.filter(candidate => candidate !== "ended")) {
			const next = nextPhase(at(phase, { pending: "held", playing: "now" }), { type: "end" });
			expect(next).toMatchObject({ phase: "ended", pending: null, playing: null });
			expect(next.error).toBeUndefined();
		}
	});

	it("fails from every phase with the reason", () => {
		for (const phase of PHASES.filter(candidate => candidate !== "ended")) {
			expect(nextPhase(at(phase), { type: "fail", error: "no-model" })).toMatchObject({
				phase: "ended",
				error: "no-model",
			});
		}
	});

	it("starts listening once the mic is ready, or settles where the call already is", () => {
		expect(nextPhase(at("starting"), { type: "micReady" }).phase).toBe("listening");
		expect(nextPhase(at("starting", { busy: true }), { type: "micReady" }).phase).toBe("waiting");
		expect(nextPhase(at("starting", { pending: "held" }), { type: "micReady" })).toMatchObject({
			phase: "speaking",
			playing: "held",
			pending: null,
		});
		for (const phase of PHASES.filter(candidate => candidate !== "starting")) {
			const state = at(phase);
			expect(nextPhase(state, { type: "micReady" })).toBe(state);
		}
	});

	it("hears speech while listening or waiting, never while muted", () => {
		expect(nextPhase(at("listening"), { type: "speechStart" }).phase).toBe("hearing");
		expect(nextPhase(at("waiting", { busy: true }), { type: "speechStart" }).phase).toBe("hearing");
		for (const phase of ["starting", "hearing", "transcribing", "speaking"] as const) {
			const state = at(phase);
			expect(nextPhase(state, { type: "speechStart" })).toBe(state);
		}
		const muted = at("listening", { muted: true });
		expect(nextPhase(muted, { type: "speechStart" })).toBe(muted);
		expect(nextPhase(at("listening", { error: "failed" }), { type: "speechStart" }).error).toBeUndefined();
	});

	it("moves a heard utterance on to transcription, or back when it was too short", () => {
		expect(nextPhase(at("hearing"), { type: "speechEnd" }).phase).toBe("transcribing");
		expect(nextPhase(at("hearing"), { type: "speechDropped" }).phase).toBe("listening");
		expect(nextPhase(at("hearing", { busy: true }), { type: "speechDropped" }).phase).toBe("waiting");
		expect(nextPhase(at("hearing", { pending: "held" }), { type: "speechDropped" }).phase).toBe("speaking");
		for (const phase of PHASES.filter(candidate => candidate !== "hearing")) {
			const state = at(phase);
			expect(nextPhase(state, { type: "speechEnd" })).toBe(state);
			expect(nextPhase(state, { type: "speechDropped" })).toBe(state);
		}
	});

	it("waits for the bot after a transcript, and goes back to listening on an empty one", () => {
		expect(nextPhase(at("transcribing"), { type: "transcript", text: " hello " })).toMatchObject({
			phase: "waiting",
			busy: true,
			heard: "hello",
		});
		const afterEmpty = nextPhase(at("transcribing", { heard: "before" }), { type: "transcript", text: "  " });
		expect(afterEmpty).toMatchObject({ phase: "listening", busy: false, heard: "before" });
		// An empty one while the bot's turn still runs keeps the call waiting.
		expect(nextPhase(at("transcribing", { busy: true }), { type: "transcript", text: "" }).phase).toBe("waiting");
		for (const phase of PHASES.filter(candidate => candidate !== "transcribing")) {
			const state = at(phase);
			expect(nextPhase(state, { type: "transcript", text: "hi" })).toBe(state);
		}
	});

	it("gives up waiting when the words never reached the bot", () => {
		expect(nextPhase(at("waiting", { busy: true }), { type: "sendFailed" })).toMatchObject({
			phase: "listening",
			busy: false,
		});
		expect(nextPhase(at("speaking", { busy: true }), { type: "sendFailed" })).toMatchObject({
			phase: "speaking",
			busy: false,
		});
	});

	it("waits when the bot's turn starts, wherever else the person is", () => {
		expect(nextPhase(at("listening"), { type: "replyStarted" })).toMatchObject({ phase: "waiting", busy: true });
		expect(nextPhase(at("hearing"), { type: "replyStarted" })).toMatchObject({ phase: "hearing", busy: true });
		expect(nextPhase(at("speaking"), { type: "replyStarted" })).toMatchObject({ phase: "speaking", busy: true });
		const waiting = at("waiting", { busy: true });
		expect(nextPhase(waiting, { type: "replyStarted" })).toBe(waiting);
	});

	it("speaks the reply when nobody is talking and holds it while the person is", () => {
		expect(nextPhase(at("waiting", { busy: true }), { type: "reply", text: " done " })).toMatchObject({
			phase: "speaking",
			playing: "done",
			pending: null,
			busy: false,
		});
		expect(nextPhase(at("listening"), { type: "reply", text: "done" }).phase).toBe("speaking");
		for (const phase of ["starting", "hearing", "transcribing", "speaking"] as const) {
			expect(nextPhase(at(phase, { busy: true }), { type: "reply", text: "done" })).toMatchObject({
				phase,
				pending: "done",
				busy: false,
			});
		}
		// A newer reply replaces a held one.
		expect(nextPhase(at("hearing", { pending: "old" }), { type: "reply", text: "new" }).pending).toBe("new");
	});

	it("returns to listening when the bot's turn ended with nothing to say", () => {
		expect(nextPhase(at("waiting", { busy: true }), { type: "reply", text: "" })).toMatchObject({
			phase: "listening",
			busy: false,
			pending: null,
		});
		expect(nextPhase(at("hearing", { busy: true }), { type: "reply", text: " " })).toMatchObject({
			phase: "hearing",
			pending: null,
		});
	});

	it("settles after the reply played: the next held reply, waiting on the bot, or listening", () => {
		expect(nextPhase(at("speaking", { playing: "a" }), { type: "playbackEnded" })).toMatchObject({
			phase: "listening",
			playing: null,
		});
		expect(nextPhase(at("speaking", { playing: "a", busy: true }), { type: "playbackEnded" }).phase).toBe("waiting");
		expect(nextPhase(at("speaking", { playing: "a", pending: "b" }), { type: "playbackEnded" })).toMatchObject({
			phase: "speaking",
			playing: "b",
			pending: null,
		});
		for (const phase of PHASES.filter(candidate => candidate !== "speaking")) {
			const state = at(phase);
			expect(nextPhase(state, { type: "playbackEnded" })).toBe(state);
		}
	});

	it("lets the person talk over a reply: speaking to hearing, the held reply kept", () => {
		expect(nextPhase(at("speaking", { playing: "a", pending: "b" }), { type: "bargeIn" })).toMatchObject({
			phase: "hearing",
			playing: null,
			pending: "b",
		});
		const muted = at("speaking", { playing: "a", muted: true });
		expect(nextPhase(muted, { type: "bargeIn" })).toBe(muted);
		for (const phase of PHASES.filter(candidate => candidate !== "speaking")) {
			const state = at(phase);
			expect(nextPhase(state, { type: "bargeIn" })).toBe(state);
		}
	});

	it("mutes and unmutes; muting drops an utterance being heard and leaves a reply playing", () => {
		expect(nextPhase(at("listening"), { type: "mute", on: true })).toMatchObject({ phase: "listening", muted: true });
		expect(nextPhase(at("listening", { muted: true }), { type: "mute", on: false }).muted).toBe(false);
		expect(nextPhase(at("hearing"), { type: "mute", on: true })).toMatchObject({ phase: "listening", muted: true });
		expect(nextPhase(at("speaking", { playing: "a" }), { type: "mute", on: true })).toMatchObject({
			phase: "speaking",
			muted: true,
		});
		const already = at("listening", { muted: true });
		expect(nextPhase(already, { type: "mute", on: true })).toBe(already);
	});

	it("warns without ending: a failed utterance or reply goes back to rest and keeps the reason", () => {
		expect(nextPhase(at("transcribing"), { type: "warn", error: "failed" })).toMatchObject({
			phase: "listening",
			error: "failed",
		});
		expect(nextPhase(at("speaking", { playing: "a" }), { type: "warn", error: "speak" })).toMatchObject({
			phase: "listening",
			playing: null,
			error: "speak",
		});
		expect(nextPhase(at("speaking", { playing: "a", pending: "b" }), { type: "warn", error: "speak" })).toMatchObject(
			{
				phase: "speaking",
				playing: "b",
			},
		);
		expect(nextPhase(at("listening"), { type: "warn", error: "failed" })).toMatchObject({
			phase: "listening",
			error: "failed",
		});
	});

	it("runs a whole exchange", () => {
		const events: CallEvent[] = [
			{ type: "micReady" },
			{ type: "speechStart" },
			{ type: "speechEnd" },
			{ type: "transcript", text: "what is the time" },
			{ type: "replyStarted" },
			{ type: "reply", text: "Noon." },
			{ type: "bargeIn" },
			{ type: "speechEnd" },
			{ type: "transcript", text: "" },
			{ type: "end" },
		];
		const seen: CallPhase[] = [];
		let state = INITIAL_CALL_STATE;
		for (const event of events) {
			state = nextPhase(state, event);
			seen.push(state.phase);
		}
		expect(seen).toEqual([
			"listening",
			"hearing",
			"transcribing",
			"waiting",
			"waiting",
			"speaking",
			"hearing",
			"transcribing",
			"listening",
			"ended",
		]);
	});
});

describe("spokenReply", () => {
	it("drops a closing Sources or 출처 line and nothing else", () => {
		expect(spokenReply("All done.\n\nSources: a.ts · https://x.dev")).toBe("All done.");
		expect(spokenReply("끝났어요.\n출처: notes.md")).toBe("끝났어요.");
		expect(spokenReply("Sources: are in the report.\nMore words.")).toBe("Sources: are in the report.\nMore words.");
		expect(spokenReply("  plain reply  ")).toBe("plain reply");
	});
});

// ---------------------------------------------------------------------------
// The VAD
// ---------------------------------------------------------------------------

const LOUD = 0.2;

/** Feed `rms` once per tick over `[from, to)` ms; collect the signals. */
function feed(vad: VoiceActivity, rms: number, from: number, to: number, mode: VadMode = "listen"): VadSignal[] {
	const signals: VadSignal[] = [];
	for (let now = from; now < to; now += CALL_TUNING.tickMs) {
		const signal = vad.step(rms, now, mode);
		if (signal) signals.push(signal);
	}
	return signals;
}

/** A VAD past its calibration, on a silent floor, at `t = 1000`. */
function calibrated(): VoiceActivity {
	const vad = new VoiceActivity();
	feed(vad, 0, 0, 1000);
	return vad;
}

describe("VoiceActivity", () => {
	it("only measures the floor during its first ticks", () => {
		const vad = new VoiceActivity();
		const signals = feed(vad, LOUD, 0, CALL_TUNING.calibrationTicks * CALL_TUNING.tickMs);
		expect(signals).toEqual([]);
		expect(vad.floor).toBeGreaterThan(0.1);
	});

	it("starts speech after ~150 ms above the threshold, recording from the first loud tick", () => {
		const vad = calibrated();
		const signals = feed(vad, LOUD, 1000, 1300);
		expect(signals.map(signal => signal.kind)).toEqual(["candidate", "speech"]);
		expect(vad.active).toBe(true);
	});

	it("drops a blip shorter than the start time", () => {
		const vad = calibrated();
		const signals = [...feed(vad, LOUD, 1000, 1090), ...feed(vad, 0, 1090, 1400)];
		expect(signals.map(signal => signal.kind)).toEqual(["candidate", "dropped"]);
		expect(vad.active).toBe(false);
	});

	it("ends an utterance after ~900 ms below the threshold and reports its voiced time", () => {
		const vad = calibrated();
		feed(vad, LOUD, 1000, 1600);
		const quiet = feed(vad, 0, 1600, 2700);
		expect(quiet).toHaveLength(1);
		const end = quiet[0];
		expect(end?.kind).toBe("end");
		if (end?.kind === "end") {
			expect(end.voicedMs).toBeGreaterThanOrEqual(540);
			expect(end.voicedMs).toBeLessThanOrEqual(600);
		}
		expect(vad.active).toBe(false);
	});

	it("rides out the gap between words", () => {
		const vad = calibrated();
		feed(vad, LOUD, 1000, 1300);
		expect(feed(vad, 0, 1300, 1900)).toEqual([]);
		feed(vad, LOUD, 1900, 2200);
		expect(vad.active).toBe(true);
	});

	it("ends an utterance that never pauses at the hard cap", () => {
		const vad = calibrated();
		const signals = feed(vad, LOUD, 1000, 1000 + CALL_TUNING.maxUtteranceMs + 200);
		expect(signals.map(signal => signal.kind)).toEqual(["candidate", "speech", "end"]);
		// The noise that would not stop is the new floor, so the next stretch of it is not speech.
		expect(vad.floor).toBeGreaterThan(0.05);
	});

	it("tracks a steady noise floor and hears speech above it, not the noise", () => {
		const vad = new VoiceActivity();
		feed(vad, 0.03, 0, 2000);
		expect(feed(vad, 0.04, 2000, 2600)).toEqual([]);
		expect(feed(vad, LOUD, 2600, 2900).map(signal => signal.kind)).toEqual(["candidate", "speech"]);
	});

	it("needs a higher level and 250 ms to be talked over", () => {
		const vad = calibrated();
		// Above the listening threshold, below the barge-in one: no candidate while a reply plays.
		expect(feed(vad, 0.05, 1000, 1600, "speak")).toEqual([]);
		const signals = feed(vad, LOUD, 1600, 1900, "speak");
		expect(signals.map(signal => signal.kind)).toEqual(["candidate", "bargeIn"]);
	});

	it("drops a candidate when the call's mode changes under it, and when listening is switched off", () => {
		const vad = calibrated();
		expect(feed(vad, LOUD, 1000, 1030).map(signal => signal.kind)).toEqual(["candidate"]);
		expect(feed(vad, LOUD, 1030, 1060, "speak").map(signal => signal.kind)).toEqual(["dropped"]);
		expect(feed(vad, LOUD, 1060, 1090).map(signal => signal.kind)).toEqual(["candidate"]);
		expect(feed(vad, LOUD, 1090, 1120, "off").map(signal => signal.kind)).toEqual(["dropped"]);
	});
});

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

class FakeAudio {
	static instances: FakeAudio[] = [];
	played = false;
	paused = false;
	onended: (() => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(readonly url: string) {
		FakeAudio.instances.push(this);
	}
	play(): Promise<void> {
		this.played = true;
		return Promise.resolve();
	}
	pause(): void {
		this.paused = true;
	}
	/** The clip played to its end. */
	finish(): void {
		this.onended?.();
	}
}

interface RpcReply {
	success: boolean;
	data?: unknown;
	error?: string;
}

const REPLY = "All done.";

let mic: FakeMic;
let transcribeAudio: Mock<(audio: string, mimeType: string) => Promise<RpcReply>>;
let synthesizeSpeech: Mock<(text: string) => Promise<RpcReply>>;
let send: Mock<(text: string, context: { streaming: boolean }) => Promise<boolean>>;
let states: CallSnapshot[];
let call: VoiceCall | null;

const phase = (): CallPhase | undefined => states.at(-1)?.phase;
const last = (): CallSnapshot => {
	const snapshot = states.at(-1);
	if (!snapshot) throw new Error("the call published nothing");
	return snapshot;
};

/** Let promise chains (transcription, synthesis) run to the end. */
async function settle(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
	await vi.advanceTimersByTimeAsync(1);
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function advance(ms: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
}

/** Loud for `ms`, then quiet again. */
async function talk(ms: number): Promise<void> {
	FakeAudioContext.level = LOUD;
	await advance(ms);
	FakeAudioContext.level = 0;
}

/** One whole utterance: speech, then the silence that ends it, then the transcription. */
async function utterance(ms = 600): Promise<void> {
	await talk(ms);
	await advance(CALL_TUNING.endMs + 100);
	await settle();
}

function assistant(text: string): never {
	return { role: "assistant", content: [{ type: "text", text }] } as never;
}

/** The bot's turn: it starts, says `text`, and ends. */
async function botTurn(text: string | null): Promise<void> {
	useSessionStore.setState({ isStreaming: true });
	if (text !== null) useMessagesStore.setState({ lastAppended: [assistant(text)] });
	useSessionStore.setState({ isStreaming: false });
	await settle();
}

async function startCall(): Promise<VoiceCall> {
	call = startVoiceCall({ tabId: "t-bot", send, onState: snapshot => states.push(snapshot) });
	await advance(0);
	await settle();
	// The floor is measured over the first ticks.
	await advance(CALL_TUNING.calibrationTicks * CALL_TUNING.tickMs + 60);
	return call;
}

beforeEach(() => {
	vi.useFakeTimers();
	mic = installFakeMic();
	FakeAudio.instances = [];
	transcribeAudio = vi.fn(async () => ({ success: true, data: { text: "hello bot" } }));
	synthesizeSpeech = vi.fn(async () => ({
		success: true,
		data: { audioBase64: btoa("wav!"), mimeType: "audio/wav" },
	}));
	send = vi.fn(async () => true);
	states = [];
	call = null;
	vi.stubGlobal("window", {
		omp: {
			rpc: {
				transcribeAudio,
				synthesizeSpeech,
				getSettings: vi.fn(async () => ({ success: true, data: { values: { "speech.mode": "yield" } } })),
			},
		},
	});
	vi.stubGlobal("Audio", FakeAudio);
	vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:clip");
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
	useSessionStore.setState({ isStreaming: false });
	useMessagesStore.setState({ lastAppended: [] });
});

afterEach(() => {
	call?.end();
	vi.restoreAllMocks();
	vi.useRealTimers();
	uninstallFakeMic();
});

describe("startVoiceCall", () => {
	it("opens one mic stream for the call and listens", async () => {
		await startCall();
		expect(mic.getUserMedia).toHaveBeenCalledTimes(1);
		expect(mic.getUserMedia).toHaveBeenCalledWith({
			audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
		});
		expect(phase()).toBe("listening");
		expect(isVoiceCallActive()).toBe(true);
		expect(states[0]?.phase).toBe("starting");
	});

	it("hears speech, transcribes it once, sends it to the bot, speaks the reply, and listens again", async () => {
		await startCall();
		await talk(600);
		expect(phase()).toBe("hearing");
		await advance(CALL_TUNING.endMs + 100);
		await settle();

		expect(transcribeAudio).toHaveBeenCalledTimes(1);
		expect(transcribeAudio.mock.calls[0]?.[1]).toBe("audio/wav");
		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith("hello bot", { streaming: false });
		expect(last()).toMatchObject({ phase: "waiting", heard: "hello bot", busy: true });
		expect(phases()).toEqual(expect.arrayContaining(["hearing", "transcribing", "waiting"]));

		await botTurn(`${REPLY}\n\nSources: notes.md`);
		expect(phase()).toBe("speaking");
		expect(synthesizeSpeech).toHaveBeenCalledTimes(1);
		expect(synthesizeSpeech).toHaveBeenCalledWith(REPLY);
		expect(FakeAudio.instances).toHaveLength(1);
		expect(FakeAudio.instances[0]?.played).toBe(true);

		FakeAudio.instances[0]?.finish();
		await settle();
		expect(phase()).toBe("listening");
		expect(last()).toMatchObject({ busy: false, playing: null, pending: null });
	});

	it("keeps the auto-speak watcher quiet: the reply is synthesized once, by the call", async () => {
		useSettingsStore.setState({ speechEnabled: true });
		const stopAutoSpeak = startVoiceAutoSpeak();
		try {
			await startCall();
			await utterance();
			await botTurn(REPLY);
			expect(synthesizeSpeech).toHaveBeenCalledTimes(1);
			expect(phase()).toBe("speaking");
		} finally {
			stopAutoSpeak();
			useSettingsStore.setState({ speechEnabled: false });
		}
	});

	it("stops the reply at once when the person talks over it, then hears them", async () => {
		await startCall();
		await utterance();
		await botTurn(REPLY);
		const clip = FakeAudio.instances[0];
		expect(phase()).toBe("speaking");

		await talk(600);
		expect(phase()).toBe("hearing");
		expect(clip?.paused).toBe(true);
		// The stopped clip's end must not read as the reply having finished.
		await settle();
		expect(phase()).toBe("hearing");

		await advance(CALL_TUNING.endMs + 100);
		await settle();
		expect(transcribeAudio).toHaveBeenCalledTimes(2);
		expect(send).toHaveBeenCalledTimes(2);
		expect(phase()).toBe("waiting");
	});

	it("does not take a short noise while a reply plays for the person talking over it", async () => {
		await startCall();
		await utterance();
		await botTurn(REPLY);
		await talk(120);
		await advance(400);
		expect(phase()).toBe("speaking");
		expect(FakeAudio.instances[0]?.paused).toBe(false);
	});

	it("holds a reply that lands while the person is talking until they stop", async () => {
		await startCall();
		await utterance();
		await talk(600);
		expect(phase()).toBe("hearing");
		await botTurn(REPLY);
		expect(phase()).toBe("hearing");
		expect(synthesizeSpeech).not.toHaveBeenCalled();

		await advance(CALL_TUNING.endMs + 100);
		await settle();
		expect(synthesizeSpeech).toHaveBeenCalledWith(REPLY);
		expect(phase()).toBe("speaking");
		// The second utterance went out as the bot's own idle prompt: no turn was running any more.
		expect(send).toHaveBeenLastCalledWith("hello bot", { streaming: false });
	});

	it("sends a follow-up while the bot's turn still runs", async () => {
		await startCall();
		await utterance();
		useSessionStore.setState({ isStreaming: true });
		await talk(600);
		await advance(CALL_TUNING.endMs + 100);
		await settle();
		expect(send).toHaveBeenLastCalledWith("hello bot", { streaming: true });
		expect(phase()).toBe("waiting");
		useSessionStore.setState({ isStreaming: false });
	});

	it("drops an utterance shorter than 300 ms without transcribing it", async () => {
		await startCall();
		await talk(180);
		await advance(CALL_TUNING.endMs + 100);
		await settle();
		expect(transcribeAudio).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
		expect(phase()).toBe("listening");
	});

	it("keeps the first syllable: it records from the first loud tick, not from the confirmation", async () => {
		await startCall();
		FakeAudioContext.level = LOUD;
		await advance(CALL_TUNING.tickMs);
		expect(FakeMediaRecorder.instances).toHaveLength(1);
		expect(FakeMediaRecorder.instances[0]?.state).toBe("recording");
		FakeAudioContext.level = 0;
		await advance(400);
		// A blip that was not speech leaves no recording behind.
		expect(FakeMediaRecorder.instances[0]?.state).toBe("inactive");
		expect(transcribeAudio).not.toHaveBeenCalled();
	});

	it("goes back to listening on an empty transcript", async () => {
		transcribeAudio.mockImplementationOnce(async () => ({ success: true, data: { text: "  " } }));
		await startCall();
		await utterance();
		expect(send).not.toHaveBeenCalled();
		expect(phase()).toBe("listening");
		expect(last().error).toBeUndefined();
	});

	it("stays listening through a transcription that failed, with the reason shown", async () => {
		transcribeAudio.mockImplementationOnce(async () => ({ success: false, error: "stt unavailable" }));
		await startCall();
		await utterance();
		expect(phase()).toBe("listening");
		expect(last().error).toBe("failed");
		await utterance();
		expect(send).toHaveBeenCalledTimes(1);
		expect(last().error).toBeUndefined();
	});

	it("ends with the reason when no dictation model is configured", async () => {
		transcribeAudio.mockImplementationOnce(async () => ({
			success: false,
			error: "No stt model devices configured",
		}));
		await startCall();
		await utterance();
		expect(last()).toMatchObject({ phase: "ended", error: "no-model" });
		expect(isVoiceCallActive()).toBe(false);
		expect(mic.streams[0]?.track.stopped).toBe(true);
	});

	it("goes back to listening, with the reason, when it cannot play the reply", async () => {
		synthesizeSpeech.mockImplementationOnce(async () => ({ success: false, error: "tts down" }));
		await startCall();
		await utterance();
		await botTurn(REPLY);
		expect(last()).toMatchObject({ phase: "listening", error: "speak" });
		await utterance();
		expect(last().error).toBeUndefined();
	});

	it("goes back to listening when the words never reached the bot", async () => {
		send.mockImplementationOnce(async () => false);
		await startCall();
		await utterance();
		expect(phase()).toBe("listening");
		expect(last().busy).toBe(false);
	});

	it("says what is wrong when the mic is refused, missing or taken, and holds nothing open", async () => {
		for (const [name, error] of [
			["NotAllowedError", "denied"],
			["NotFoundError", "no-device"],
			["NotReadableError", "in-use"],
		] as const) {
			states = [];
			mic.getUserMedia.mockImplementationOnce(async () => {
				throw new DOMException("x", name);
			});
			call = startVoiceCall({ tabId: "t-bot", send, onState: snapshot => states.push(snapshot) });
			await settle();
			expect(last()).toMatchObject({ phase: "ended", error });
			expect(isVoiceCallActive()).toBe(false);
		}
		expect(FakeAudioContext.instances).toHaveLength(0);
	});

	it("treats a page with no microphone API as a blocked mic", async () => {
		Reflect.deleteProperty(navigator, "mediaDevices");
		call = startVoiceCall({ tabId: "t-bot", send, onState: snapshot => states.push(snapshot) });
		await settle();
		expect(last()).toMatchObject({ phase: "ended", error: "denied" });
	});

	it("publishes the mic level as meter bands", async () => {
		await startCall();
		await advance(120);
		expect(last().levels).toHaveLength(METER_BARS);
		expect(last().levels.some(level => level > 0)).toBe(true);
	});

	describe("muted", () => {
		it("hears nothing, transcribes nothing, and turns the mic track off; replies are still spoken", async () => {
			await startCall();
			call?.setMuted(true);
			expect(last().muted).toBe(true);
			expect(mic.streams[0]?.track.enabled).toBe(false);
			expect(last().levels.every(level => level === 0)).toBe(true);

			await utterance();
			expect(FakeMediaRecorder.instances).toHaveLength(0);
			expect(transcribeAudio).not.toHaveBeenCalled();
			expect(phase()).toBe("listening");

			await botTurn(REPLY);
			expect(phase()).toBe("speaking");
			expect(synthesizeSpeech).toHaveBeenCalledWith(REPLY);

			// Talking over a reply does not interrupt it while muted.
			await talk(400);
			expect(phase()).toBe("speaking");
			expect(FakeAudio.instances[0]?.paused).toBe(false);
		});

		it("drops the utterance being heard when muted, and hears again once unmuted", async () => {
			await startCall();
			await talk(400);
			expect(phase()).toBe("hearing");
			call?.setMuted(true);
			expect(phase()).toBe("listening");
			await advance(CALL_TUNING.endMs + 100);
			await settle();
			expect(transcribeAudio).not.toHaveBeenCalled();

			call?.setMuted(false);
			expect(mic.streams[0]?.track.enabled).toBe(true);
			await utterance();
			expect(transcribeAudio).toHaveBeenCalledTimes(1);
			expect(send).toHaveBeenCalledTimes(1);
		});
	});

	describe("end", () => {
		it("stops the mic, the recorder, the timers and the audio context", async () => {
			await startCall();
			await talk(400);
			expect(FakeMediaRecorder.instances[0]?.state).toBe("recording");
			call?.end();
			expect(last().phase).toBe("ended");
			expect(mic.streams[0]?.track.stopped).toBe(true);
			expect(FakeMediaRecorder.instances[0]?.state).toBe("inactive");
			expect(FakeAudioContext.instances.every(context => context.closed)).toBe(true);
			expect(isVoiceCallActive()).toBe(false);
			expect(vi.getTimerCount()).toBe(0);

			const published = states.length;
			await advance(3000);
			expect(states).toHaveLength(published);
			expect(transcribeAudio).not.toHaveBeenCalled();
		});

		it("stops a reply that is playing", async () => {
			await startCall();
			await utterance();
			await botTurn(REPLY);
			call?.end();
			expect(FakeAudio.instances[0]?.paused).toBe(true);
			expect(last().phase).toBe("ended");
		});

		it("stops a reply still being synthesized: nothing plays afterwards", async () => {
			const synthesis = Promise.withResolvers<RpcReply>();
			synthesizeSpeech.mockImplementationOnce(() => synthesis.promise);
			await startCall();
			await utterance();
			await botTurn(REPLY);
			call?.end();
			synthesis.resolve({ success: true, data: { audioBase64: btoa("wav!") } });
			await settle();
			expect(FakeAudio.instances).toHaveLength(0);
		});

		it("releases a mic that opens after the call ended", async () => {
			const opened = Promise.withResolvers<FakeStream>();
			mic.getUserMedia.mockImplementationOnce(() => opened.promise);
			call = startVoiceCall({ tabId: "t-bot", send, onState: snapshot => states.push(snapshot) });
			call.end();
			const stream = new FakeStream();
			opened.resolve(stream);
			await settle();
			expect(stream.track.stopped).toBe(true);
			expect(FakeAudioContext.instances).toHaveLength(0);
			expect(vi.getTimerCount()).toBe(0);
		});

		it("drops a transcription that lands after the call ended", async () => {
			const transcription = Promise.withResolvers<RpcReply>();
			transcribeAudio.mockImplementationOnce(() => transcription.promise);
			await startCall();
			await talk(600);
			await advance(CALL_TUNING.endMs + 100);
			await settle();
			expect(phase()).toBe("transcribing");
			call?.end();
			transcription.resolve({ success: true, data: { text: "too late" } });
			await settle();
			expect(send).not.toHaveBeenCalled();
		});

		it("is replaced by the next call, which takes over the mic", async () => {
			await startCall();
			const first = call;
			const second = startVoiceCall({ tabId: "t-other", send, onState: () => undefined });
			expect(states.at(-1)?.phase).toBe("ended");
			expect(isVoiceCallActive()).toBe(true);
			second.end();
			expect(isVoiceCallActive()).toBe(false);
			first?.end();
		});
	});

	it("starts waiting when the call opens on a bot turn that already runs", async () => {
		useSessionStore.setState({ isStreaming: true });
		await startCall();
		expect(phase()).toBe("waiting");
		await botTurn(REPLY);
		expect(synthesizeSpeech).toHaveBeenCalledWith(REPLY);
	});

	it("speaks nothing for a turn that ends with no reply, or one that was aborted", async () => {
		await startCall();
		await utterance();
		useSessionStore.setState({ isStreaming: true });
		useMessagesStore.setState({
			lastAppended: [
				{ role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "half" }] },
			] as never,
		});
		useSessionStore.setState({ isStreaming: false });
		await settle();
		expect(synthesizeSpeech).not.toHaveBeenCalled();
		expect(phase()).toBe("listening");
	});

	it("caps a never-ending utterance at a minute and sends what it has", async () => {
		await startCall();
		await talk(CALL_TUNING.maxUtteranceMs + 500);
		await settle();
		expect(transcribeAudio).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith("hello bot", { streaming: false });
	});
});

function phases(): CallPhase[] {
	return states.map(snapshot => snapshot.phase);
}
