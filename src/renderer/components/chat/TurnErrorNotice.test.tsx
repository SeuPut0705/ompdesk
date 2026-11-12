import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageReport } from "../../../shared/rpc-types";
import { formatClock } from "../../lib/format";
import { I18nProvider } from "../../lib/i18n";
import { useMessagesStore } from "../../stores/messages";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { TurnErrorNotice } from "./TurnErrorNotice";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

const HOUR = 60 * 60 * 1000;
const LIMIT = "429 usage limit reached for this account";

let container: HTMLElement;
let root: Root | undefined;
let reports: UsageReport[];
const prefs = { get: vi.fn(async () => undefined), set: vi.fn(async () => undefined) };

function report(provider: string, resetAt?: number): UsageReport {
	return { provider, fetchedAt: 0, limits: [], ...(resetAt === undefined ? {} : { resetAt }) };
}

async function mount(timestamp: number, errorMessage = LIMIT): Promise<void> {
	container = document.createElement("div");
	document.body.appendChild(container);
	const mounted = createRoot(container);
	root = mounted;
	await act(async () => {
		mounted.render(
			<I18nProvider>
				<TurnErrorNotice errorMessage={errorMessage} stopReason="error" timestamp={timestamp} />
			</I18nProvider>,
		);
	});
}

async function unmount(): Promise<void> {
	const mounted = root;
	if (!mounted) return;
	await act(async () => mounted.unmount());
	container.remove();
	root = undefined;
}

beforeEach(() => {
	reports = [report("anthropic", Date.now() + 2 * HOUR)];
	Reflect.set(window, "omp", {
		rpc: { getUsage: vi.fn(async () => ({ success: true, data: { reports } })) },
		prefs,
	});
	useModelStore.setState({ model: { provider: "anthropic", id: "claude" } as never });
	useSessionStore.setState({ sessionId: "session-1", status: "ready" });
	useMessagesStore.setState({ messages: [{ role: "assistant", content: [], timestamp: 7 }] as never });
});

afterEach(async () => {
	await unmount();
	useMessagesStore.setState({ messages: [] });
	useSessionStore.setState({ sessionId: null, status: "starting" } as never);
	useModelStore.setState({ model: null });
	vi.clearAllMocks();
});

describe("TurnErrorNotice usage limit", () => {
	it("names the provider's reset when nothing waits for the limit, and offers no booking", async () => {
		const resetAt = reports[0]?.resetAt ?? 0;
		await mount(7);
		expect(container.querySelector("[data-quota-reset]")?.textContent).toContain(formatClock(resetAt));
		expect(container.querySelector("[data-quota-resume]")).toBeNull();
		expect(container.querySelector("[data-scheduled-retry]")).toBeNull();
		expect(prefs.set).not.toHaveBeenCalled();
	});

	it("stays plain on an older turn and while another account still has room", async () => {
		await mount(3);
		expect(container.querySelector("[data-quota-reset]")).toBeNull();
		await unmount();

		reports = [report("anthropic", Date.now() + HOUR), report("anthropic")];
		await mount(7);
		expect(container.querySelector("[data-quota-reset]")).toBeNull();
		expect(container.querySelector("[data-quota-resume]")).toBeNull();
	});
});

describe("TurnErrorNotice after the turn went on", () => {
	it("is a quiet note once a later reply answers the same prompt, and stays a card when a new prompt followed", async () => {
		useMessagesStore.setState({
			messages: [
				{ role: "user", content: "go", timestamp: 1 },
				{ role: "assistant", content: [], stopReason: "error", errorMessage: "Connection error.", timestamp: 2 },
				{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: 3 },
			] as never,
		});
		await mount(2, "Connection error.");
		expect(container.querySelector("[data-turn-retried]")?.textContent).toBe("Can't connect — tried again");
		expect(container.querySelector(".omp-message-error")).toBeNull();
		await unmount();

		useMessagesStore.setState({
			messages: [
				{ role: "user", content: "go", timestamp: 1 },
				{ role: "assistant", content: [], stopReason: "error", errorMessage: "Connection error.", timestamp: 2 },
				{ role: "user", content: "again", timestamp: 4 },
				{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: 5 },
			] as never,
		});
		await mount(2, "Connection error.");
		expect(container.querySelector("[data-turn-retried]")).toBeNull();
		expect(container.querySelector(".omp-message-error")).not.toBeNull();
	});
});

describe("TurnErrorNotice while stock's own retry runs", () => {
	const SOCKET = "The socket connection was closed unexpectedly before the response completed";
	const attempt = (timestamp: number) => ({
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage: SOCKET,
		timestamp,
	});

	afterEach(async () => {
		await act(async () => {
			useSessionStore.setState({ retryInfo: null });
			useMessagesStore.setState({ liveMessages: [] });
		});
	});

	it("is no failure card while the saga retries the latest failure, and the card once stock gives up", async () => {
		// The saga is one run: its failed attempts stay live (uncommitted) until the terminal end.
		useMessagesStore.setState({
			messages: [{ role: "user", content: "go", timestamp: 1 }] as never,
			liveMessages: [attempt(2), attempt(3)] as never,
		});
		useSessionStore.setState({
			retryInfo: { attempt: 2, maxAttempts: 3, delayMs: 8_000, errorMessage: SOCKET, startedAt: Date.now() },
		});
		await mount(3, SOCKET);
		// The status row says "Retrying (2/3)…" with its Stop; a red card with Try again beside it reads as a dead turn.
		expect(container.querySelector(".omp-message-error")).toBeNull();
		expect(container.textContent).toBe("");
		await unmount();
		// The earlier attempt was retried: a quiet note, not a card.
		await mount(2, SOCKET);
		expect(container.querySelector("[data-turn-retried]")).not.toBeNull();
		expect(container.querySelector(".omp-message-error")).toBeNull();
		await unmount();

		await mount(3, SOCKET);
		await act(async () => useSessionStore.setState({ retryInfo: null }));
		expect(container.querySelector(".omp-message-error")).not.toBeNull();
	});
});

describe("TurnErrorNotice scheduled retry", () => {
	const SERVER = "503 Service unavailable";
	const cancelWait = vi.fn(async () => {});
	const prompt = vi.fn(async () => ({ success: true }));

	function arm(patch: { at?: number; attempt?: number; limit?: true } = {}): void {
		useTabsStore.setState({
			activeTabId: "t1",
			tabs: [
				{
					id: "t1",
					cwd: "/w",
					status: "ready",
					kind: "agent",
					unreadDone: false,
					scheduledRetry: { at: Date.now() + 30_000, attempt: 1, ...patch },
				},
			],
		});
	}

	beforeEach(() => {
		Reflect.set(window, "omp", {
			rpc: { getUsage: vi.fn(async () => ({ success: true, data: { reports } })), prompt },
			resume: { cancelWait },
			prefs,
		});
		useMessagesStore.setState({
			messages: [
				{ role: "user", content: "go", timestamp: 1 },
				{ role: "assistant", content: [], stopReason: "error", errorMessage: SERVER, timestamp: 2 },
			] as never,
		});
	});

	afterEach(async () => {
		await unmount();
		vi.unstubAllGlobals();
		useTabsStore.setState({ activeTabId: null, tabs: [] });
	});

	it.each([
		["en", "Retrying in 0:30…", "Attempt 1", "Retry now", "Cancel"],
		["ko", "0:30 뒤에 다시 시도해요…", "1번째", "지금 다시 시도", "취소"],
	])(
		"counts down on the latest failed turn in %s, with Cancel and Retry now instead of Try again",
		async (lang, countdown, attempt, now, cancel) => {
			vi.stubGlobal("localStorage", { getItem: () => lang, setItem: vi.fn() });
			arm();
			await mount(2, SERVER);
			const line = container.querySelector("[data-scheduled-retry]");
			expect(line?.textContent).toContain(countdown);
			expect(line?.textContent).toContain(attempt);
			expect(line?.classList.contains("tabular-nums")).toBe(true);
			const labels = [...container.querySelectorAll("button")].map(button => button.textContent);
			expect(labels).toContain(now);
			expect(labels).toContain(cancel);
			// The card's own "Try again" gives way to Retry now.
			expect(labels).not.toContain(lang === "en" ? "Try again" : "다시 시도");
			// The failure itself stays on the card.
			expect(container.querySelector(".omp-message-error")).not.toBeNull();
		},
	);

	it("shows minutes and seconds of the longer waits, and counts on past the third attempt without ever saying it gave up", async () => {
		arm({ at: Date.now() + 600_000, attempt: 3 });
		await mount(2, SERVER);
		expect(container.querySelector("[data-scheduled-retry]")?.textContent).toContain("Retrying in 10:00…");
		expect(container.querySelector("[data-scheduled-retry]")?.textContent).toContain("Attempt 3");
		await unmount();

		arm({ at: Date.now() + 600_000, attempt: 12 });
		await mount(2, SERVER);
		const line = container.querySelector("[data-scheduled-retry]")?.textContent;
		expect(line).toContain("Retrying in 10:00…");
		expect(line).toContain("Attempt 12");
		expect(line).not.toMatch(/\bof\b/);
	});

	it.each([
		["en", "Tries again by itself at", "Retry now", "Cancel"],
		["ko", "에 스스로 다시 시도해요", "지금 다시 시도", "취소"],
	])(
		"says when main tries a turn a provider's limit stopped again in %s, with Retry now and Cancel, and offers no booking",
		async (lang, sentence, now, cancel) => {
			vi.stubGlobal("localStorage", { getItem: () => lang, setItem: vi.fn() });
			const at = Date.now() + 88.5 * HOUR;
			arm({ at, limit: true });
			await mount(2, LIMIT);
			const line = container.querySelector("[data-limit-wait]");
			expect(line?.textContent).toContain(sentence);
			expect(line?.textContent).toContain(formatClock(at));
			// A wait of days reads in days and hours, never as thousands of minutes.
			expect(line?.textContent).toContain(lang === "en" ? "3d 16h" : "3일 16시간");
			const labels = [...container.querySelectorAll("button")].map(button => button.textContent);
			expect(labels).toContain(now);
			expect(labels).toContain(cancel);
			expect(container.querySelector("[data-quota-resume]")).toBeNull();
			// The wait is main's: the card neither names a second time nor asks the provider's usage for one.
			expect(container.querySelector("[data-quota-reset]")).toBeNull();
			expect(window.omp.rpc.getUsage).not.toHaveBeenCalled();

			await act(async () => container.querySelector<HTMLButtonElement>("[data-scheduled-retry-cancel]")?.click());
			expect(cancelWait).toHaveBeenCalledWith("t1");
		},
	);

	it("Cancel asks main to call the retry off", async () => {
		arm();
		await mount(2, SERVER);
		const cancel = container.querySelector<HTMLButtonElement>("[data-scheduled-retry-cancel]");
		await act(async () => cancel?.click());
		expect(cancelWait).toHaveBeenCalledWith("t1");
	});

	it("Retry now sends the last prompt again (main sees a new run and drops its schedule)", async () => {
		arm();
		await mount(2, SERVER);
		await act(async () => container.querySelector<HTMLButtonElement>("[data-scheduled-retry-now]")?.click());
		expect(prompt).toHaveBeenCalledWith("go");
	});

	it("shows nothing about a retry on an older failure, without a schedule, or for a failure no retry fits", async () => {
		arm();
		useMessagesStore.setState({
			messages: [
				{ role: "user", content: "go", timestamp: 1 },
				{ role: "assistant", content: [], stopReason: "error", errorMessage: SERVER, timestamp: 2 },
				{ role: "user", content: "again", timestamp: 3 },
			] as never,
		});
		await mount(2, SERVER);
		expect(container.querySelector("[data-scheduled-retry]")).toBeNull();
		expect(container.textContent).toContain("Try again");
		await unmount();

		useMessagesStore.setState({
			messages: [
				{ role: "user", content: "go", timestamp: 1 },
				{ role: "assistant", content: [], stopReason: "error", errorMessage: SERVER, timestamp: 2 },
			] as never,
		});
		useTabsStore.setState({
			activeTabId: "t1",
			tabs: [{ id: "t1", cwd: "/w", status: "ready", kind: "agent", unreadDone: false }],
		});
		await mount(2, SERVER);
		expect(container.querySelector("[data-scheduled-retry]")).toBeNull();
		expect(container.textContent).toContain("Try again");
	});
});
