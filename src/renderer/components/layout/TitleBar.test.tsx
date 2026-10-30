import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteState } from "../../../shared/ipc-types";
import type { RpcResponse } from "../../../shared/rpc-types";
import { formatTimeAgo } from "../../lib/format";
import { I18nProvider, translate } from "../../lib/i18n";
import type { ExtensionUiStore } from "../../stores/extension-ui";
import { useMessagesStore } from "../../stores/messages";
import { useRemoteStore } from "../../stores/remote";
import { type SessionStore, useSessionStore } from "../../stores/session";
import {
	deleteSessionRuntime,
	SessionRuntimeProvider,
	sessionRuntimeStore,
} from "../../stores/session-runtime-context";
import { ensureTabRuntime } from "../../stores/tab-runtime";
import { useTabsStore } from "../../stores/tabs";
import { useToastStore } from "../../stores/toast";
import { useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
import { TitleBar } from "./TitleBar";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(window as unknown as Record<string, number>, { innerHeight: 768, innerWidth: 1024 });
Object.assign(globalThis, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });

interface TestButton {
	title: string;
	click: () => void;
}

interface TestElement {
	textContent: string | null;
	remove: () => void;
	querySelectorAll: (selector: string) => TestButton[];
}

const sessions = {
	list: vi.fn(async () => []),
	// The feed's read, answered by `list` (a test sets that).
	listShared: async () => ({ version: "test.1", sessions: await sessions.list() }),
	delete: vi.fn(async () => {}),
	rename: vi.fn(async () => {}),
};
const events = {
	onSessionsChanged: vi.fn(() => () => {}),
};
const getSessionStats = vi.fn(async () => ({
	type: "response" as const,
	command: "get_session_stats",
	success: true as const,
	data: {
		sessionId: "session-1",
		userMessages: 1,
		assistantMessages: 1,
		toolCalls: 1,
		toolResults: 1,
		totalMessages: 3,
		tokens: { input: 100, output: 1_100, reasoning: 0, cacheRead: 200, cacheWrite: 100, total: 1_500 },
		premiumRequests: 0,
		cost: 0.1234,
	},
}));
const setSessionName = vi.fn(async (_name: string) => ({
	type: "response" as const,
	command: "set_session_name",
	success: true as const,
}));
const regenerateSessionTitle = vi.fn(
	async (): Promise<RpcResponse> => ({
		type: "response",
		command: "regenerate_session_title",
		success: true,
		data: { title: "Generated" },
	}),
);
(
	window as unknown as {
		omp: {
			sessions: typeof sessions;
			events: typeof events;
			rpc: {
				getSessionStats: typeof getSessionStats;
				setSessionName: typeof setSessionName;
				regenerateSessionTitle: typeof regenerateSessionTitle;
			};
		};
	}
).omp = { sessions, events, rpc: { getSessionStats, setSessionName, regenerateSessionTitle } };

let container: TestElement;
let root: Root;

async function mount(tabId?: string): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as globalThis.Element);
	const bar = tabId ? (
		<SessionRuntimeProvider runtime={ensureTabRuntime(tabId)}>
			<TitleBar />
		</SessionRuntimeProvider>
	) : (
		<TitleBar />
	);
	await act(async () => {
		root.render(<I18nProvider>{bar}</I18nProvider>);
	});
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	useSessionStore.getState().reset();
	useMessagesStore.getState().reset();
	useToolsStore.getState().reset();
	useUiStore.getState().closeSessionOverlays();
	useTabsStore.getState().reset();
	useRemoteStore.getState().reset();
	getSessionStats.mockRestore();
	vi.clearAllMocks();
	sessions.list.mockResolvedValue([]);
});

describe("TitleBar", () => {
	it("shows authoritative session usage and merged execution wall time", async () => {
		useSessionStore.setState({ status: "ready", sessionId: "session-1", cwd: "/tmp/project" });
		useMessagesStore.setState({
			messages: [{ role: "assistant", timestamp: 1_000, duration: 2_000 }],
		});
		useToolsStore.setState({
			finishedTools: new Map([
				[
					"tool-1",
					{
						toolName: "read",
						args: {},
						status: "done",
						streamingArgs: "",
						result: null,
						isError: false,
						startTime: 3_000,
						endTime: 6_000,
					},
				],
			]),
		});
		await mount();
		await act(async () => Promise.resolve());

		// The bar shows a status in words and one compact cost figure; the rest
		// lives in the Session status popover.
		expect(container.textContent).toContain("Ready");
		expect(container.textContent).toContain("$0.12");
		expect(container.textContent).not.toContain("1.5k");
		const trigger = (container.querySelectorAll("button") as unknown as TestButton[]).find(button =>
			(button as unknown as Element).getAttribute("aria-label")?.startsWith("Session status"),
		);
		expect(trigger).toBeDefined();
		await act(async () => trigger?.click());
		const popover = document.querySelector('[role="dialog"][aria-label="Session status"]');
		expect(popover?.textContent).toContain("1.5k");
		expect(popover?.textContent).toContain("$0.1234");
		expect(popover?.textContent).toContain("50%");
		expect(popover?.textContent).toContain("5.0s");
		const insights = Array.from(popover?.querySelectorAll("button") ?? []).find(button =>
			button.textContent?.includes("Open in Stats"),
		) as unknown as TestButton | undefined;
		await act(async () => insights?.click());
		expect(useUiStore.getState()).toMatchObject({
			destination: "insights",
			insightsTab: "stats",
			insightsStatsScope: "session",
		});
		expect(getSessionStats).toHaveBeenCalledTimes(1);
		useUiStore.getState().closeDestination();
	});

	it("picks up spend that landed without a transcript entry", async () => {
		let reads = 0;
		getSessionStats.mockImplementation(async () => ({
			type: "response" as const,
			command: "get_session_stats" as const,
			success: true as const,
			data: {
				sessionId: "session-1",
				userMessages: 1,
				assistantMessages: 1,
				toolCalls: 1,
				toolResults: 1,
				totalMessages: 3,
				tokens: { input: 100, output: 1_100, reasoning: 0, cacheRead: 200, cacheWrite: 100, total: 1_500 },
				premiumRequests: 0,
				cost: reads++ === 0 ? 0.1 : 0.25,
			},
		}));
		// Mid-run: the transcript stops growing while subagents keep billing, so
		// only the snapshot pulse can move the figure.
		useSessionStore.setState({
			status: "ready",
			sessionId: "session-1",
			cwd: "/tmp/project",
			isStreaming: true,
		});
		await mount();
		await act(async () => Promise.resolve());
		expect(container.textContent).toContain("$0.1");

		await act(async () => {
			useSessionStore.setState(state => ({ statsPulse: state.statsPulse + 1 }));
		});
		await act(async () => Promise.resolve());
		expect(container.textContent).toContain("$0.25");
		expect(getSessionStats).toHaveBeenCalledTimes(2);
	});

	it("keeps a zero spend out of the bar but in the trigger's name", async () => {
		getSessionStats.mockImplementation(async () => ({
			type: "response" as const,
			command: "get_session_stats" as const,
			success: true as const,
			data: {
				sessionId: "session-1",
				userMessages: 0,
				assistantMessages: 0,
				toolCalls: 0,
				toolResults: 0,
				totalMessages: 0,
				tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				premiumRequests: 0,
				cost: 0,
			},
		}));
		useSessionStore.setState({ status: "ready", sessionId: "session-1", cwd: "/tmp/project" });
		await mount();
		await act(async () => Promise.resolve());

		expect(container.textContent).not.toContain("$0.00");
		const trigger = (container.querySelectorAll("button") as unknown as TestButton[]).find(button =>
			(button as unknown as Element).getAttribute("aria-label")?.startsWith("Session status"),
		);
		expect((trigger as unknown as Element | undefined)?.getAttribute("aria-label")).toBe(
			"Session status, cost $0.00",
		);
	});

	it("names an untitled session by its first prompt, as the sidebar row does", async () => {
		sessions.list.mockResolvedValue([
			{
				path: "/tmp/project/s.jsonl",
				id: "session-1",
				title: null,
				cwd: "/tmp/project",
				created: "2026-01-01T00:00:00Z",
				modified: "2026-01-01T00:00:00Z",
				messageCount: 3,
				size: 10,
				status: "complete",
				firstMessage: "Build the Tally app",
			},
		] as never);
		useSessionStore.setState({ status: "ready", sessionId: "session-1", cwd: "/tmp/project", sessionName: null });
		await mount();
		await act(async () => new Promise<void>(resolve => setTimeout(resolve, 0)));
		const name = document.querySelector("[data-titlebar-session-name]");
		expect(name?.textContent).toContain("Build the Tally app");
		// The session's name is the window's level-one heading (axe page-has-heading-one).
		expect(document.querySelector("h1[data-titlebar-heading]")?.textContent).toBe("Build the Tally app");
		expect(container.textContent).not.toContain(translate("sidebar.newSession"));
	});

	it("says where a forked session came from, so it never reads as a second copy of the original", async () => {
		const row = {
			cwd: "/tmp/project",
			created: "2026-01-01T00:00:00Z",
			modified: "2026-01-01T00:00:00Z",
			messageCount: 3,
			size: 10,
			status: "complete",
			firstMessage: "hello",
		};
		sessions.list.mockResolvedValue([
			{ ...row, path: "/tmp/project/parent.jsonl", id: "parent", title: "Recommended prompts" },
			{
				...row,
				path: "/tmp/project/fork.jsonl",
				id: "session-1",
				title: "Recommended prompts",
				parentSessionPath: "/tmp/project/parent.jsonl",
			},
		] as never);
		useSessionStore.setState({ status: "ready", sessionId: "session-1", cwd: "/tmp/project", sessionName: null });
		await mount();
		await act(async () => new Promise<void>(resolve => setTimeout(resolve, 0)));
		const origin = document.querySelector("[data-titlebar-fork]");
		expect(origin?.textContent).toContain(translate("session.fork.from", { name: "Recommended prompts" }));
		expect(origin?.querySelector("svg")).not.toBeNull();
		expect(origin?.getAttribute("aria-label")).toBe(
			translate("session.fork.tooltip", { name: "Recommended prompts", time: formatTimeAgo(row.created) }),
		);

		// The original itself carries no such mark.
		await act(async () => useSessionStore.setState({ sessionId: "parent" }));
		expect(document.querySelector("[data-titlebar-fork]")).toBeNull();
	});

	it("claims the Escape that cancels a rename, so the same keystroke cannot abort the turn", async () => {
		useSessionStore.setState({
			status: "ready",
			sessionId: "session-1",
			cwd: "/tmp/project",
			sessionName: "demo-run",
		});
		await mount();
		await act(async () => Promise.resolve());

		const rename = (container.querySelectorAll("button") as unknown as TestButton[]).find(b =>
			(b as unknown as Element).hasAttribute("data-titlebar-session-name"),
		);
		expect(rename).toBeDefined();
		// linkedom ships no HTMLInputElement.select(); the field autofocuses through it.
		const proto = HTMLElement.prototype as unknown as { select: () => void };
		proto.select = () => {};
		try {
			await act(async () => rename?.click());
			const input = document.querySelector("input") as unknown as { dispatchEvent: (event: Event) => boolean };
			expect(input).toBeTruthy();

			const escapeKey = new Event("keydown", { bubbles: true, cancelable: true });
			Object.defineProperty(escapeKey, "key", { value: "Escape" });
			// App.tsx aborts the active turn on any Escape nobody prevented.
			let claimed = true;
			await act(async () => {
				claimed = !input.dispatchEvent(escapeKey);
			});
			expect(claimed).toBe(true);
			expect(container.textContent).toContain("demo-run");
		} finally {
			delete (HTMLElement.prototype as unknown as { select?: () => void }).select;
		}
	});

	it("renames a session while it is running and shows the new title at once", async () => {
		useSessionStore.setState({
			status: "ready",
			sessionId: "session-1",
			cwd: "/tmp/project",
			sessionName: "demo-run",
			isStreaming: true,
		});
		await mount();
		await act(async () => Promise.resolve());

		// A linkedom node standing in for the button: only click() is used.
		const rename = document.querySelector("[data-titlebar-session-name]") as unknown as TestButton | null;
		if (!rename) throw new Error("title rename button missing while running");
		// linkedom ships no HTMLInputElement.select(); the field autofocuses through it.
		const proto = HTMLElement.prototype as unknown as { select: () => void };
		proto.select = () => {};
		try {
			await act(async () => rename.click());
			// Handlers close over the draft, so read them fresh after every render.
			const inputHandler = (name: "onChange" | "onKeyDown"): ((event: unknown) => void) => {
				const input = document.querySelector("input");
				if (!input) throw new Error("rename input missing while running");
				const propsKey = Object.getOwnPropertyNames(input).find(key => key.startsWith("__reactProps$"));
				const props: unknown = propsKey ? Reflect.get(input, propsKey) : undefined;
				const handler = props && typeof props === "object" && name in props ? Reflect.get(props, name) : undefined;
				if (typeof handler !== "function") throw new Error(`rename input ${name} missing`);
				return handler;
			};
			await act(async () => inputHandler("onChange")({ target: { value: "Mid-run title" } }));
			await act(async () => inputHandler("onKeyDown")({ key: "Enter", nativeEvent: { isComposing: false } }));
			await act(async () => Promise.resolve());

			expect(setSessionName).toHaveBeenCalledWith("Mid-run title");
			expect(useSessionStore.getState().sessionName).toBe("Mid-run title");
			expect(container.textContent).toContain("Mid-run title");
		} finally {
			Reflect.deleteProperty(HTMLElement.prototype, "select");
		}
	});

	describe("auto button in the rename field", () => {
		const reply = (data: unknown): RpcResponse => ({
			type: "response",
			command: "regenerate_session_title",
			success: true,
			data,
		});
		const startRename = async () => {
			useSessionStore.setState({
				status: "ready",
				sessionId: "session-1",
				cwd: "/tmp/project",
				sessionName: "My own name",
			});
			await mount();
			await act(async () => Promise.resolve());
			const rename = document.querySelector("[data-titlebar-session-name]") as unknown as TestButton | null;
			if (!rename) throw new Error("title rename button missing");
			await act(async () => rename.click());
			const auto = document.querySelector("[data-auto-title]") as unknown as Element | null;
			if (!auto) throw new Error("auto button missing in the rename field");
			return auto;
		};

		it("is named in the UI language, keeps the field focused when pressed, and asks the tab's omp once", async () => {
			// linkedom ships no HTMLInputElement.select(); the field autofocuses through it.
			(HTMLElement.prototype as unknown as { select: () => void }).select = () => {};
			try {
				regenerateSessionTitle.mockResolvedValueOnce(reply({ title: "🐛 Fix login bug" }));
				const auto = await startRename();
				expect(auto.getAttribute("aria-label")).toBe(translate("titleAuto.label"));
				// Pressing it must not blur the field: blur saves the draft as the person's own name.
				const press = new Event("mousedown", { bubbles: true, cancelable: true });
				auto.dispatchEvent(press);
				expect(press.defaultPrevented).toBe(true);
				await act(async () => (auto as unknown as TestButton).click());
				expect(regenerateSessionTitle).toHaveBeenCalledTimes(1);
			} finally {
				Reflect.deleteProperty(HTMLElement.prototype, "select");
			}
		});

		it("shows it is working, then fills in the saved title and closes the editor without renaming over it", async () => {
			(HTMLElement.prototype as unknown as { select: () => void }).select = () => {};
			try {
				const pending = Promise.withResolvers<RpcResponse>();
				regenerateSessionTitle.mockReturnValueOnce(pending.promise);
				const auto = await startRename();
				await act(async () => (auto as unknown as TestButton).click());
				expect(document.querySelector("[data-auto-title]")?.getAttribute("aria-busy")).toBe("true");
				await act(async () => pending.resolve(reply({ title: "🐛 Fix login bug" })));
				expect(document.querySelector("input")).toBeNull();
				expect(useSessionStore.getState().sessionName).toBe("🐛 Fix login bug");
				expect(container.textContent).toContain("🐛 Fix login bug");
				// The omp saved it: the editor never sends the old draft as a typed name.
				expect(setSessionName).not.toHaveBeenCalled();
			} finally {
				Reflect.deleteProperty(HTMLElement.prototype, "select");
			}
		});

		const failed: RpcResponse = {
			type: "response",
			command: "regenerate_session_title",
			success: false,
			error: "title model unavailable",
		};
		it.each([
			["nothing to name yet", reply({ title: null, reason: "none" }), "titleAuto.none"],
			["a newer rename won", reply({ title: null, reason: "superseded" }), "titleAuto.superseded"],
			["the title model failed", failed, "titleAuto.failed"],
		] as const)(
			"says why in one inline sentence when %s, never a toast, and leaves the editor open",
			async (_when, answer, key) => {
				(HTMLElement.prototype as unknown as { select: () => void }).select = () => {};
				try {
					regenerateSessionTitle.mockResolvedValueOnce(answer);
					const auto = await startRename();
					await act(async () => (auto as unknown as TestButton).click());
					const alert = document.querySelector("[data-auto-title-error]");
					expect(alert?.getAttribute("role")).toBe("alert");
					expect(alert?.textContent).toBe(translate(key));
					expect(document.querySelector("input")).not.toBeNull();
					expect(useToastStore.getState().toasts).toEqual([]);
					expect(useSessionStore.getState().sessionName).toBe("My own name");
				} finally {
					Reflect.deleteProperty(HTMLElement.prototype, "select");
				}
			},
		);
	});

	it("opens session actions and the side panel from visible toolbar buttons", async () => {
		useSessionStore.setState({ status: "ready", sessionId: "session-1", cwd: "/tmp/project" });
		await mount();

		const named = (label: string) =>
			(container.querySelectorAll("button") as unknown as TestButton[]).find(
				button => (button as unknown as Element).getAttribute("aria-label") === label,
			);
		const panel = named("Side panel");
		expect(panel).toBeDefined();
		await act(async () => panel?.click());
		expect(useUiStore.getState().panelVisible).toBe(true);
		await act(async () => useUiStore.setState({ panelVisible: false }));

		const actions = named("Session actions");
		expect(actions).toBeDefined();
		await act(async () => actions?.click());
		const importItem = Array.from(document.querySelectorAll("[data-menu-item]")).find(item =>
			item.textContent?.includes(translate("cmd.import")),
		) as unknown as TestButton | undefined;
		expect(importItem).toBeDefined();
		await act(async () => importItem?.click());
		expect(useUiStore.getState().importDialogOpen).toBe(true);
	});

	it("names what a blocked session waits for, and a removed host as no longer paired", async () => {
		useTabsStore.setState({
			tabs: [{ id: "t1", cwd: "/tmp/project", status: "ready", kind: "agent", device: "host-b", unreadDone: false }],
			activeTabId: "t1",
		});
		useRemoteStore.setState({
			state: { hosts: [{ deviceId: "host-b", name: "Studio", state: "online" }] } as unknown as RemoteState,
		});
		await mount("t1");
		const extensionUi = sessionRuntimeStore<ExtensionUiStore>("t1", "extensionUi");
		await act(async () => {
			sessionRuntimeStore<SessionStore>("t1", "session")?.setState({ status: "ready" });
			extensionUi?.getState().pushRequest({
				type: "extension_ui_request",
				id: "ask",
				method: "ask",
				questions: [],
			});
		});
		// A question is not an approval.
		expect(container.textContent).toContain(translate("attention.question"));
		expect(container.textContent).not.toContain(translate("attention.approval"));
		await act(async () => {
			extensionUi?.getState().removeRequest("ask");
			extensionUi?.getState().pushRequest({
				type: "extension_ui_request",
				id: "approval",
				method: "select",
				title: "Allow tool: bash\nls",
				options: ["Approve", "Deny"],
			});
		});
		expect(container.textContent).toContain(translate("attention.approval"));

		// Unpaired in Settings: the host is gone for good, not reconnecting.
		await act(async () => {
			useRemoteStore.setState({ state: { hosts: [] } as unknown as RemoteState });
		});
		expect(container.textContent).toContain(translate("remote.tab.statusRemoved"));
		expect(container.textContent).not.toContain(translate("remote.tab.statusReconnecting"));
		deleteSessionRuntime("t1");
	});

	it("says a waiting child on an idle session, as a question is said", async () => {
		useTabsStore.setState({
			tabs: [
				{ id: "t1", cwd: "/tmp/project", status: "ready", kind: "agent", unreadDone: false },
				{
					id: "c1",
					cwd: "/tmp/project",
					status: "running",
					kind: "agent",
					unreadDone: false,
					openedBy: "t1",
					awaitingInput: "input",
				},
			],
			activeTabId: "t1",
		});
		await mount("t1");
		await act(async () => sessionRuntimeStore<SessionStore>("t1", "session")?.setState({ status: "ready" }));
		expect(container.textContent).toContain(translate("attention.childWaiting"));
		expect(container.textContent).not.toContain(translate("titlebar.status.ready"));
		// A phone's bar hides the word: the status keeps it as its accessible name and tooltip.
		const status = document.querySelector(".omp-titlebar-status");
		expect(status?.getAttribute("aria-label")).toBe(translate("attention.childWaiting"));
		expect(status?.getAttribute("title")).toBe(translate("attention.childWaiting"));
		await act(async () => {
			useTabsStore.setState(state => ({
				tabs: state.tabs.map(tab => (tab.id === "c1" ? { ...tab, awaitingInput: undefined } : tab)),
			}));
		});
		expect(container.textContent).not.toContain(translate("attention.childWaiting"));
		deleteSessionRuntime("t1");
	});

	it("says a session that is down over what it needs from the person", async () => {
		useTabsStore.setState({
			tabs: [{ id: "t1", cwd: "/tmp/project", status: "ready", kind: "agent", unreadDone: false }],
			activeTabId: "t1",
		});
		await mount("t1");
		const session = sessionRuntimeStore<SessionStore>("t1", "session");
		await act(async () => {
			session?.setState({ status: "ready" });
			sessionRuntimeStore<ExtensionUiStore>("t1", "extensionUi")
				?.getState()
				.pushRequest({ type: "extension_ui_request", id: "ask", method: "ask", questions: [] });
		});
		expect(container.textContent).toContain(translate("attention.question"));
		for (const status of ["error", "exited", "restarting", "starting"] as const) {
			await act(async () => session?.setState({ status }));
			expect(container.textContent, status).not.toContain(translate("attention.question"));
		}
		expect(container.textContent).toContain(translate("titlebar.status.connecting"));
		deleteSessionRuntime("t1");
	});

	it("shows a session another omp still holds as a wait, not an error", async () => {
		useTabsStore.setState({
			tabs: [{ id: "t1", cwd: "/tmp/project", status: "error", kind: "agent", unreadDone: false }],
			activeTabId: "t1",
		});
		await mount("t1");
		const session = sessionRuntimeStore<SessionStore>("t1", "session");
		await act(async () => {
			session?.getState().setStatus("error", "/tmp/project");
			session?.getState().setSidecarError("still open in another omp", null, true);
		});
		expect(container.textContent).toContain(translate("titlebar.status.sessionHeld"));
		expect(container.textContent).not.toContain(translate("titlebar.status.error"));
		await act(async () => session?.getState().setSidecarError("crashed", null, false));
		expect(container.textContent).toContain(translate("titlebar.status.error"));
		deleteSessionRuntime("t1");
	});
});
