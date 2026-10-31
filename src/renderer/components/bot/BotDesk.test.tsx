/**
 * The bot's parts around its conversation: the bar (name, state, the step it runs, the host's link, Stop now, Pause),
 * the decisions above the composer (operation and inputs, details, an editable draft, expiry; answered with an option
 * or in the owner's own words), and its work board sections: duties (reworded in place, the whole list written on
 * every edit), Tasks (in progress, scheduled, completed; stop, watch, mark done), routines and the Library, a static
 * skeleton before the first read.
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import {
	type BotDecision,
	type BotDeskAnswer,
	type BotDeskDuties,
	type BotDeskState,
	type BotRoutine,
	EMPTY_BOT_DESK,
} from "../../../shared/bot-desk";
import type { BotDeskEdit } from "../../../shared/bot-desk-edit";
import { formatClock } from "../../lib/format";
import { I18nProvider, translate } from "../../lib/i18n";
import { useAgentReviewStore } from "../../stores/agent-review";
import { useBotStore } from "../../stores/bot";
import { useBotDeskStore } from "../../stores/bot-desk";
import { useRemoteStore } from "../../stores/remote";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { useToastStore } from "../../stores/toast";
import { useTodoStore } from "../../stores/todo";
import { useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
import { BotBar, BotBoardSections, BotDecisionDock } from "./BotDesk";

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
	edit: Mock<(edit: BotDeskEdit, device?: string) => Promise<void>>;
	commandForTab: Mock<(tabId: string, command: unknown) => Promise<{ success: boolean }>>;
}

function installApi(overrides: Partial<Api> = {}): Api {
	const api: Api = {
		get: vi.fn(async () => ({ ...EMPTY_BOT_DESK, duties: [], decisions: [], routines: [] })),
		answer: vi.fn(async () => {}),
		setDuties: vi.fn(async () => {}),
		onChanged: vi.fn(() => () => {}),
		edit: vi.fn(async () => {}),
		commandForTab: vi.fn(async () => ({ success: true })),
		...overrides,
	};
	const { commandForTab, ...botDesk } = api;
	(window as unknown as { omp: unknown }).omp = { sessions: { botDesk }, rpc: { commandForTab } };
	return api;
}

function desk(overrides: Partial<BotDeskState> = {}): BotDeskState {
	return { ...EMPTY_BOT_DESK, duties: [], decisions: [], routines: [], ...overrides };
}

function routine(id: string, prompt: string, next: string | null): BotRoutine {
	return {
		id,
		name: id,
		prompt,
		frequency: { kind: "interval", minutes: 30 },
		enabled: true,
		next,
		runs: [],
	};
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

/** The three parts as the bot's pane and its board draw them. */
function Parts({ tabId, device }: { tabId: string; device?: string }) {
	return (
		<>
			<BotBar device={device} tabId={tabId} />
			<BotBoardSections device={device} tabId={tabId} />
			<BotDecisionDock device={device} />
		</>
	);
}

async function mountDesk(state: BotDeskState): Promise<void> {
	useBotDeskStore.getState().apply(state);
	await mount(<Parts tabId="tbot" />);
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
	useUiStore.setState({ dockCollapsed: {}, dockFocus: null });
	useAgentReviewStore.getState().reset();
	useTodoStore.getState().reset();
	useToolsStore.getState().reset();
	delete (window as unknown as { omp?: unknown }).omp;
});

describe("the bot's desk", () => {
	it("draws a static skeleton, never a spinner, until the first read lands", async () => {
		installApi();
		await mount(<Parts tabId="tbot" />);

		expect(queryAll("[data-skeleton-row]").length).toBeGreaterThan(0);
		expect(query("[data-bot-decisions-dock]")).toBeNull();
		expect(query("[data-bot-duty-input]")).toBeNull();
		expect(query('[aria-busy="true"]')).toBeNull();
		expect(query(".omp-spinner")).toBeNull();
	});

	it("says the first read failed above the composer, and reads again on Retry", async () => {
		const api = installApi({
			get: vi.fn(async () => {
				throw new Error("main is busy");
			}),
		});
		await mount(<Parts tabId="tbot" />);
		await act(async () => useBotDeskStore.getState().refresh());

		const dock = query("[data-bot-decisions-dock]");
		expect(dock?.textContent).toContain(translate("botHome.loadFailed"));
		api.get.mockResolvedValue(desk({ decisions: [OPEN] }));
		await click(dock?.querySelector("button") ?? null);
		expect(query('[data-bot-decision="d1"]')).not.toBeNull();
	});

	it("docks each open decision with its question, context and one button per option", async () => {
		installApi();
		await mountDesk(desk({ decisions: [OPEN] }));

		const card = query('[data-bot-decision="d1"]');
		expect(card?.closest("[data-bot-decisions-dock]")).not.toBeNull();
		expect(card?.textContent).toContain(OPEN.question);
		expect(card?.textContent).toContain("One flaky e2e retried twice.");
		expect(queryAll("[data-bot-option]").map(button => button.textContent)).toEqual(["Ship it", "Wait a day"]);
	});

	it("folds to one line naming the first question, and opens again", async () => {
		installApi();
		await mountDesk(desk({ decisions: [OPEN] }));

		await click(query('[data-dock-card="decisions"] button[aria-expanded="true"]'));
		expect(query('[data-bot-decision="d1"]')).toBeNull();
		expect(query('[data-testid="dock-peek-decisions"]')?.textContent).toBe(OPEN.question);

		await act(async () => useUiStore.getState().focusDockCard("decisions"));
		expect(query('[data-bot-decision="d1"]')).not.toBeNull();
	});

	it("docks nothing while nothing waits on the owner", async () => {
		installApi();
		await mountDesk(desk());
		expect(query("[data-bot-decisions-dock]")).toBeNull();
	});

	it("answers with the chosen option", async () => {
		const api = installApi();
		await mountDesk(desk({ decisions: [OPEN] }));

		await click(query('[data-bot-option="Wait a day"]'));

		expect(api.answer).toHaveBeenCalledTimes(1);
		expect(api.answer).toHaveBeenCalledWith({ id: "d1", answer: "Wait a day" });
	});

	it("answers with the owner's own words on Enter and on the send button, trimmed, never empty", async () => {
		const api = installApi();
		await mountDesk(desk({ decisions: [{ ...OPEN, id: "d1", options: [] }] }));
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
		await mountDesk(desk({ decisions: [OPEN] }));

		await click(query('[data-bot-option="Ship it"]'));

		expect(api.answer).toHaveBeenCalledTimes(1);
		expect(query('[data-bot-decision="d1"]')).not.toBeNull();
		expect(props<{ disabled: boolean }>(query('[data-bot-option="Ship it"]')).disabled).toBeFalsy();
		expect(useToastStore.getState().toasts.some(entry => entry.title === translate("botHome.answerFailed"))).toBe(
			true,
		);
	});

	it("drops the card when main's change arrives, and lists the answer under the Tasks' Completed", async () => {
		installApi();
		await mountDesk(desk({ decisions: [OPEN] }));
		expect(query("[data-bot-answered]")).toBeNull();

		await act(async () =>
			useBotDeskStore.getState().apply(
				desk({
					decisions: [{ ...OPEN, state: "answered", answer: "Ship it", answeredAt: "2026-10-31T09:05:00.000Z" }],
				}),
			),
		);

		expect(query('[data-bot-decision="d1"]')).toBeNull();
		expect(query("[data-bot-decisions-dock]")).toBeNull();
		const row = query('[data-bot-answered="d1"]');
		expect(row?.closest('[data-board-section="tasks"]')).not.toBeNull();
		expect(row?.textContent).toContain(OPEN.question);
		expect(row?.textContent).toContain("Ship it");
		expect(row?.getAttribute("title")).toContain(translate("botHome.answered", { answer: "Ship it" }));
	});

	it("renders markdown context as markdown and plain context as text", async () => {
		installApi();
		await mountDesk(
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
		await mountDesk(
			desk({
				duties: [
					{ id: "a", text: "Check the nightly build", at: "2026-10-30T08:00:00.000Z" },
					{ id: "b", text: "Triage new issues", at: "2026-10-30T08:01:00.000Z" },
				],
			}),
		);

		expect(query('[data-bot-duty="a"]')?.closest('[data-board-section="duties"]')).not.toBeNull();
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
		await mountDesk(
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
		await mountDesk(desk());

		await type(query("[data-bot-duty-input]"), "Check the nightly build");
		await enter(query("[data-bot-duty-input]"));

		expect(props<{ value: string }>(query("[data-bot-duty-input]")).value).toBe("Check the nightly build");
		expect(useToastStore.getState().toasts.some(entry => entry.title === translate("botHome.dutiesFailed"))).toBe(
			true,
		);
	});

	it("lists the routines and puts the earliest start, the name and the computer in the bar", async () => {
		installApi();
		useSessionStore.setState({ sessionName: "Jarvis" } as never);
		useRemoteStore.setState({ state: { host: { name: "SeuPut's Mac" } } } as never);
		useTabsStore.setState({
			tabs: [{ id: "tbot", cwd: "/w", status: "ready", kind: "chat", sessionPath: BOT, unreadDone: false }],
			activeTabId: "tbot",
		} as never);
		await mountDesk(
			desk({
				routines: [
					routine("w2", "Look at the open pull requests", "2026-11-02T09:00:00.000Z"),
					routine("w1", "Check the nightly build", "2026-11-01T06:30:00.000Z"),
					{ ...routine("w3", "Paused check", null), enabled: false },
				],
			}),
		);

		expect(queryAll("[data-bot-routine]").map(row => row.getAttribute("data-bot-routine"))).toEqual([
			"w2",
			"w1",
			"w3",
		]);
		expect(query('[data-bot-routine="w3"]')?.textContent).toContain(translate("botHome.routines.off"));
		expect(query("[data-bot-bar] [data-bot-name]")?.textContent).toBe("Jarvis");
		expect(query("[data-bot-state]")?.getAttribute("data-bot-state")).toBe("idle");
		expect(query("[data-bot-device]")?.textContent).toBe(translate("botHome.device", { device: "SeuPut's Mac" }));
		// The earliest of the three, not the first listed.
		expect(query("[data-bot-next-wake]")?.textContent).toBe(
			translate("botHome.nextWake", { time: formatClock("2026-11-01T06:30:00.000Z") }),
		);
	});

	it("says it has nothing in progress or scheduled, no routines and no duties when it has none, and keeps the field to add one", async () => {
		installApi();
		await mountDesk(desk());

		expect(query("[data-bot-task-group]")).toBeNull();
		expect(query("[data-bot-tasks-empty]")?.textContent).toBe(translate("botHome.tasks.noneInProgress"));
		expect(query("[data-bot-wake]")).toBeNull();
		expect(query("[data-bot-routines-empty]")).not.toBeNull();
		expect(query("[data-bot-duty]")).toBeNull();
		expect(query("[data-bot-duty-input]")).not.toBeNull();
		expect(query('[data-board-section="library"]')).toBeNull();
		expect(query("[data-bot-next-wake]")?.textContent).toBe(translate("botHome.noWake"));
	});

	it("is a paired host's desk: its decisions, its name in the bar, and answers and duties go to that host", async () => {
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
		await mount(<Parts device="mini" tabId="tmini" />);

		expect(queryAll("[data-bot-option]").map(button => button.textContent)).toEqual(["Ship it", "Wait a day"]);
		expect(query("[data-bot-device]")?.textContent).toBe(translate("botHome.device", { device: "Mac mini" }));

		await click(query('[data-bot-option="Ship it"]'));
		expect(api.answer).toHaveBeenCalledWith({ id: "d1", answer: "Ship it" }, "mini");

		await type(query("[data-bot-duty-input]"), "Check the build");
		await enter(query("[data-bot-duty-input]"));
		expect(api.setDuties).toHaveBeenCalledWith({ duties: [{ text: "Check the build" }] }, "mini");
	});
});

/** A session the bot opened, as a tab of this window. */
function childTab(id: string, status: "running" | "ready", extra: Record<string, unknown> = {}) {
	return {
		id,
		cwd: "/w/child",
		status,
		kind: "agent",
		title: `Child ${id}`,
		sessionPath: `/s/${id}.jsonl`,
		openedBy: "tbot",
		openedBySession: BOT,
		unreadDone: false,
		...extra,
	};
}

function withChildren(children: ReturnType<typeof childTab>[], applyAgentView = vi.fn(async () => {})) {
	useTabsStore.setState({
		tabs: [
			{ id: "tbot", cwd: "/w", status: "ready", kind: "chat", sessionPath: BOT, unreadDone: false },
			...children,
		],
		activeTabId: "tbot",
		applyAgentView,
	} as never);
	return applyAgentView;
}

describe("the bot's decision cards", () => {
	it("leave the dock when their deadline passes, with nothing else changing", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
		try {
			vi.setSystemTime(Date.parse("2026-11-01T09:00:00.000Z"));
			installApi();
			// Collapsed, the card's header names the first decision still open.
			useUiStore.setState({ dockCollapsed: { decisions: true } });
			await mountDesk(
				desk({
					decisions: [
						{ ...OPEN, id: "soon", question: "Deploy soon?", expiresAt: "2026-11-01T09:02:00.000Z" },
						{ ...OPEN, id: "later", question: "Deploy later?", expiresAt: "2026-11-01T10:00:00.000Z" },
					],
				}),
			);
			const peek = () => query('[data-testid="dock-peek-decisions"]')?.textContent;
			expect(peek()).toBe("Deploy soon?");
			await act(async () => {
				vi.advanceTimersByTime(2 * 60_000 + 100);
			});
			expect(peek()).toBe("Deploy later?");
			expect(query('[data-bot-expired="soon"]')).not.toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("show the exact operation and its inputs, with the bot's notes behind See details", async () => {
		installApi();
		await mountDesk(
			desk({
				decisions: [
					{
						...OPEN,
						operation: "gh release create v0.43.0 --target main",
						inputs: { version: "v0.43.0", branch: "main" },
					},
				],
			}),
		);
		expect(query("[data-bot-decision-operation]")?.textContent).toBe("gh release create v0.43.0 --target main");
		expect(queryAll("[data-bot-decision-inputs] dt").map(node => node.textContent)).toEqual(["version", "branch"]);
		expect(queryAll("[data-bot-decision-inputs] dd").map(node => node.textContent)).toEqual(["v0.43.0", "main"]);
		expect(query("[data-bot-decision-context]")).toBeNull();
		await click(query("[data-bot-decision-details]"));
		expect(query("[data-bot-decision-context]")?.textContent).toContain("One flaky e2e retried twice.");
	});

	it("send the draft as the owner edited it with the answer, and none when it was left as the bot wrote it", async () => {
		const api = installApi();
		await mountDesk(
			desk({
				decisions: [
					{ ...OPEN, id: "e1", draft: "Hi Kim, yes." },
					{ ...OPEN, id: "e2", draft: "Release notes" },
				],
			}),
		);
		const drafts = queryAll("[data-bot-decision-draft]");
		expect(drafts).toHaveLength(2);
		await type(drafts[0] ?? null, "Hi Kim, yes, at 3.");
		await click(query('[data-bot-decision="e1"] [data-bot-option="Ship it"]'));
		await click(query('[data-bot-decision="e2"] [data-bot-option="Ship it"]'));
		expect(api.answer.mock.calls).toEqual([
			[{ id: "e1", answer: "Ship it", draft: "Hi Kim, yes, at 3." }],
			[{ id: "e2", answer: "Ship it" }],
		]);
	});

	it("count down to their expiry; an expired one leaves the dock for Completed, saying Expired", async () => {
		const api = installApi();
		const soon = new Date(Date.now() + 8 * 60_000).toISOString();
		const past = new Date(Date.now() - 60_000).toISOString();
		await mountDesk(
			desk({
				decisions: [
					{ ...OPEN, id: "x1", expiresAt: soon },
					{ ...OPEN, id: "x2", expiresAt: past },
				],
			}),
		);
		const expiry = query('[data-bot-decision="x1"] [data-bot-decision-expiry]');
		expect(expiry?.getAttribute("data-bot-decision-expiry")).toBe("open");
		expect(expiry?.textContent).toMatch(/Expires in 7|Expires in 8/);
		expect(query('[data-bot-decision="x2"]')).toBeNull();
		expect(query('[data-bot-expired="x2"]')?.textContent).toContain(translate("botHome.expired"));
		expect(api.answer).not.toHaveBeenCalled();
	});
});

describe("the bot's bar", () => {
	it("pauses the bot through the desk, says Paused • Tap to resume, and resumes on a tap", async () => {
		const api = installApi();
		await mountDesk(desk());
		await click(query('[data-bot-pause="running"]'));
		expect(api.edit).toHaveBeenLastCalledWith({ op: "paused", paused: true });

		await act(async () => useBotDeskStore.getState().apply(desk({ paused: true })));
		expect(query('[data-bot-status-line="paused"]')?.textContent).toBe(translate("botHome.paused"));
		await click(query("[data-bot-resume]"));
		expect(api.edit).toHaveBeenLastCalledWith({ op: "paused", paused: false });
	});

	it("says the step the bot's turn runs with Stop now, and a paired host's link while it is not online", async () => {
		installApi();
		withChildren([]);
		useTabsStore.setState(state => ({
			tabs: state.tabs.map(tab => (tab.id === "tbot" ? { ...tab, status: "running" } : tab)),
		}));
		useTodoStore.setState({ turnActive: true });
		useToolsStore.setState({
			liveTools: new Map([
				[
					"c1",
					{
						toolName: "bash",
						args: { command: "bun test" },
						intent: "Running the test suite",
						status: "running",
						streamingArgs: "",
						result: null,
						isError: false,
						startTime: Date.now(),
						endTime: null,
					},
				],
			]),
		} as never);
		await mountDesk(desk());
		expect(query('[data-bot-status-line="step"]')?.textContent).toBe("Running the test suite");
		expect(query("[data-bot-stop]")).not.toBeNull();
		await act(async () => root.unmount());
		container.remove();

		useRemoteStore.setState({
			state: { host: { name: "Laptop" }, hosts: [{ deviceId: "mini", name: "Mac mini", state: "connecting" }] },
		} as never);
		useBotDeskStore.getState().apply(desk(), "mini");
		await mount(<Parts device="mini" tabId="tbot" />);
		expect(query('[data-bot-status-line="link"]')?.textContent).toBe(
			translate("botHome.link.connecting", { device: "Mac mini" }),
		);
	});
});

describe("the bot's tasks", () => {
	it("lists running and finished sessions, stops and watches a running one apart, and completes only on the owner's mark", async () => {
		const api = installApi();
		const applyAgentView = withChildren([
			childTab("run", "running"),
			childTab("fin", "ready", { lastRun: { stopReason: "stop" }, unreadDone: true }),
			childTab("fin2", "ready", { lastRun: { stopReason: "stop" } }),
		]);
		await mountDesk(desk({ routines: [routine("w1", "check CI", "2026-11-02T06:30:00.000Z")] }));

		const progress = queryAll("[data-bot-task]").map(row => [
			row.getAttribute("data-bot-task"),
			row.getAttribute("data-task-state"),
		]);
		expect(progress).toEqual([
			["/s/run.jsonl", "running"],
			["/s/fin.jsonl", "review"],
			["/s/fin2.jsonl", "review"],
		]);
		expect(query('[data-bot-task="/s/fin.jsonl"]')?.hasAttribute("data-task-unread")).toBe(true);
		expect(query('[data-bot-wake="w1"]')).not.toBeNull();

		await click(query('[data-bot-task="/s/run.jsonl"] [data-bot-task-stop]'));
		expect(api.commandForTab).toHaveBeenCalledWith("run", { type: "abort", origin: { surface: "bot-activity" } });
		await click(query('[data-bot-task="/s/run.jsonl"] [data-bot-task-watch]'));
		expect(applyAgentView).toHaveBeenCalledWith({ tabId: "run", how: "split-right" });
		await click(query('[data-bot-task="/s/run.jsonl"] .omp-work-board-row-main'));
		expect(applyAgentView).toHaveBeenLastCalledWith({ tabId: "run", how: "focus" });

		await click(query('[data-bot-task="/s/fin.jsonl"] [data-bot-task-mark="done"]'));
		expect(api.edit).toHaveBeenLastCalledWith({ op: "tasks_done", sessions: ["/s/fin.jsonl"], done: true });
		await click(query("[data-bot-task-mark-all]"));
		expect(api.edit).toHaveBeenLastCalledWith({
			op: "tasks_done",
			sessions: ["/s/fin.jsonl", "/s/fin2.jsonl"],
			done: true,
		});

		// Main's change lands: the marked one is Completed, and its mark can be taken back.
		await act(async () => useBotDeskStore.getState().apply(desk({ tasksDone: ["/s/fin.jsonl"] })));
		expect(query('[data-bot-task="/s/fin.jsonl"]')?.getAttribute("data-task-state")).toBe("done");
		await click(query('[data-bot-task="/s/fin.jsonl"] [data-bot-task-mark="reopen"]'));
		expect(api.edit).toHaveBeenLastCalledWith({ op: "tasks_done", sessions: ["/s/fin.jsonl"], done: false });
	});

	it("rewords a duty in place, writing the whole list", async () => {
		const api = installApi();
		await mountDesk(desk({ duties: [{ id: "a", text: "Watch CI", at: "2026-10-30T08:00:00.000Z" }] }));
		await click(query('[data-bot-duty="a"] .omp-work-board-row-main'));
		await type(query('[data-bot-duty-edit="a"]'), "Watch CI every morning");
		await enter(query('[data-bot-duty-edit="a"]'));
		expect(api.setDuties).toHaveBeenCalledWith({ duties: [{ id: "a", text: "Watch CI every morning" }] });
	});
});

describe("the bot's library", () => {
	it("lists what a finished session made and pins an item through the desk", async () => {
		const api = installApi();
		withChildren([childTab("fin", "ready", { lastRun: { stopReason: "stop" } })]);
		useAgentReviewStore.setState({
			byTab: {
				tbot: [
					{
						tabId: "fin",
						sessionPath: "/s/fin.jsonl",
						title: "Child fin",
						state: "needs-review",
						branch: "omp/agent/fin",
						baseBranch: "main",
						commitsAhead: 2,
						files: 3,
						added: 40,
						removed: 2,
						uncommitted: 0,
						answer: "",
						report: { kind: "done", text: "Opened https://github.com/acme/app/pull/12", at: 1_000 },
					},
				],
			},
		});
		await mountDesk(desk());
		const keys = queryAll("[data-bot-library]").map(row => row.getAttribute("data-bot-library"));
		expect(keys).toEqual(["branch:/s/fin.jsonl", "report:/s/fin.jsonl", "https://github.com/acme/app/pull/12"]);
		await click(query('[data-bot-library="https://github.com/acme/app/pull/12"] [data-bot-library-pin]'));
		expect(api.edit).toHaveBeenLastCalledWith({
			op: "library_pin",
			key: "https://github.com/acme/app/pull/12",
			pinned: true,
		});
	});
});
