import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, translate } from "../../lib/i18n";
import { useMessagesStore } from "../../stores/messages";
import { useSessionStore } from "../../stores/session";
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
(
	window as unknown as {
		omp: {
			sessions: typeof sessions;
			events: typeof events;
			rpc: { getSessionStats: typeof getSessionStats; setSessionName: typeof setSessionName };
		};
	}
).omp = { sessions, events, rpc: { getSessionStats, setSessionName } };

let container: TestElement;
let root: Root;

async function mount(): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as globalThis.Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<TitleBar />
			</I18nProvider>,
		);
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
	getSessionStats.mockRestore();
	vi.clearAllMocks();
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
		useUiStore.setState({ panelVisible: false });

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
});
