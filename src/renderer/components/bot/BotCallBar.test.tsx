/**
 * The voice call's bar: mounting it is the call (it starts for its tab, ends on unmount and on End), each phase is
 * said in words and carried on `data-bot-call-phase`, Mute is a pressed toggle, and a call that cannot go on says why
 * in one line (with the setting's link when a dictation model is the fix).
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { I18nProvider, translate } from "../../lib/i18n";
import type * as VoiceCallModule from "../../lib/voice-call";
import type { CallPhase, CallSnapshot, VoiceCallOptions } from "../../lib/voice-call";
import { useBotCallStore } from "../../stores/bot-call";
import { useUiStore } from "../../stores/ui";
import { BotCallBar } from "./BotCallBar";

const startVoiceCall = vi.hoisted(() => vi.fn());

vi.mock("../../lib/voice-call", async importOriginal => ({
	...(await importOriginal<typeof VoiceCallModule>()),
	startVoiceCall,
}));

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const snapshot = (over: Partial<CallSnapshot> = {}): CallSnapshot => ({
	phase: "listening",
	muted: false,
	busy: false,
	heard: "",
	partial: "",
	pending: null,
	playing: null,
	levels: [0, 0, 0, 0, 0],
	...over,
});

let container: Element;
let root: Root;
let options: VoiceCallOptions;
let call: { end: Mock<() => void>; setMuted: Mock<(muted: boolean) => void> };
let rpc: { prompt: Mock<(text: string) => Promise<unknown>>; followUp: Mock<(text: string) => Promise<unknown>> };

const query = (selector: string) => container.querySelector(selector);
const text = (selector: string) => query(selector)?.textContent ?? null;

function props<T>(element: Element | null): T {
	if (!element) throw new Error("props: element is null");
	const record = element as unknown as Record<string, unknown>;
	const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
	if (!key) throw new Error("props: React props missing");
	return record[key] as T;
}

const press = (selector: string) => act(async () => props<{ onClick: () => void }>(query(selector)).onClick());

/** The call publishes a state. */
const publish = (next: Partial<CallSnapshot>) => act(async () => options.onState(snapshot(next)));

async function mountBar(): Promise<void> {
	container = document.createElement("div") as unknown as Element;
	document.body.appendChild(container as never);
	root = createRoot(container);
	await act(async () => {
		root.render(
			<I18nProvider>
				<BotCallBar tabId="tbot" />
			</I18nProvider>,
		);
	});
}

beforeEach(() => {
	call = { end: vi.fn(), setMuted: vi.fn() };
	startVoiceCall.mockReset();
	startVoiceCall.mockImplementation((next: VoiceCallOptions) => {
		options = next;
		return call;
	});
	rpc = {
		prompt: vi.fn(async () => ({ success: true })),
		followUp: vi.fn(async () => ({ success: true })),
	};
	(window as unknown as { omp: unknown }).omp = { rpc };
	useBotCallStore.setState({ tabId: "tbot" });
});

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container.remove();
	useBotCallStore.setState({ tabId: null });
	delete (window as unknown as { omp?: unknown }).omp;
});

describe("BotCallBar", () => {
	it("starts the call for its tab when it mounts and ends it when it unmounts", async () => {
		await mountBar();
		expect(startVoiceCall).toHaveBeenCalledTimes(1);
		expect(startVoiceCall.mock.calls[0]?.[0]).toMatchObject({ tabId: "tbot" });
		expect(call.end).not.toHaveBeenCalled();
		expect(query("[data-bot-call-bar]")).not.toBeNull();

		await act(async () => root.render(<div />));
		expect(call.end).toHaveBeenCalledTimes(1);
		await act(async () => root.render(<div />));
	});

	it("says each phase in words and carries it on the bar", async () => {
		await mountBar();
		const words: Array<[CallPhase, boolean, string]> = [
			["starting", false, "botCall.phase.starting"],
			["listening", false, "botCall.phase.listening"],
			["listening", true, "botCall.phase.muted"],
			["hearing", false, "botCall.phase.hearing"],
			["transcribing", false, "botCall.phase.transcribing"],
			["waiting", false, "botCall.phase.waiting"],
			["speaking", false, "botCall.phase.speaking"],
			["speaking", true, "botCall.phase.speakingMuted"],
		];
		for (const [phase, muted, key] of words) {
			await publish({ phase, muted });
			expect(query("[data-bot-call-bar]")?.getAttribute("data-bot-call-phase")).toBe(phase);
			expect(text("[data-bot-call-status]")).toBe(translate(key));
		}
		expect(translate("botCall.phase.speaking")).toBe("Speaking — talk to interrupt");
		expect(query(".omp-spinner")).toBeNull();
	});

	it("shows the last words heard, and what was heard in full as its tooltip", async () => {
		await mountBar();
		expect(text("[data-bot-call-heard]")).toBe("");
		await publish({ phase: "waiting", heard: "what is on my calendar today" });
		expect(text("[data-bot-call-heard]")).toBe("“what is on my calendar today”");
		expect(query("[data-bot-call-heard]")?.getAttribute("title")).toBe(
			translate("botCall.heard", { text: "what is on my calendar today" }),
		);
	});

	it("shows the running text while the person talks, in place of the last words heard", async () => {
		await mountBar();
		await publish({ phase: "hearing", heard: "earlier", partial: "what is on my" });
		expect(text("[data-bot-call-heard]")).toBe("“what is on my…”");
		expect(query("[data-bot-call-heard]")?.hasAttribute("data-bot-call-partial")).toBe(true);
		expect(query("[data-bot-call-heard]")?.getAttribute("title")).toBe(
			translate("botCall.partial", { text: "what is on my" }),
		);
		await publish({ phase: "listening", heard: "what is on my calendar", partial: "" });
		expect(text("[data-bot-call-heard]")).toBe("“what is on my calendar”");
		expect(query("[data-bot-call-heard]")?.hasAttribute("data-bot-call-partial")).toBe(false);
	});

	it("draws the mic level as five bars", async () => {
		await mountBar();
		await publish({ levels: [0, 0.25, 0.5, 0.75, 1] });
		const bars = [...container.querySelectorAll("[data-bot-call-meter] > span")];
		expect(bars).toHaveLength(5);
		expect(bars.map(bar => bar.getAttribute("style")?.replace(/[\s;]/g, ""))).toEqual([
			"height:4px",
			"height:8px",
			"height:12px",
			"height:16px",
			"height:20px",
		]);
	});

	it("mutes with a pressed toggle that follows the call's state", async () => {
		await mountBar();
		const mute = () => query("[data-bot-call-mute]");
		expect(mute()?.getAttribute("aria-pressed")).toBe("false");
		expect(mute()?.getAttribute("aria-label")).toBe(translate("botCall.mute"));

		await press("[data-bot-call-mute]");
		expect(call.setMuted).toHaveBeenLastCalledWith(true);
		await publish({ muted: true });
		expect(mute()?.getAttribute("aria-pressed")).toBe("true");

		await press("[data-bot-call-mute]");
		expect(call.setMuted).toHaveBeenLastCalledWith(false);
	});

	it("ends the call with End and clears this tab's call", async () => {
		await mountBar();
		expect(text("[data-bot-call-end]")).toBe(translate("botCall.end"));
		await press("[data-bot-call-end]");
		expect(call.end).toHaveBeenCalled();
		expect(useBotCallStore.getState().tabId).toBeNull();
	});

	it("leaves another tab's call alone", async () => {
		useBotCallStore.setState({ tabId: "tother" });
		await mountBar();
		await press("[data-bot-call-end]");
		expect(useBotCallStore.getState().tabId).toBe("tother");
	});

	it("says why when the mic cannot be used, and offers End", async () => {
		await mountBar();
		for (const [error, key] of [
			["denied", "voice.fail.denied"],
			["no-device", "voice.fail.noDevice"],
			["in-use", "voice.fail.inUse"],
		] as const) {
			await publish({ phase: "ended", error });
			expect(query("[data-bot-call-error]")?.getAttribute("data-bot-call-error")).toBe(error);
			expect(text("[data-bot-call-error]")).toContain(translate(key));
			expect(query("[data-bot-call-settings]")).toBeNull();
			expect(query("[data-bot-call-mute]")).toBeNull();
			expect(query("[data-bot-call-end]")).not.toBeNull();
		}
	});

	it("links to the dictation setting when no model can transcribe", async () => {
		const openSettings = vi.fn();
		useUiStore.setState({ openSettings });
		await mountBar();
		await publish({ phase: "ended", error: "no-model" });
		expect(text("[data-bot-call-error]")).toContain(translate("botCall.error.noModel"));
		await press("[data-bot-call-settings]");
		expect(openSettings).toHaveBeenCalledWith("agent:setting-stt.enabled");
	});

	it("keeps going and says so when one utterance or reply failed", async () => {
		await mountBar();
		await publish({ phase: "listening", error: "failed" });
		expect(text("[data-bot-call-error]")).toContain(translate("botCall.error.failed"));
		expect(query("[data-bot-call-mute]")).not.toBeNull();
		await publish({ phase: "listening", error: "speak" });
		expect(text("[data-bot-call-error]")).toContain(translate("voice.speak.failed"));
	});

	it("sends the words to the bot's tab: a prompt, or a follow-up while its turn runs", async () => {
		await mountBar();
		await expect(options.send("hello", { streaming: false })).resolves.toBe(true);
		expect(rpc.prompt).toHaveBeenCalledWith("hello");
		await expect(options.send("and also", { streaming: true })).resolves.toBe(true);
		expect(rpc.followUp).toHaveBeenCalledWith("and also");
		expect(rpc.prompt).toHaveBeenCalledTimes(1);

		rpc.prompt.mockResolvedValueOnce({ success: false, error: "no session" });
		await expect(options.send("lost", { streaming: false })).resolves.toBe(false);
	});
});
