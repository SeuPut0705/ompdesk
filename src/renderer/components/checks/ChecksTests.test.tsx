import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { Snapshot } from "../../../shared/checks-contract";
import { checksFrame } from "../../dev-harness/fixture-checks";
import { I18nProvider, loadLocale, setLanguageOverride } from "../../lib/i18n";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = await import("react-dom/client");
const { ChecksTests } = await import("./ChecksTests");

const FIXED_NOW = 1_800_000_000_000;
let root: Root;
let container: HTMLElement;

async function mount(element: ReactElement): Promise<HTMLElement> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => root.render(<I18nProvider>{element}</I18nProvider>));
	return container;
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	setLanguageOverride(null);
});

function withTrends(over: Partial<Snapshot["trends"]>) {
	const frame = checksFrame("busy", FIXED_NOW, false);
	return { ...frame, snapshot: { ...frame.snapshot, trends: { ...frame.snapshot.trends, ...over } } };
}

describe("ChecksTests", () => {
	it("draws the figures, the tables and the side cards from the busy frame", async () => {
		const host = await mount(<ChecksTests frame={checksFrame("busy", FIXED_NOW, false)} />);
		const text = host.textContent ?? "";
		expect(text).toContain("1h 30m");
		expect(text).toContain("down from 2h 30m the week before");
		expect(text).toContain("6h");
		expect(text).toContain("plus ≈ 4h from reused green results");
		expect(text).toContain("1 quarantined · 0 new · 1 clearing");

		const rows = [...(host.querySelector('table[aria-label^="Flaky tests"]')?.querySelectorAll("tbody tr") ?? [])];
		expect(rows).toHaveLength(1);
		const row = rows[0]?.textContent ?? "";
		expect(row).toContain("e2e/smoke.e2e.ts › opens a tab");
		expect(row).toContain("Windows");
		expect(row).toContain("Quarantined");
		expect(row).toContain("quarantined by “Ship 1.4 (Autopilot)” · 2d ago");
		expect(row).toContain("11 of 140");
		expect(row).toContain("same inputs");
		expect(row).toContain("sha256:a31f");
		expect(row).toContain("2 / 5 clean");

		const slow = host.querySelector("[data-slowdown]")?.textContent ?? "";
		expect(slow).toContain("Linux");
		expect(slow).toContain("900ms");
		expect(slow).toContain("1.4s +57 %");
		expect(slow).toContain("9f2c1d7");

		expect(text).toContain("GitHub macOS queue depth");
		expect(text).toContain("1,890 min");
		expect(text).toContain("≈ $33");
		expect(text).toContain("≈ $15");
		expect(text).toContain("an estimate at GitHub's published rates, not a bill");
		expect(text).toContain("Runs started through the tool");
		expect(text).toContain("Check logs and reuse store use 6.3 GB");
		const depth = host.querySelector('[role="img"]');
		expect(depth?.getAttribute("aria-label")).toContain("peak 3");
		expect(depth?.getAttribute("aria-label")).toContain("latest 3");
	});

	it("says up from when the week got worse and nothing when there was no week before", async () => {
		const worseFrame = withTrends({ lostMs7d: 200 * 60_000, lostMsPrev7d: 100 * 60_000 });
		const worse = await mount(<ChecksTests frame={worseFrame} />);
		expect(worse.textContent).toContain("up from 1h 40m the week before");
		await act(async () => root.unmount());
		const fresh = await mount(<ChecksTests frame={withTrends({ lostMsPrev7d: 0 })} />);
		expect(fresh.textContent).not.toContain("the week before");
	});

	it("names a quarantine by a session main cannot name as an agent session", async () => {
		const frame = checksFrame("busy", FIXED_NOW, false);
		const host = await mount(<ChecksTests frame={{ ...frame, names: { ...frame.names, sessions: {} } }} />);
		expect(host.textContent).toContain("quarantined by “an agent session”");
	});

	it("says a cleared test was cleared by history, with when", async () => {
		const frame = checksFrame("busy", FIXED_NOW, false);
		const [first] = frame.snapshot.trends.tests;
		if (!first) throw new Error("fixture has a flaky test");
		const clearedAt = frame.snapshot.asOf - 3_600_000;
		const cleared = withTrends({
			tests: [{ ...first, state: "cleared", cleanSince: 5, quarantinedBy: undefined, clearedAt }],
		});
		const host = await mount(<ChecksTests frame={cleared} />);
		const row = host.querySelector("[data-flaky-test]")?.textContent ?? "";
		expect(row).toContain("Cleared");
		expect(row).toContain("cleared by history · 1h ago");
		expect(row).toContain("5 / 5 clean");
	});

	it("draws no sparkline for a slowdown with fewer than two points, and no store line without a size", async () => {
		const frame = checksFrame("busy", FIXED_NOW, false);
		const [slow] = frame.snapshot.trends.slowdowns;
		if (!slow) throw new Error("fixture has a slowdown");
		const one = withTrends({ slowdowns: [{ ...slow, lastMs: [1300] }], storeBytes: undefined });
		const host = await mount(<ChecksTests frame={one} />);
		expect(host.querySelector("[data-slowdown] svg")).toBeNull();
		expect(host.textContent).not.toContain("reuse store");
	});

	it("shows the empty state when the snapshot has no test data", async () => {
		const host = await mount(<ChecksTests frame={checksFrame("idle", FIXED_NOW, false)} />);
		expect(host.textContent).toContain("No test history yet");
		expect(host.querySelector("table")).toBeNull();
	});

	it("draws only the parts the snapshot carries", async () => {
		const only = withTrends({
			tests: [],
			slowdowns: [],
			queueDepth: [],
			lostMs7d: 0,
			lostMsPrev7d: 0,
			savedByRerunMs7d: 0,
			savedByReuseMs7d: 0,
			storeBytes: undefined,
		});
		const host = await mount(<ChecksTests frame={only} />);
		const text = host.textContent ?? "";
		expect(text).toContain("Runner minutes by OS");
		expect(host.querySelector("table")).toBeNull();
		expect(text).not.toContain("Flaky tests");
		expect(text).not.toContain("Time lost");
		expect(text).not.toContain("queue depth");
	});

	it("reads in Korean without leaking a key", async () => {
		await loadLocale("ko");
		setLanguageOverride("ko");
		const host = await mount(<ChecksTests frame={checksFrame("busy", FIXED_NOW, true)} />);
		expect(host.textContent).not.toContain("checks.");
		expect(host.textContent).toContain("격리됨");
	});
});
