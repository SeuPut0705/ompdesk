import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { Snapshot } from "../../../../shared/checks-contract";
import type { ChecksFrame } from "../../../../shared/checks-frame";
import { checksFrame } from "../../../dev-harness/fixture-checks";
import { I18nProvider, setLanguageOverride } from "../../../lib/i18n";
import { useChecksStore } from "../../../stores/checks";
import { useUiStore } from "../../../stores/ui";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

// react-dom reads the DOM globals when it loads, so it is imported after they exist (the linkedom harness).
const { createRoot } = await import("react-dom/client");
const { SidebarChecks } = await import("./SidebarChecks");

const FIXED_NOW = Date.UTC(2026, 10, 14, 12, 0, 0);

let root: Root | undefined;
let container: HTMLElement;

const busy = (): ChecksFrame => checksFrame("busy", FIXED_NOW, false);

/** The busy frame with its snapshot changed. */
const withSnapshot = (frame: ChecksFrame, change: Partial<Snapshot>): ChecksFrame => ({
	...frame,
	snapshot: { ...frame.snapshot, ...change },
});

/** The busy frame with `count` more pools at work, copies of this computer's. */
function withMorePools(count: number): ChecksFrame {
	const frame = busy();
	const macbook = frame.snapshot.pools.find(pool => pool.id === "device-macbook");
	if (!macbook) throw new Error("the busy frame has this computer's pool");
	const more = Array.from({ length: count }, (_, index) => ({ ...macbook, id: `device-extra-${index}` }));
	return withSnapshot(frame, { pools: [...frame.snapshot.pools, ...more] });
}

async function mount(frame: ChecksFrame | null): Promise<Element> {
	useChecksStore.getState().apply(frame);
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () =>
		root?.render(
			<I18nProvider>
				<SidebarChecks />
			</I18nProvider>,
		),
	);
	return container as unknown as Element;
}

const block = (view: Element) => view.querySelector("[data-sidebar-checks]");
const name = (view: Element) => block(view)?.getAttribute("aria-label") ?? "";
const gaugeTexts = (view: Element) => [...view.querySelectorAll(".omp-usage-gauge-text")].map(text => text.textContent);
const releaseLine = (view: Element) => view.querySelector("[data-checks-release]")?.textContent;

afterEach(async () => {
	await act(async () => root?.unmount());
	document.body.replaceChildren();
	useChecksStore.getState().reset();
	useUiStore.getState().closeDestination();
	setLanguageOverride(null);
});

describe("SidebarChecks", () => {
	it("draws nothing before main has sent a frame", async () => {
		const view = await mount(null);
		expect(view.childNodes).toHaveLength(0);
	});

	it("draws nothing while no pool has work", async () => {
		const view = await mount(checksFrame("idle", FIXED_NOW, false));
		expect(view.childNodes).toHaveLength(0);
	});

	it("is one button that says the whole block in its name", async () => {
		const view = await mount(busy());
		expect(view.querySelectorAll("button, a, input, select, [role='button']")).toHaveLength(1);
		expect(name(view)).toBe(
			"Checks: 3 waiting. GitHub macOS 5 of 5, GitHub Linux 6 of 40, MacBook 2 of 3. " +
				"Release v1.4.0: 1 of 2 gates green. Open Checks.",
		);
	});

	it("shows each pool with work as a gauge, with its wait, its disk and the release line", async () => {
		const view = await mount(busy());
		const bars = [...view.querySelectorAll('[role="progressbar"]')];
		expect(bars.map(bar => bar.getAttribute("aria-label"))).toEqual([
			"GitHub macOS: 5 of 5 slots in use",
			"GitHub Linux: 6 of 40 slots in use",
			"MacBook: 2 of 3 slots in use",
		]);
		expect(bars.map(bar => bar.getAttribute("aria-valuenow"))).toEqual(["100", "15", "67"]);
		expect(gaugeTexts(view)).toEqual(["GitHub macOS5/5", "GitHub Linux6/40", "MacBook2/3"]);
		// The paired computer is offline and has no work: it has no gauge.
		expect(view.textContent).not.toContain("Mac mini");
		expect(view.textContent).toContain("3 waiting");
		expect(view.textContent).toContain("oldest wait 9m");
		expect(view.textContent).toContain("disk 212 GB free");
		expect(releaseLine(view)).toBe("v1.4.0 · 1 of 2 gates green");
	});

	it("draws a full pool as busy (warning), never as an error", async () => {
		const view = await mount(busy());
		const states = [...view.querySelectorAll("[data-pool]")].map(gauge => gauge.getAttribute("data-state"));
		expect(states).toEqual(["near", "ok", "ok"]);
	});

	it("says where the release's jobs wait, and only when some do", async () => {
		const frame = busy();
		const view = await mount(frame);
		expect(releaseLine(view)).not.toContain("waits on");
		await act(async () => root?.unmount());

		const queued = {
			id: "job-queued",
			name: "mac-smoke",
			os: "macos" as const,
			pool: "github-macos",
			state: "queued" as const,
			queuedAt: FIXED_NOW,
		};
		const runs = frame.snapshot.runs.map(run =>
			run.id === "run-41" ? { ...run, jobs: [...run.jobs, queued] } : run,
		);
		const waiting = await mount(withSnapshot(frame, { runs }));
		expect(releaseLine(waiting)).toBe("v1.4.0 · 1 of 2 gates green · waits on GitHub macOS");
	});

	it("says so when every gate is green", async () => {
		const frame = busy();
		const gates = frame.snapshot.gates.map(status => ({ ...status, state: "green" as const }));
		const view = await mount(withSnapshot(frame, { gates }));
		expect(releaseLine(view)).toBe("v1.4.0 · all gates green");
		expect(name(view)).toContain("Release v1.4.0: all gates green.");
	});

	it("draws no release line when the hub has no gate", async () => {
		const view = await mount(withSnapshot(busy(), { gates: [] }));
		expect(view.querySelector("[data-checks-release]")).toBeNull();
		expect(name(view)).not.toContain("Release");
	});

	it("draws four pools and folds the rest into one line", async () => {
		const few = await mount(withMorePools(2));
		expect(few.querySelectorAll('[role="progressbar"]')).toHaveLength(4);
		expect(few.textContent).toContain("+1 more pool");
		expect(few.textContent).not.toContain("+1 more pools");
		await act(async () => root?.unmount());

		const many = await mount(withMorePools(3));
		expect(many.querySelectorAll('[role="progressbar"]')).toHaveLength(4);
		expect(many.textContent).toContain("+2 more pools");
		// The accessible name still reports every pool at work.
		expect(name(many).match(/MacBook 2 of 3/g)).toHaveLength(4);
	});

	it("opens the Checks page on a click and is the current page while it is open", async () => {
		const view = await mount(busy());
		const button = block(view) as unknown as HTMLElement;
		expect(button.getAttribute("aria-current")).toBeNull();
		expect(button.getAttribute("data-destination")).toBe("checks");
		await act(async () => button.click());
		expect(useUiStore.getState().destination).toBe("checks");
		expect(button.getAttribute("aria-current")).toBe("page");
	});

	it("says Paused in place of the count while the hub is paused", async () => {
		const view = await mount(withSnapshot(busy(), { paused: true }));
		expect(view.textContent).toContain("Paused");
		expect(view.textContent).not.toContain("waiting");
		expect(name(view)).toContain("Checks: Paused.");
	});

	it("shows no count when main cannot reach the hub", async () => {
		const view = await mount({ ...busy(), hub: "lost" });
		expect(view.textContent).toContain("offline");
		expect(view.textContent).not.toContain("waiting");
		expect(name(view)).toContain("Checks: offline.");
		expect(block(view)?.getAttribute("data-freshness")).toBe("lost");
	});

	it("shows no count when the hub reads no pool as live, and says which figure is old", async () => {
		const frame = busy();
		const pools = frame.snapshot.pools.map(pool => ({ ...pool, state: "stale" as const }));
		const view = await mount(withSnapshot(frame, { pools }));
		expect(view.textContent).not.toContain("waiting");
		expect(view.textContent).not.toContain("oldest wait");
		expect(view.textContent).toContain("not read lately");
		expect(name(view)).toContain("Checks: not read lately.");
	});

	it("says a pool it has not read lately while the others are live", async () => {
		const frame = busy();
		const pools = frame.snapshot.pools.map(pool =>
			pool.id === "github-macos" ? { ...pool, state: "stale" as const } : pool,
		);
		const view = await mount(withSnapshot(frame, { pools }));
		expect(view.querySelector("[data-pool='github-macos']")?.textContent).toContain("not read lately");
		expect(view.textContent).not.toContain("oldest wait");
		expect(view.textContent).toContain("3 waiting");
	});

	it("reads in Korean without an English word of its own", async () => {
		setLanguageOverride("ko");
		const view = await mount(checksFrame("busy", FIXED_NOW, true));
		expect(name(view)).toContain("대기");
		expect(name(view)).not.toContain("waiting");
		expect(name(view)).toContain("검사 화면 열기");
		expect(name(view)).toContain("릴리스 v1.4.0");
		expect(view.textContent).not.toContain("oldest wait");
		expect(view.textContent).toContain("디스크 212GB 남음");
	});
});
