/**
 * The bot's own pane: the home first, one switch to the chat, the composer's send switching to the chat, and the home
 * nowhere else (a plain session, a paired computer's bot, a bot the owner turned off).
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { BotDeskState } from "../../../shared/bot-desk";
import { I18nProvider } from "../../lib/i18n";
import { useBotStore } from "../../stores/bot";
import { useBotDeskStore } from "../../stores/bot-desk";
import { useComposerStore } from "../../stores/composer";
import type { SessionTab } from "../../stores/tabs";
import { BotPane, preloadBotHome } from "./BotPane";

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

function tab(overrides: Partial<SessionTab> = {}): SessionTab {
	return { id: "tbot", cwd: "/w", status: "ready", kind: "chat", sessionPath: BOT, unreadDone: false, ...overrides };
}

interface DeskApi {
	get: Mock<() => Promise<BotDeskState>>;
	answer: Mock<() => Promise<void>>;
	setDuties: Mock<() => Promise<void>>;
	onChanged: Mock<() => () => void>;
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
		get: vi.fn(async () => ({ duties: [], decisions: [], wakes: [] })),
		answer: vi.fn(async () => {}),
		setDuties: vi.fn(async () => {}),
		onChanged: vi.fn(() => () => {}),
	};
	(window as unknown as { omp: unknown }).omp = { sessions: { botDesk: api } };
	return api;
}

const query = (selector: string) => container.querySelector(selector);

async function choose(view: "home" | "chat"): Promise<void> {
	await act(async () => props<{ onClick: () => void }>(query(`[data-bot-switch] [data-tab-id="${view}"]`)).onClick());
}

async function mountPane(openTab: SessionTab = tab()): Promise<void> {
	useBotStore.setState({ enabled: true, path: BOT });
	useBotDeskStore.getState().apply({ duties: [], decisions: [], wakes: [] });
	// The home is loaded on demand; once the bot is on the app fetches it on idle, as here.
	await preloadBotHome();
	await mount(
		<BotPane tab={openTab}>
			<div data-transcript>transcript</div>
		</BotPane>,
	);
}

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container.remove();
	useBotStore.getState().reset();
	useBotDeskStore.getState().reset();
	useComposerStore.setState({ sending: false });
	delete (window as unknown as { omp?: unknown }).omp;
});

describe("BotPane", () => {
	it("opens on the home, in place of the transcript, with the switch above it", async () => {
		installApi();
		await mountPane();

		expect(query("[data-bot-home]")).not.toBeNull();
		expect(query("[data-transcript]")).toBeNull();
		expect(query('[data-bot-switch] [data-tab-id="home"]')?.getAttribute("aria-selected")).toBe("true");
		expect(query('[data-bot-switch] [data-tab-id="chat"]')?.getAttribute("aria-selected")).toBe("false");
	});

	it("switches to the chat and back with the one switch", async () => {
		installApi();
		await mountPane();

		await choose("chat");
		expect(query("[data-bot-home]")).toBeNull();
		expect(query("[data-transcript]")).not.toBeNull();

		await choose("home");
		expect(query("[data-bot-home]")).not.toBeNull();
		expect(query("[data-transcript]")).toBeNull();
	});

	it("goes back to the chat when the owner sends a message from the composer", async () => {
		installApi();
		await mountPane();
		expect(query("[data-bot-home]")).not.toBeNull();

		await act(async () => useComposerStore.setState({ sending: true }));

		expect(query("[data-bot-home]")).toBeNull();
		expect(query("[data-transcript]")).not.toBeNull();
	});

	it("opens on the home again each time the pane opens", async () => {
		installApi();
		await mountPane();
		await choose("chat");
		await act(async () => root.unmount());
		container.remove();

		await mountPane();

		expect(query("[data-bot-home]")).not.toBeNull();
	});

	it("counts the open decisions on the Home side of the switch", async () => {
		installApi();
		await mountPane();
		await act(async () =>
			useBotDeskStore.getState().apply({
				duties: [],
				wakes: [],
				decisions: [
					{ id: "a", state: "open", question: "One?", options: [], at: "2026-10-31T09:00:00.000Z" },
					{ id: "b", state: "open", question: "Two?", options: [], at: "2026-10-31T09:01:00.000Z" },
					{
						id: "c",
						state: "answered",
						question: "Three?",
						options: [],
						answer: "Yes",
						at: "2026-10-31T08:00:00.000Z",
						answeredAt: "2026-10-31T08:01:00.000Z",
					},
				],
			}),
		);

		expect(query('[data-bot-switch] [data-tab-id="home"]')?.textContent).toContain("2");
		expect(query('[data-bot-switch] [data-tab-id="chat"]')?.textContent).not.toMatch(/\d/);
	});

	it("is only the bot's own session: a plain session keeps its transcript and has no switch", async () => {
		installApi();
		await mountPane(tab({ id: "tother", sessionPath: "/work/other.jsonl" }));

		expect(query("[data-bot-switch]")).toBeNull();
		expect(query("[data-bot-home]")).toBeNull();
		expect(query("[data-transcript]")).not.toBeNull();
	});

	it("never takes over a paired computer's bot, which holds a session at the same path", async () => {
		installApi();
		await mountPane(tab({ device: "mini" }));

		expect(query("[data-bot-switch]")).toBeNull();
		expect(query("[data-transcript]")).not.toBeNull();
	});

	it("leaves the transcript alone while the owner has the bot off", async () => {
		installApi();
		useBotStore.setState({ enabled: false, path: null });
		await mount(
			<BotPane tab={tab()}>
				<div data-transcript>transcript</div>
			</BotPane>,
		);

		expect(query("[data-bot-switch]")).toBeNull();
		expect(query("[data-transcript]")).not.toBeNull();
	});
});
