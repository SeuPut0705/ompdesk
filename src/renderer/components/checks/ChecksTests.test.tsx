import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
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

describe("ChecksTests", () => {
	it("draws the flaky table, the slowdowns and the side cards from the busy frame", async () => {
		const host = await mount(<ChecksTests frame={checksFrame("busy", FIXED_NOW, false)} />);
		const flaky = host.querySelector('table[aria-label^="Flaky tests"]');
		const rows = [...(flaky?.querySelectorAll("tbody tr") ?? [])];
		expect(rows).toHaveLength(1);
		expect(rows[0]?.textContent).toContain("e2e/smoke.e2e.ts › opens a tab");
		expect(rows[0]?.textContent).toContain("Quarantined");
		expect(rows[0]?.textContent).toContain("quarantined by “Ship 1.4 (Autopilot)”");
		expect(rows[0]?.textContent).toContain("2 / 5 clean");
		expect(rows[0]?.textContent).toContain("4s");
		const slow = host.querySelector("[data-slowdown]");
		expect(slow?.textContent).toContain("900ms");
		expect(slow?.textContent).toContain("+57 %");
		const text = host.textContent ?? "";
		expect(text).toContain("1 quarantined · 0 new · 1 clearing");
		expect(text).toContain("GitHub macOS queue depth");
		expect(text).toContain("1,890 min");
		expect(text).toContain("Runs started through the tool");
		const depth = host.querySelector('[role="img"]');
		expect(depth?.getAttribute("aria-label")).toContain("peak 3");
		expect(depth?.getAttribute("aria-label")).toContain("latest 3");
	});

	it("names a quarantine by a session main cannot name as an agent session", async () => {
		const frame = checksFrame("busy", FIXED_NOW, false);
		const unnamed = { ...frame, names: { ...frame.names, sessions: {} } };
		const host = await mount(<ChecksTests frame={unnamed} />);
		expect(host.textContent).toContain("quarantined by “an agent session”");
	});

	it("draws no sparkline for a slowdown with fewer than two points", async () => {
		const frame = checksFrame("busy", FIXED_NOW, false);
		const { trends } = frame.snapshot;
		const one = {
			...frame,
			snapshot: {
				...frame.snapshot,
				trends: { ...trends, slowdowns: trends.slowdowns.map(entry => ({ ...entry, lastMs: [1300] })) },
			},
		};
		const host = await mount(<ChecksTests frame={one} />);
		expect(host.querySelector("[data-slowdown] svg")).toBeNull();
	});

	it("shows the empty state when the snapshot has no test data", async () => {
		const host = await mount(<ChecksTests frame={checksFrame("idle", FIXED_NOW, false)} />);
		expect(host.textContent).toContain("No test history yet");
		expect(host.querySelector("table")).toBeNull();
	});

	it("draws only the parts the snapshot carries", async () => {
		const frame = checksFrame("busy", FIXED_NOW, false);
		const only = {
			...frame,
			snapshot: {
				...frame.snapshot,
				trends: { ...frame.snapshot.trends, tests: [], slowdowns: [], queueDepth: [] },
			},
		};
		const host = await mount(<ChecksTests frame={only} />);
		const text = host.textContent ?? "";
		expect(text).toContain("Runner minutes by OS");
		expect(host.querySelector("table")).toBeNull();
		expect(text).not.toContain("Flaky tests");
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
