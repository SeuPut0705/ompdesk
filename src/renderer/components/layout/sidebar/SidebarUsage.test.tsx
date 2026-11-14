import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UsageLimit, UsageReport } from "../../../../shared/rpc-types";
import { I18nProvider } from "../../../lib/i18n";
import { en } from "../../../locales/en";
import { useSessionStore } from "../../../stores/session";
import { useSidebarFolds } from "../../../stores/sidebar-folds";
import { useTabsStore } from "../../../stores/tabs";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

let reports: UsageReport[] = [];
Reflect.set(window, "omp", {
	rpc: {
		getUsage: vi.fn(async () => ({ type: "response", command: "get_usage", success: true, data: { reports } })),
	},
	prefs: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) },
});

const { createRoot } = await import("react-dom/client");
const { SidebarUsage } = await import("./SidebarUsage");

let root: Root;
let container: HTMLElement;

const HOUR = 3_600_000;

function gauge(id: string, label: string, usedFraction: number, resetsInHours: number): UsageLimit {
	const windowId = id.split(":")[1];
	return { id, label, windowId, usedFraction, resetsAt: Date.now() + resetsInHours * HOUR };
}

/** A whole-account 5 hour and 7 day window, and a model's own weekly one when `fable` is given. */
function limits(provider: string, five: number, seven: number, fable?: number): UsageLimit[] {
	const windows = [gauge(`${provider}:5h`, "5 hour", five, 2.1), gauge(`${provider}:7d`, "7 day", seven, 100)];
	if (fable !== undefined) windows.push(gauge(`${provider}:7d:fable`, "Claude 7 Day (Fable)", fable, 90));
	return windows;
}

function report(provider: string, id: number, account: string, over: Partial<UsageReport> = {}): UsageReport {
	return {
		provider,
		fetchedAt: Date.now(),
		account,
		credentialId: id,
		limits: limits(provider, 0.1 * (id % 10), 0.2 + 0.05 * (id % 10)),
		...over,
	};
}

/** The owner's shape: four Claude accounts and four ChatGPT accounts, the session on the second Claude one. */
function fourAndFour(): UsageReport[] {
	return [
		...[1, 2, 3, 4].map(id =>
			report("anthropic", id, `claude${id}@example.com`, {
				active: id === 2,
				limits: limits("anthropic", 0.1 * id, 0.2 + 0.05 * id, 0.05 * id),
			}),
		),
		...[1, 2, 3, 4].map(id => report("openai-codex", 10 + id, `chatgpt${id}@example.com`)),
	];
}

async function mount(list: UsageReport[]): Promise<Element | null> {
	useSessionStore.setState({ status: "ready" });
	reports = list;
	useTabsStore.setState({
		tabs: [{ id: "t1", cwd: "/w", status: "ready", kind: "agent", unreadDone: false }],
		activeTabId: "t1",
		bundles: new Map(),
	});
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () =>
		root.render(
			<I18nProvider>
				<SidebarUsage />
			</I18nProvider>,
		),
	);
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 20));
	});
	return container.querySelector(".omp-sidebar-usage");
}

const row = (block: Element | null, id: number) => block?.querySelector(`[data-usage-account="${id}"]`) ?? null;

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	useSidebarFolds.getState().reset();
	useSessionStore.getState().reset();
});

describe("SidebarUsage", () => {
	it("lists every account of every provider, grouped by provider with its count", async () => {
		const block = await mount(fourAndFour());
		const groups = [...(block?.querySelectorAll("[data-provider-row]") ?? [])];
		const ids = groups.map(group => group.getAttribute("data-provider-row")).sort();
		expect(ids).toEqual(["anthropic", "openai-codex"]);
		const counts = groups.map(group => group.querySelector("[data-account-count]")?.textContent);
		expect(counts.map(count => count?.replace("· ", ""))).toEqual(["4 accounts", "4 accounts"]);
		const labels = [...(block?.querySelectorAll("[data-usage-account] [data-account-label]") ?? [])];
		const wanted = [1, 2, 3, 4].flatMap(id => [`chatgpt${id}@example.com`, `claude${id}@example.com`]);
		expect(labels.map(label => label.textContent).sort()).toEqual(wanted.sort());
	});

	it("marks the account this session uses, and no other", async () => {
		const block = await mount(fourAndFour());
		const marked = [...(block?.querySelectorAll("[data-in-use]") ?? [])];
		expect(marked).toHaveLength(1);
		expect(marked[0]?.getAttribute("data-usage-account")).toBe("2");
		expect(marked[0]?.textContent).toContain("In use");
		expect(row(block, 3)?.textContent).not.toContain("In use");
	});

	it("marks an account at its limit, and one close to it", async () => {
		const block = await mount([
			report("anthropic", 1, "full@example.com", {
				limits: limits("anthropic", 0.4, 1),
				resetAt: Date.now() + 3 * HOUR,
			}),
			report("anthropic", 2, "near@example.com", { limits: limits("anthropic", 0.4, 0.9) }),
			report("anthropic", 3, "fine@example.com", { limits: limits("anthropic", 0.1, 0.2) }),
		]);
		const standing = (id: number) => row(block, id)?.getAttribute("data-usage-standing");
		const weekly = (id: number) => row(block, id)?.querySelector('[data-window="7d"]')?.getAttribute("data-state");
		expect([1, 2, 3].map(standing)).toEqual(["limited", "low", "ok"]);
		expect([1, 2, 3].map(weekly)).toEqual(["limit", "near", "ok"]);
	});

	it("shows every window of an account with its reset: 5H, 7D and a model's own", async () => {
		const block = await mount(fourAndFour());
		const gauges = [...(row(block, 2)?.querySelectorAll(".omp-usage-gauge") ?? [])];
		expect(gauges.map(gauge => gauge.querySelector(".omp-usage-gauge-text")?.textContent)).toEqual([
			"5H20%",
			"7D30%",
			"Fable10%",
		]);
		for (const gauge of gauges) expect(gauge.querySelector(".omp-usage-gauge-reset")?.textContent).toMatch(/^↻ \d/);
	});

	it("shows a long address whole: it wraps, and the label is its tooltip", async () => {
		const long = "a.very.long.address.of.somebody.with.many.dots@a-rather-long-company-domain.example.com";
		const block = await mount([report("anthropic", 1, long)]);
		const label = row(block, 1)?.querySelector("[data-account-label]");
		expect(label?.textContent).toBe(long);
		expect(label?.getAttribute("title")).toBe(long);
		expect(label?.className).toContain("[overflow-wrap:anywhere]");
		expect(label?.className).not.toContain("truncate");
	});

	it("folds one provider's accounts and remembers it, the others stay", async () => {
		const block = await mount(fourAndFour());
		const head = block?.querySelector('[data-provider-fold="anthropic"]') as HTMLElement | null;
		expect(head?.getAttribute("aria-expanded")).toBe("true");
		await act(async () => head?.click());
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 20));
		});
		expect(useSidebarFolds.getState().usageGroups).toEqual({ anthropic: true });
		expect(block?.querySelector('[data-provider-row="anthropic"] [data-usage-account]')).toBeNull();
		expect(block?.querySelectorAll('[data-provider-row="openai-codex"] [data-usage-account]')).toHaveLength(4);
	});

	it("folds the whole block to its header", async () => {
		useSidebarFolds.setState({ usageCollapsed: true });
		const block = await mount(fourAndFour());
		expect(block?.hasAttribute("data-collapsed")).toBe(true);
		expect(block?.querySelector("[data-sidebar-usage-toggle]")).not.toBeNull();
		expect(block?.querySelectorAll("[data-usage-account]")).toHaveLength(0);
	});

	it("says only why the session is on its current account", async () => {
		const rotation = { why: "better", moved: true, phase: "turn-start", at: Date.now() };
		const block = await mount([
			report("anthropic", 1, "a@example.com", { active: true, rotation }),
			report("anthropic", 2, "b@example.com", { rotation }),
		]);
		const reasons = block?.querySelectorAll("[data-account-reason]");
		expect(reasons).toHaveLength(1);
		expect(reasons?.[0]?.textContent).toBe(en["usage.rotation.better"]);
	});

	it("lists no API-key provider and renders nothing with no account", async () => {
		const none = await mount([report("openrouter", 1, "key", { limits: [] })]);
		expect(none).toBeNull();
	});
});
