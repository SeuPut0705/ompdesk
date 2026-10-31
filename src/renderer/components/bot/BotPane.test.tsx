/**
 * The bot's own pane is one screen: the conversation stays, its bar sits above it, its open decisions above the
 * composer, and its board knows it is the bot's. Nowhere else (a plain session, a paired computer's session the
 * computer does not mark as its bot, a bot the owner turned off).
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { type BotDeskState, EMPTY_BOT_DESK } from "../../../shared/bot-desk";
import { I18nProvider } from "../../lib/i18n";
import { useBotStore } from "../../stores/bot";
import { useBotDeskStore } from "../../stores/bot-desk";
import { resetSessionListFeeds, sessionListFeed } from "../../stores/session-list";
import type { SessionTab } from "../../stores/tabs";
import { BotPane } from "./BotPane";
import { preloadBotDesk, useBotTab } from "./bot-tab";

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

const BOT = "/work-sessions/bot.jsonl";

const OPEN_DESK: BotDeskState = {
	...EMPTY_BOT_DESK,
	duties: [],
	wakes: [],
	decisions: [{ id: "d1", state: "open", question: "Ship?", options: ["Yes"], at: "2026-10-31T09:00:00.000Z" }],
};

function tab(overrides: Partial<SessionTab> = {}): SessionTab {
	return { id: "tbot", cwd: "/w", status: "ready", kind: "chat", sessionPath: BOT, unreadDone: false, ...overrides };
}

interface DeskApi {
	get: Mock<(device?: string) => Promise<BotDeskState>>;
	answer: Mock<(payload: unknown, device?: string) => Promise<void>>;
	setDuties: Mock<(payload: unknown, device?: string) => Promise<void>>;
	onChanged: Mock<(callback: unknown) => () => void>;
}

let container: Element;
let root: Root;

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as Element;
	document.body.appendChild(container as never);
	root = createRoot(container);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
}

function props<T>(element: Element | null): T {
	if (!element) throw new Error("props: element is null");
	const record = element as unknown as Record<string, unknown>;
	const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
	if (!key) throw new Error("props: React props missing");
	return record[key] as T;
}

function installApi(): DeskApi {
	const api: DeskApi = {
		// The pane reads this computer's desk once itself (a phone's page has no sidebar to): the same desk as applied.
		get: vi.fn(async () => OPEN_DESK),
		answer: vi.fn(async () => {}),
		setDuties: vi.fn(async () => {}),
		onChanged: vi.fn(() => () => {}),
	};
	(window as unknown as { omp: unknown }).omp = { sessions: { botDesk: api } };
	return api;
}

const query = (selector: string) => container.querySelector(selector);

/** What the work board reads to draw the bot's sections. */
function BoardProbe() {
	const bot = useBotTab();
	return <div data-board-probe={bot === null ? "none" : `${bot.tabId}@${bot.device ?? "local"}`} />;
}

function pane(openTab: SessionTab): ReactElement {
	return (
		<BotPane tab={openTab}>
			<div data-transcript>transcript</div>
			<BoardProbe />
		</BotPane>
	);
}

async function mountPane(openTab: SessionTab = tab(), state: BotDeskState = OPEN_DESK): Promise<void> {
	useBotStore.setState({ enabled: true, path: BOT });
	useBotDeskStore.getState().apply(state);
	// The bot's parts are loaded on demand; once the bot is on the app fetches them on idle, as here.
	await preloadBotDesk();
	await mount(pane(openTab));
}

function listHost(rows: { path: string; bot: "on" | "off" }[]): void {
	sessionListFeed("global", "mini").store.setState({ sessions: rows as never });
}

/** A plain pane: the transcript as it was, nothing of the bot around it. */
function expectPlain(): void {
	expect(query("[data-transcript]")).not.toBeNull();
	expect(query("[data-bot-bar]")).toBeNull();
	expect(query("[data-bot-decisions-dock]")).toBeNull();
	expect(query("[data-board-probe]")?.getAttribute("data-board-probe")).toBe("none");
}

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container.remove();
	useBotStore.getState().reset();
	useBotDeskStore.getState().reset();
	resetSessionListFeeds();
	delete (window as unknown as { omp?: unknown }).omp;
});

describe("BotPane", () => {
	it("keeps the conversation with the bar above it, the open decisions above the composer, and no switch", async () => {
		installApi();
		await mountPane();

		const bar = query("[data-bot-bar]");
		const transcript = query("[data-transcript]");
		const dock = query("[data-bot-decisions-dock]");
		expect(bar?.querySelector("[data-bot-state]")).not.toBeNull();
		expect(transcript).not.toBeNull();
		expect(dock?.querySelector('[data-bot-decision="d1"]')).not.toBeNull();
		// In that order: bar, conversation, decisions.
		const order = [...container.querySelectorAll("[data-bot-bar], [data-transcript], [data-bot-decisions-dock]")];
		expect(order).toEqual([bar, transcript, dock]);
		expect(query('[role="tablist"]')).toBeNull();
		expect(query("[data-board-probe]")?.getAttribute("data-board-probe")).toBe("tbot@local");
	});

	it("answers a decision while the conversation stays on screen, and drops the dock when none is open", async () => {
		const api = installApi();
		await mountPane();

		await act(async () => props<{ onClick: () => void }>(query('[data-bot-option="Yes"]')).onClick());
		expect(api.answer).toHaveBeenCalledWith({ id: "d1", answer: "Yes" });
		expect(query("[data-transcript]")).not.toBeNull();

		await act(async () =>
			useBotDeskStore.getState().apply({ ...EMPTY_BOT_DESK, duties: [], wakes: [], decisions: [] }),
		);
		expect(query("[data-bot-decisions-dock]")).toBeNull();
		expect(query("[data-bot-bar]")).not.toBeNull();
	});

	it("draws the bar's static frame until the bot's parts load, never a spinner", async () => {
		installApi();
		// A fresh module graph (a module boundary on purpose): nothing of the bot loaded yet, and its own stores.
		vi.resetModules();
		const fresh = await import("./BotPane");
		const freshBot = await import("../../stores/bot");
		freshBot.useBotStore.setState({ enabled: true, path: BOT });
		await mount(<fresh.BotPane tab={tab()}>{<div data-transcript>transcript</div>}</fresh.BotPane>);
		expect(query("[data-bot-bar]")?.getAttribute("aria-hidden")).toBe("true");
		expect(query(".omp-spinner")).toBeNull();
		expect(query("[data-transcript]")).not.toBeNull();
	});

	it("is only the bot's own session: a plain session stays plain", async () => {
		installApi();
		await mountPane(tab({ id: "tother", sessionPath: "/work/other.jsonl" }));
		expectPlain();
	});

	it("never takes over a paired computer's session at the bot's own path unless that computer marks it its bot", async () => {
		installApi();
		await mountPane(tab({ device: "mini" }));
		expectPlain();
	});

	it("is the same screen for a paired computer's bot, once that computer's list marks its session on", async () => {
		const api = installApi();
		api.get.mockResolvedValue(OPEN_DESK);
		useBotStore.setState({ enabled: false, path: null });
		listHost([{ path: "/mini/bot.jsonl", bot: "on" }]);
		// This computer's own desk says nothing is waiting; only the host's has a decision.
		useBotDeskStore.getState().apply({ ...EMPTY_BOT_DESK, duties: [], wakes: [], decisions: [] });
		useBotDeskStore.getState().apply(OPEN_DESK, "mini");
		await preloadBotDesk();
		await mount(pane(tab({ device: "mini", sessionPath: "/mini/bot.jsonl" })));

		expect(query("[data-bot-bar]")).not.toBeNull();
		expect(query("[data-transcript]")).not.toBeNull();
		expect(query("[data-board-probe]")?.getAttribute("data-board-probe")).toBe("tbot@mini");
		await act(async () => props<{ onClick: () => void }>(query('[data-bot-option="Yes"]')).onClick());
		expect(api.answer).toHaveBeenCalledWith({ id: "d1", answer: "Yes" }, "mini");
	});

	it("reads a host's desk when its bot pane opens before anything read it", async () => {
		const api = installApi();
		api.get.mockResolvedValue(OPEN_DESK);
		listHost([{ path: "/mini/bot.jsonl", bot: "on" }]);
		await preloadBotDesk();
		await mount(pane(tab({ device: "mini", sessionPath: "/mini/bot.jsonl" })));

		await vi.waitFor(() => expect(query('[data-bot-decision="d1"]')).not.toBeNull());
		expect(api.get).toHaveBeenCalledWith("mini");
		expect(api.get.mock.calls.every(call => call[0] === "mini")).toBe(true);
	});

	it("leaves a paired computer's bot plain while that computer has it off, and follows its switch", async () => {
		installApi();
		listHost([{ path: "/mini/bot.jsonl", bot: "off" }]);
		await mount(pane(tab({ device: "mini", sessionPath: "/mini/bot.jsonl" })));
		expectPlain();

		await preloadBotDesk();
		await act(async () => listHost([{ path: "/mini/bot.jsonl", bot: "on" }]));
		expect(query("[data-bot-bar]")).not.toBeNull();
	});

	it("leaves the pane plain while the owner has the bot off", async () => {
		installApi();
		useBotStore.setState({ enabled: false, path: null });
		await mount(pane(tab()));
		expectPlain();
	});
});
