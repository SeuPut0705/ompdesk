import { afterEach, describe, expect, it } from "vitest";
import type { RemoteLinkState } from "../../../shared/ipc-types";
import { useBotCallStore } from "../../stores/bot-call";
import { type BotMotion, botMotion } from "./bot-motion";
import type { BotState } from "./bot-status";

const STATES: BotState[] = ["idle", "working", "waiting", "asleep"];
const LINKS: RemoteLinkState[] = ["connecting", "online", "offline"];

describe("botMotion", () => {
	it("maps every bot state through when nothing outranks it", () => {
		for (const state of STATES) {
			expect(botMotion({ state, speaking: false })).toBe(state);
			expect(botMotion({ state, link: "online", speaking: false })).toBe(state);
		}
	});

	it("speaks over every state while the link is up or local", () => {
		for (const state of STATES) {
			expect(botMotion({ state, speaking: true })).toBe("speaking");
			expect(botMotion({ state, link: "online", speaking: true })).toBe("speaking");
		}
	});

	it("reconnecting beats speaking beats the state", () => {
		for (const state of STATES) {
			for (const link of LINKS.filter(candidate => candidate !== "online")) {
				expect(botMotion({ state, link, speaking: false })).toBe("reconnecting");
				expect(botMotion({ state, link, speaking: true })).toBe("reconnecting");
			}
		}
	});

	it("reads no link as a local bot", () => {
		const motion: BotMotion = botMotion({ state: "waiting", link: undefined, speaking: false });
		expect(motion).toBe("waiting");
	});
});

describe("useBotCallStore speaking", () => {
	afterEach(() => {
		useBotCallStore.setState({ tabId: null, speaking: false });
	});

	it("is on only for the call's own tab and ends with it", () => {
		const { start, setSpeaking, end } = useBotCallStore.getState();
		start("a");
		setSpeaking("b", true);
		expect(useBotCallStore.getState().speaking).toBe(false);
		setSpeaking("a", true);
		expect(useBotCallStore.getState().speaking).toBe(true);
		end("b");
		expect(useBotCallStore.getState().speaking).toBe(true);
		end("a");
		expect(useBotCallStore.getState()).toMatchObject({ tabId: null, speaking: false });
		start("a");
		expect(useBotCallStore.getState().speaking).toBe(false);
	});
});
