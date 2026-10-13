/**
 * Insights page: the explicit stats scope (This session vs All sessions)
 * driven by the ui store, the session figures from get_session_stats, the
 * disconnected empty state, and the Usage tab's no-quota state.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { SessionStats } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { useUiStore } from "../../stores/ui";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
	// lib/chart reads theme tokens while rendering; linkedom has no computed styles.
	getComputedStyle: () => ({ getPropertyValue: () => "" }),
});
Object.assign(window, { setTimeout, clearTimeout, setInterval, clearInterval });

// Deferred until after the globals above: react-dom computes DOM support
// flags at evaluation time.
const { createRoot } = await import("react-dom/client");
const { InsightsPage } = await import("./InsightsPage");

const stats: SessionStats = {
	sessionId: "0199aa00-1111-7000-8000-000000000000",
	userMessages: 3,
	assistantMessages: 4,
	toolCalls: 9,
	toolResults: 9,
	totalMessages: 16,
	tokens: { input: 12_000, output: 3_400, reasoning: 800, cacheRead: 40_000, cacheWrite: 2_000, total: 58_200 },
	premiumRequests: 2,
	cost: 0.0635,
	routedModels: { "acme/acme-opus-5": 4 },
};

interface RpcMock {
	getSessionStats: Mock;
	getContextReport: Mock;
	getUsage: Mock;
}

function installOmp(): RpcMock {
	const mock: RpcMock = {
		getSessionStats: vi.fn(async () => ({
			type: "response",
			command: "get_session_stats",
			success: true,
			data: stats,
		})),
		getContextReport: vi.fn(async () => ({
			type: "response",
			command: "get_context_report",
			success: true,
			data: { contextWindow: 200_000, model: "acme-opus-5" },
		})),
		getUsage: vi.fn(async () => ({ type: "response", command: "get_usage", success: true, data: { reports: [] } })),
	};
	Object.assign(window, {
		omp: { rpc: mock, stats: { fetch: vi.fn(async () => ({ error: "not running" })) } },
	});
	return mock;
}

interface TestElement {
	textContent: string | null;
	dispatchEvent: (event: object) => boolean;
	getAttribute: (name: string) => string | null;
	remove: () => void;
}

let container: TestElement;
let root: Root;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<InsightsPage />
			</I18nProvider>,
		);
	});
	await flush();
}

function tab(label: string): TestElement | undefined {
	return (Array.from(document.querySelectorAll('[role="tab"]')) as unknown as TestElement[]).find(
		element => element.textContent?.trim() === label,
	);
}

async function click(target: TestElement): Promise<void> {
	const event = new Event("click", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	await act(async () => {
		target.dispatchEvent(event);
	});
	await flush();
}

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	useUiStore.setState({ destination: "session", insightsTab: "stats", insightsStatsScope: "session" });
	useSessionStore.getState().reset();
});

describe("InsightsPage", () => {
	it("shows this session's figures under the This session scope", async () => {
		const omp = installOmp();
		useSessionStore.getState().setStatus("ready", "/repo");
		useUiStore.getState().openInsights("stats", "session");
		await mount();

		expect(tab("This session")?.getAttribute("aria-selected")).toBe("true");
		expect(omp.getSessionStats).toHaveBeenCalled();
		expect(omp.getContextReport).toHaveBeenCalled();
		const text = document.body.textContent ?? "";
		expect(text).toContain("58.2k");
		expect(text).toContain("$0.06");
		expect(text).toContain("acme/acme-opus-5");
		expect(text).toContain("#0199aa00");
	});

	it("lets this session's columns shrink below their longest unbreakable value", async () => {
		installOmp();
		useSessionStore.getState().setStatus("ready", "/repo");
		useUiStore.getState().openInsights("stats", "session");
		await mount();

		const heading = [...document.querySelectorAll("h3")].find(node => node.textContent === "Active context tokens");
		// An implicit `auto` track grows to the widest min-content (a session id, a file path), so at
		// 800px the whole page scrolled sideways; a minmax(0, 1fr) track keeps it in the column.
		expect(heading?.closest("section")?.parentElement?.className).toContain("grid-cols-[minmax(0,1fr)]");
	});

	it("explains a missing session and switches scope to all sessions from the store", async () => {
		installOmp();
		useUiStore.getState().openInsights("stats", "session");
		await mount();
		expect(document.body.textContent).toContain("No session connected");

		await click(tab("All sessions")!);
		expect(useUiStore.getState().insightsStatsScope).toBe("all");
		expect(document.body.textContent).toContain("Every project and session on this computer.");
		expect(document.body.textContent).toContain("Overview");
		// One name per concept: the page tab is not named after the dashboard's first section.
		expect(tab("Activity")?.getAttribute("aria-selected")).toBe("true");
		expect(tab("Overview")).toBeUndefined();
	});

	it("lands the Usage tab on provider quotas with a way to this session's usage", async () => {
		const omp = installOmp();
		useSessionStore.getState().setStatus("ready", "/repo");
		useUiStore.getState().openInsights("usage");
		await mount();
		expect(omp.getUsage).toHaveBeenCalled();
		expect(document.body.textContent).toContain("No quota reports");
	});

	it("gives every account of one provider its own quota card and marks the one in use", async () => {
		const omp = installOmp();
		const limit = { id: "anthropic:5h", label: "Claude 5 Hour", usedFraction: 0.25 };
		omp.getUsage.mockResolvedValue({
			type: "response",
			command: "get_usage",
			success: true,
			data: {
				reports: [
					{ provider: "anthropic", fetchedAt: 1, limits: [limit], account: "work@example.com", credentialId: 7 },
					{
						provider: "anthropic",
						fetchedAt: 1,
						limits: [limit],
						account: "home@example.com",
						credentialId: 9,
						active: true,
					},
				],
			},
		});
		useSessionStore.getState().setStatus("ready", "/repo");
		useUiStore.getState().openInsights("usage");
		await mount();
		const cards = Array.from(document.querySelectorAll("section")).map(card => card.textContent ?? "");
		const work = cards.find(card => card.includes("work@example.com") && !card.includes("home@example.com"));
		const home = cards.find(card => card.includes("home@example.com") && !card.includes("work@example.com"));
		expect(work).toBeDefined();
		expect(home).toBeDefined();
		expect(work).not.toContain("In use");
		expect(home).toContain("In use");
	});
});
