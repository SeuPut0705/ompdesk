import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageReport } from "../../../shared/rpc-types";
import { formatClock } from "../../lib/format";
import { I18nProvider } from "../../lib/i18n";
import { useMessagesStore } from "../../stores/messages";
import { useModelStore } from "../../stores/model";
import { quotaResetAt, useQuotaResumeStore } from "../../stores/quota-resume";
import { useSessionStore } from "../../stores/session";
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
	useSessionStore.setState({ sessionId: "session-1" });
	useMessagesStore.setState({ messages: [{ role: "assistant", content: [], timestamp: 7 }] as never });
});

afterEach(async () => {
	await unmount();
	useQuotaResumeStore.getState().reset();
	useMessagesStore.setState({ messages: [] });
	useSessionStore.setState({ sessionId: null } as never);
	useModelStore.setState({ model: null });
	vi.clearAllMocks();
});

describe("quotaResetAt", () => {
	it("is the first of the provider's accounts to reset, once every account is limited", () => {
		const now = 1_000;
		expect(quotaResetAt([report("anthropic", 9_000), report("anthropic", 5_000)], "anthropic", now)).toBe(5_000);
		expect(quotaResetAt([report("anthropic", 9_000), report("anthropic")], "anthropic", now)).toBeUndefined();
		expect(quotaResetAt([report("openai", 9_000)], "anthropic", now)).toBeUndefined();
		expect(quotaResetAt([report("anthropic", 500)], "anthropic", now)).toBeUndefined();
	});
});

describe("TurnErrorNotice usage limit", () => {
	it("names the reset and books the turn to resume then; cancel drops the booking", async () => {
		const resetAt = reports[0]?.resetAt ?? 0;
		await mount(7);
		expect(container.querySelector("[data-quota-reset]")?.textContent).toContain(formatClock(resetAt));
		const book = container.querySelector<HTMLButtonElement>('[data-quota-resume="offer"]');
		expect(book?.textContent).toBe(`Resume at ${formatClock(resetAt)}`);

		await act(async () => book?.click());
		expect(useQuotaResumeStore.getState().reservations).toEqual({ "session-1": resetAt });
		expect(prefs.set).toHaveBeenLastCalledWith("quotaResume", { "session-1": resetAt });
		expect(container.querySelector("[data-quota-reset]")?.textContent).toContain("Resumes on its own");

		await act(async () => container.querySelector<HTMLButtonElement>('[data-quota-resume="booked"]')?.click());
		expect(useQuotaResumeStore.getState().reservations).toEqual({});
		expect(prefs.set).toHaveBeenLastCalledWith("quotaResume", undefined);
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
