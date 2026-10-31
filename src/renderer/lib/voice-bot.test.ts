import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_BOT_DESK } from "../../shared/bot-desk";
import { useBotStore } from "../stores/bot";
import { useBotDeskStore } from "../stores/bot-desk";
import { useMessagesStore } from "../stores/messages";
import { useSessionStore } from "../stores/session";
import { useSettingsStore } from "../stores/settings";
import { type SessionTab, useTabsStore } from "../stores/tabs";
import { startVoiceAutoSpeak } from "./voice";

const BOT_PATH = "/sessions/bot.jsonl";

const synthesizeSpeech = vi.fn(async (_text: string) => ({ success: true, data: {} }));
let stop: () => void;

async function flush(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

function setActiveTab(sessionPath: string): void {
	useTabsStore.setState({
		activeTabId: "t1",
		tabs: [{ id: "t1", sessionPath }] as unknown as SessionTab[],
	});
}

function setSpeakReplies(speakReplies: boolean): void {
	useBotDeskStore.setState({
		desks: {
			local: {
				desk: { ...EMPTY_BOT_DESK, voice: { ...EMPTY_BOT_DESK.voice, speakReplies } },
				loaded: true,
				loadError: null,
				revision: 1,
			},
		},
	});
}

/** One run: a tool-chatter assistant message, then the final reply, then the run ends. */
async function runWithReplies(): Promise<void> {
	useSessionStore.setState({ isStreaming: true });
	for (const text of ["checking files", "All done."]) {
		useMessagesStore.setState({
			lastAppended: [{ role: "assistant", content: [{ type: "text", text }] }] as never,
		});
	}
	useSessionStore.setState({ isStreaming: false });
	await flush();
}

beforeEach(() => {
	synthesizeSpeech.mockClear();
	vi.stubGlobal("window", { omp: { rpc: { synthesizeSpeech } } });
	vi.stubGlobal("document", { visibilityState: "visible" });
	useSettingsStore.setState({ speechEnabled: false });
	useBotStore.setState({ enabled: true, path: BOT_PATH });
	setSpeakReplies(true);
	setActiveTab(BOT_PATH);
	stop = startVoiceAutoSpeak();
});

afterEach(() => {
	stop();
	vi.unstubAllGlobals();
});

describe("bot spoken replies", () => {
	it("speaks the bot tab's last reply once when the desk flag is on", async () => {
		await runWithReplies();
		expect(synthesizeSpeech).toHaveBeenCalledTimes(1);
		expect(synthesizeSpeech).toHaveBeenCalledWith("All done.");
	});

	it("stays silent when the desk flag is off", async () => {
		setSpeakReplies(false);
		await runWithReplies();
		expect(synthesizeSpeech).not.toHaveBeenCalled();
	});

	it("stays silent on another tab", async () => {
		setActiveTab("/sessions/other.jsonl");
		await runWithReplies();
		expect(synthesizeSpeech).not.toHaveBeenCalled();
	});

	it("stays silent while the window is hidden", async () => {
		vi.stubGlobal("document", { visibilityState: "hidden" });
		await runWithReplies();
		expect(synthesizeSpeech).not.toHaveBeenCalled();
	});
});
