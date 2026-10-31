/**
 * The bot's home: its decisions (answered with an option or in the owner's own words), its duties (the whole list
 * written on every edit), its sessions and wakes, and the static skeleton before the first read.
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { BotDecision, BotDeskAnswer, BotDeskDuties, BotDeskState } from "../../../shared/bot-desk";
import { formatClock } from "../../lib/format";
import { I18nProvider, translate } from "../../lib/i18n";
import { useBotStore } from "../../stores/bot";
import { useBotDeskStore } from "../../stores/bot-desk";
import { useRemoteStore } from "../../stores/remote";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { useToastStore } from "../../stores/toast";
import { BotHome } from "./BotHome";

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

interface Api {
	get: Mock<(device?: string) => Promise<BotDeskState>>;
	answer: Mock<(payload: BotDeskAnswer, device?: string) => Promise<void>>;
	setDuties: Mock<(payload: BotDeskDuties, device?: string) => Promise<void>>;
	onChanged: Mock<(callback: (state: BotDeskState, device?: string) => void) => () => void>;
}

function installApi(overrides: Partial<Api> = {}): Api {
	const api: Api = {
		get: vi.fn(async () => ({ duties: [], decisions: [], wakes: [] })),
		answer: vi.fn(async () => {}),
		setDuties: vi.fn(async () => {}),
		onChanged: vi.fn(() => () => {}),
		...overrides,
	};
	(window as unknown as { omp: unknown }).omp = { sessions: { botDesk: api } };
	return api;
}

function desk(overrides: Partial<BotDeskState> = {}): BotDeskState {
	return { duties: [], decisions: [], wakes: [], ...overrides };
}

const OPEN: BotDecision = {
	id: "d1",
	state: "open",
	question: "Ship the 0.43 release today?",
	options: ["Ship it", "Wait a day"],
	context: "CI is green. One flaky e2e retried twice.",
	at: "2026-10-31T09:00:00.000Z",
};

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

async function click(element: Element | null): Promise<void> {
	await act(async () => props<{ onClick: (event: unknown) => void }>(element).onClick({ preventDefault() {} }));
}

async function type(element: Element | null, value: string): Promise<void> {
	await act(async () => props<{ onChange: (event: unknown) => void }>(element).onChange({ target: { value } }));
}

async function enter(element: Element | null): Promise<void> {
	await act(async () =>
		props<{ onKeyDown: (event: unknown) => void }>(element).onKeyDown({ key: "Enter", preventDefault() {} }),
	);
}

const query = (selector: string) => container.querySelector(selector);
const queryAll = (selector: string) => [...container.querySelectorAll(selector)];

async function mountHome(state: BotDeskState): Promise<void> {
	useBotDeskStore.getState().apply(state);
	await mount(<BotHome tabId="tbot" />);
}

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container.remove();
	useBotDeskStore.getState().reset();
	useBotStore.getState().reset();
	useRemoteStore.getState().reset();
	useSessionStore.getState().reset();
	useTabsStore.setState({ tabs: [], activeTabId: null } as never);
	useToastStore.setState({ toasts: [] } as never);
	delete (window as unknown as { omp?: unknown }).omp;
});

describe("BotHome", () => {
	it("draws a static skeleton, never a spinner, until the first read lands", async () => {
		installApi();
		await mount(<BotHome tabId="tbot" />);

		expect(queryAll("[data-skeleton-row]").length).toBeGreaterThan(0);
		expect(query("[data-bot-decisions]")).toBeNull();
		expect(query('[aria-busy="true"]')).toBeNull();
		expect(query(".omp-spinner")).toBeNull();
	});

	it("shows each open decision with its question, context and one button per option", async () => {
		installApi();
		await mountHome(desk({ decisions: [OPEN] }));

		const card = query('[data-bot-decision="d1"]');
		expect(card?.textContent).toContain(OPEN.question);
		expect(card?.textContent).toContain("One flaky e2e retried twice.");
		expect(queryAll("[data-bot-option]").map(button => button.textContent)).toEqual(["Ship it", "Wait a day"]);
		expect(query("[data-bot-decisions-empty]")).toBeNull();
	});

	it("says so when nothing waits on the owner", async () => {
		installApi();
		await mountHome(desk());
		expect(query("[data-bot-decisions-empty]")?.textContent).toBe(translate("botHome.decisions.empty"));
	});

	it("answers with the chosen option", async () => {
		const api = installApi();
		await mountHome(desk({ decisions: [OPEN] }));

		await click(query('[data-bot-option="Wait a day"]'));

		expect(api.answer).toHaveBeenCalledTimes(1);
		expect(api.answer).toHaveBeenCalledWith({ id: "d1", answer: "Wait a day" });
	});

	it("answers with the owner's own words on Enter and on the send button, trimmed, never empty", async () => {
		const api = installApi();
		await mountHome(desk({ decisions: [{ ...OPEN, id: "d1", options: [] }] }));
		const sendButton = () => query("[data-bot-answer-send]");

		expect(props<{ disabled: boolean }>(sendButton()).disabled).toBe(true);
		await enter(query("[data-bot-answer-input]"));
		expect(api.answer).not.toHaveBeenCalled();

		await type(query("[data-bot-answer-input]"), "  Ship it after lunch  ");
		expect(props<{ disabled: boolean }>(sendButton()).disabled).toBeFalsy();
		await click(sendButton());
		expect(api.answer).toHaveBeenCalledWith({ id: "d1", answer: "Ship it after lunch" });
	});

	it("keeps the card and says so when main refuses the answer", async () => {
		const api = installApi({
			answer: vi.fn(async () => {
				throw new Error("refused");
			}),
		});
		await mountHome(desk({ decisions: [OPEN] }));

		await click(query('[data-bot-option="Ship it"]'));

		expect(api.answer).toHaveBeenCalledTimes(1);
		expect(query('[data-bot-decision="d1"]')).not.toBeNull();
		expect(props<{ disabled: boolean }>(query('[data-bot-option="Ship it"]')).disabled).toBeFalsy();
		expect(useToastStore.getState().toasts.some(entry => entry.title === translate("botHome.answerFailed"))).toBe(
			true,
		);
	});

	it("drops the card when main's change arrives, and folds the answered ones under Past decisions", async () => {
		installApi();
		await mountHome(desk({ decisions: [OPEN] }));

		await act(async () =>
			useBotDeskStore.getState().apply(
				desk({
					decisions: [{ ...OPEN, state: "answered", answer: "Ship it", answeredAt: "2026-10-31T09:05:00.000Z" }],
				}),
			),
		);

		expect(query('[data-bot-decision="d1"]')).toBeNull();
		const past = query("[data-bot-past]");
		expect(past?.textContent).toContain(translate("botHome.decisions.past", { count: 1 }));
		expect(query("[data-bot-answered]")).toBeNull();
		await click(past?.querySelector("button") ?? null);
		expect(query('[data-bot-answered="d1"]')?.textContent).toContain(
			translate("botHome.answered", { answer: "Ship it" }),
		);
	});

	it("renders markdown context as markdown and plain context as text", async () => {
		installApi();
		await mountHome(
			desk({
				decisions: [
					{ ...OPEN, id: "m", context: "**Risk:** the migration is slow" },
					{ ...OPEN, id: "p", context: "Just a plain sentence." },
				],
			}),
		);

		expect(query('[data-bot-decision="m"] strong')?.textContent).toBe("Risk:");
		expect(query('[data-bot-decision="p"] [data-bot-decision-context] p')?.textContent).toBe(
			"Just a plain sentence.",
		);
	});

	it("adds a duty on Enter by writing the whole list with the new one last", async () => {
		const api = installApi();
		await mountHome(
			desk({
				duties: [
					{ id: "a", text: "Check the nightly build", at: "2026-10-30T08:00:00.000Z" },
					{ id: "b", text: "Triage new issues", at: "2026-10-30T08:01:00.000Z" },
				],
			}),
		);

		await type(query("[data-bot-duty-input]"), "  Watch the release branch ");
		await enter(query("[data-bot-duty-input]"));

		expect(api.setDuties).toHaveBeenCalledTimes(1);
		expect(api.setDuties).toHaveBeenCalledWith({
			duties: [
				{ id: "a", text: "Check the nightly build" },
				{ id: "b", text: "Triage new issues" },
				{ text: "Watch the release branch" },
			],
		});
		expect(props<{ value: string }>(query("[data-bot-duty-input]")).value).toBe("");
	});

	it("removes a duty by writing the whole list without it", async () => {
		const api = installApi();
		await mountHome(
			desk({
				duties: [
					{ id: "a", text: "Check the nightly build", at: "2026-10-30T08:00:00.000Z" },
					{ id: "b", text: "Triage new issues", at: "2026-10-30T08:01:00.000Z" },
				],
			}),
		);

		await click(query('[data-bot-duty-remove="a"]'));

		expect(api.setDuties).toHaveBeenCalledWith({ duties: [{ id: "b", text: "Triage new issues" }] });
	});

	it("keeps the typed duty when main refuses it", async () => {
		installApi({
			setDuties: vi.fn(async () => {
				throw new Error("refused");
			}),
		});
		await mountHome(desk());

		await type(query("[data-bot-duty-input]"), "Check the nightly build");
		await enter(query("[data-bot-duty-input]"));

		expect(props<{ value: string }>(query("[data-bot-duty-input]")).value).toBe("Check the nightly build");
		expect(useToastStore.getState().toasts.some(entry => entry.title === translate("botHome.dutiesFailed"))).toBe(
			true,
		);
	});

	it("lists the wakes and puts the earliest one, the name and the computer in the header", async () => {
		installApi();
		useSessionStore.setState({ sessionName: "Jarvis" } as never);
		useRemoteStore.setState({ state: { host: { name: "SeuPut's Mac" } } } as never);
		useTabsStore.setState({
			tabs: [{ id: "tbot", cwd: "/w", status: "ready", kind: "chat", sessionPath: BOT, unreadDone: false }],
			activeTabId: "tbot",
		} as never);
		await mountHome(
			desk({
				wakes: [
					{ id: "w2", prompt: "Look at the open pull requests", next: "2026-11-02T09:00:00.000Z" },
					{ id: "w1", prompt: "Check the nightly build", next: "2026-11-01T06:30:00.000Z" },
					{ id: "w3", prompt: "Paused check", next: null },
				],
			}),
		);

		expect(queryAll("[data-bot-wake]").map(row => row.getAttribute("data-bot-wake"))).toEqual(["w2", "w1", "w3"]);
		expect(query('[data-bot-wake="w3"]')?.textContent).toContain(translate("botHome.wakes.paused"));
		expect(query("[data-bot-name]")?.textContent).toBe("Jarvis");
		expect(query("[data-bot-state]")?.getAttribute("data-bot-state")).toBe("idle");
		expect(query("[data-bot-device]")?.textContent).toBe(translate("botHome.device", { device: "SeuPut's Mac" }));
		// The earliest of the three, not the first listed.
		expect(query("[data-bot-next-wake]")?.textContent).toBe(
			translate("botHome.nextWake", { time: formatClock("2026-11-01T06:30:00.000Z") }),
		);
	});

	it("says it has no wakes, duties or sessions when it has none", async () => {
		installApi();
		await mountHome(desk());

		expect(query("[data-bot-wakes-empty]")).not.toBeNull();
		expect(query("[data-bot-duties-empty]")).not.toBeNull();
		expect(query("[data-bot-sessions-empty]")).not.toBeNull();
		expect(query("[data-bot-next-wake]")?.textContent).toBe(translate("botHome.noWake"));
	});

	it("lists the sessions the bot opened, a tap focusing the child", async () => {
		installApi();
		const applyAgentView = vi.fn(async () => {});
		useTabsStore.setState({
			tabs: [
				{ id: "tbot", cwd: "/w", status: "ready", kind: "chat", sessionPath: BOT, unreadDone: false },
				{
					id: "tkid",
					cwd: "/w/alpha",
					status: "running",
					kind: "agent",
					title: "Check the build",
					sessionPath: "/w/alpha/kid.jsonl",
					openedBy: "tbot",
					openedBySession: BOT,
					unreadDone: false,
				},
			],
			activeTabId: "tbot",
			applyAgentView,
		} as never);
		await mountHome(desk());

		const row = query('[data-bot-session="tkid"]');
		expect(row?.textContent).toContain("Check the build");
		expect(row?.getAttribute("data-status")).toBe("running");
		await click(row);
		expect(applyAgentView).toHaveBeenCalledWith({ tabId: "tkid", how: "focus" });
	});

	it("is a paired host's home: its desk, its name in the header, and answers and duties go to that host", async () => {
		const api = installApi({ get: vi.fn(async () => desk({ decisions: [OPEN] })) });
		useRemoteStore.setState({
			state: { host: { name: "SeuPut's Mac" }, hosts: [{ deviceId: "mini", name: "Mac mini" }] },
		} as never);
		useTabsStore.setState({
			tabs: [
				{
					id: "tmini",
					device: "mini",
					cwd: "/w",
					status: "ready",
					kind: "chat",
					sessionPath: BOT,
					unreadDone: false,
				},
			],
			activeTabId: "tmini",
		} as never);
		// This computer's own desk says nothing is waiting; only the host's has a decision.
		useBotDeskStore.getState().apply(desk());
		useBotDeskStore.getState().apply(desk({ decisions: [OPEN] }), "mini");
		await mount(<BotHome device="mini" tabId="tmini" />);

		expect(queryAll("[data-bot-option]").map(button => button.textContent)).toEqual(["Ship it", "Wait a day"]);
		expect(query("[data-bot-device]")?.textContent).toBe(translate("botHome.device", { device: "Mac mini" }));
		// Only the host's desk is read, never this computer's.
		expect(api.get.mock.calls.every(call => call[0] === "mini")).toBe(true);

		await click(query('[data-bot-option="Ship it"]'));
		expect(api.answer).toHaveBeenCalledWith({ id: "d1", answer: "Ship it" }, "mini");

		await type(query("[data-bot-duty-input]"), "Check the build");
		await enter(query("[data-bot-duty-input]"));
		expect(api.setDuties).toHaveBeenCalledWith({ duties: [{ text: "Check the build" }] }, "mini");
	});

	it("reads a host's desk when its home opens before anything read it", async () => {
		const api = installApi({ get: vi.fn(async () => desk({ decisions: [OPEN] })) });
		await mount(<BotHome device="mini" tabId="tmini" />);

		await vi.waitFor(() => expect(query('[data-bot-decision="d1"]')).not.toBeNull());
		expect(api.get).toHaveBeenCalledWith("mini");
	});
});
