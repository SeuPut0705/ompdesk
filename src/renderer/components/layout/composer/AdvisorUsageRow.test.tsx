/**
 * The advisor's spend in the Run popover: one line (lightbulb, "Advisor", a muted "$0.45 · 3 advisories" summary and
 * an (i) holding the numbers), read from the gui-bridge (`get_advisor_stats`) when the popover opens. An omp or host
 * that cannot report it, or an advisor that is off and never spent anything, leaves the line out.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { AdvisorUsage } from "../../../../../resources/gui-bridge/advisor-stats-contracts";
import type { RpcResponse } from "../../../../shared/rpc-types";
import { I18nProvider, translate } from "../../../lib/i18n";
import { useSessionStore } from "../../../stores/session";

const { document, window, Event, HTMLElement, Element, Node, PointerEvent } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	PointerEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const ok = (command: string, data: unknown): RpcResponse => ({ type: "response", command, success: true, data });

function usage(patch: Partial<AdvisorUsage> = {}): AdvisorUsage {
	return {
		configured: true,
		active: true,
		subscription: false,
		cost: 0.454,
		calls: 7,
		tokens: { input: 1000, output: 200, cacheRead: 5000, total: 6200 },
		advisories: { total: 3, other: 0, blocker: 0, concern: 2, nit: 1 },
		advisors: [{ name: "default", status: "running", model: "acme/acme-opus-5", calls: 7, cost: 0.454 }],
		...patch,
	};
}

let reply: unknown = usage();
const getAdvisorStats: Mock<() => Promise<RpcResponse>> = vi.fn(async () => ok("get_advisor_stats", reply));
const events = new Proxy({}, { get: () => vi.fn(() => () => {}) });
Object.assign(window as unknown as Record<string, unknown>, {
	omp: {
		rpc: {
			getAdvisorStats,
			getDelegation: vi.fn(async () => ok("get_delegation", { mode: "default" })),
			getSettings: vi.fn(async () => ok("get_settings", { values: {} })),
		},
		prefs: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) },
		events,
	},
});

const { createRoot } = await import("react-dom/client");
const { RunChip } = await import("./RunChip");
// RunChip loads the row lazily; resolving the module once here keeps that load out of every test's time.
await import("./AdvisorUsageRow");

let container: HTMLElement;
let root: Root;

async function mountOpen(): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<RunChip />
			</I18nProvider>,
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
	const trigger = container.querySelector("[data-run-settings-trigger]") as unknown as HTMLButtonElement;
	await act(async () => trigger.click());
	// The row is a lazy chunk: flush until it mounted and asked.
	await vi.waitFor(async () => {
		await act(async () => {
			await Promise.resolve();
		});
		expect(getAdvisorStats).toHaveBeenCalled();
	});
	await act(async () => {
		await Promise.resolve();
	});
}

const row = () => document.querySelector("[data-advisor-usage]");

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	document.body.innerHTML = "";
	reply = usage();
	getAdvisorStats.mockReset();
	getAdvisorStats.mockImplementation(async () => ok("get_advisor_stats", reply));
	useSessionStore.getState().reset();
});

describe("Advisor usage in the Run popover", () => {
	it("is one line: cost and advisory count at the right, the numbers behind (i)", async () => {
		useSessionStore.setState({ sessionId: "s1", status: "ready" });
		await mountOpen();
		expect(getAdvisorStats).toHaveBeenCalled();
		expect(row()).not.toBeNull();
		expect(row()?.querySelector("[data-advisor-summary]")?.textContent).toBe("$0.45 · 3 advisories");
		expect(row()?.querySelector("[data-setting-info]")).not.toBeNull();
		expect(row()?.querySelector("p")).toBeNull();
		expect(row()?.querySelector("[data-setting-desc]")).toBeNull();
		const text = row()?.textContent ?? "";
		expect(text).toContain(translate("input.advisor.title"));
		expect(text).toContain("Concern 2");
		expect(text).toContain("Nit 1");
		expect(text).not.toContain("Blocker");
		expect(text).toContain("acme/acme-opus-5");
		expect(text).toContain(translate("input.advisor.info.calls", { count: 7 }));
	});

	it("says the price is a list price when the advisor bills a subscription", async () => {
		reply = usage({ subscription: true });
		useSessionStore.setState({ sessionId: "s1", status: "ready" });
		await mountOpen();
		expect(row()?.textContent).toContain(translate("input.advisor.info.costSubscription", { cost: "$0.45" }));
	});

	it("reads 1 advisory in the singular and only the cost when there are none", async () => {
		reply = usage({ advisories: { total: 1, other: 0, blocker: 0, concern: 0, nit: 1 } });
		useSessionStore.setState({ sessionId: "s1", status: "ready" });
		await mountOpen();
		expect(row()?.querySelector("[data-advisor-summary]")?.textContent).toBe("$0.45 · 1 advisory");
		await act(async () => root.unmount());
		container.remove();
		reply = usage({ advisories: { total: 0, other: 0, blocker: 0, concern: 0, nit: 0 } });
		await mountOpen();
		expect(row()?.querySelector("[data-advisor-summary]")?.textContent).toBe("$0.45");
	});

	it("shows Off with the cost when the advisor was turned off after it spent", async () => {
		reply = usage({ configured: false, active: false });
		useSessionStore.setState({ sessionId: "s1", status: "ready" });
		await mountOpen();
		expect(row()?.querySelector("[data-advisor-summary]")?.textContent).toBe(
			`${translate("input.advisor.off")} · $0.45 · 3 advisories`,
		);
	});

	it("leaves the line out when the advisor is off and never spent anything", async () => {
		reply = usage({
			configured: false,
			active: false,
			cost: 0,
			calls: 0,
			advisories: { total: 0, other: 0, blocker: 0, concern: 0, nit: 0 },
			advisors: [],
		});
		useSessionStore.setState({ sessionId: "s1", status: "ready" });
		await mountOpen();
		expect(getAdvisorStats).toHaveBeenCalled();
		expect(row()).toBeNull();
	});

	it("leaves the line out on an omp or host that cannot report it", async () => {
		getAdvisorStats.mockImplementation(async () => {
			throw new Error("unknown command get_advisor_stats");
		});
		useSessionStore.setState({ sessionId: "s1", status: "ready" });
		await mountOpen();
		expect(getAdvisorStats).toHaveBeenCalled();
		expect(row()).toBeNull();
		expect(document.querySelector("[data-delegation-section]")).not.toBeNull();
	});

	it("leaves the line out on a refused or malformed reply", async () => {
		getAdvisorStats.mockImplementation(async () => ({
			type: "response",
			command: "get_advisor_stats",
			success: false,
			error: "no advisor",
		}));
		useSessionStore.setState({ sessionId: "s1", status: "ready" });
		await mountOpen();
		expect(row()).toBeNull();
		await act(async () => root.unmount());
		container.remove();
		reply = "nonsense";
		getAdvisorStats.mockImplementation(async () => ok("get_advisor_stats", reply));
		await mountOpen();
		expect(row()).toBeNull();
	});
});
