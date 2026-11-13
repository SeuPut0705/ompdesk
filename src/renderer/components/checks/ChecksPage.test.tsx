import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { Snapshot } from "../../../shared/checks-contract";
import type { ChecksFrame } from "../../../shared/checks-frame";
import { checksFrame } from "../../dev-harness/fixture-checks";
import { I18nProvider, loadLocale, setLanguageOverride } from "../../lib/i18n";
import { useChecksStore } from "../../stores/checks";
import { useUiStore } from "../../stores/ui";

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
const { ChecksPage } = await import("./ChecksPage");

const FIXED_NOW = Date.UTC(2026, 10, 14, 12, 0, 0);

let root: Root | undefined;
let setPaused: Mock;
// linkedom has no layout: the scroll to the opened run is recorded instead.
const scrolledTo: (string | null)[] = [];
Object.assign(HTMLElement.prototype, {
	scrollIntoView(this: Element) {
		scrolledTo.push(this.getAttribute("data-check-run"));
	},
});

const busy = (): ChecksFrame => checksFrame("busy", FIXED_NOW, false);
const withSnapshot = (frame: ChecksFrame, change: Partial<Snapshot>): ChecksFrame => ({
	...frame,
	snapshot: { ...frame.snapshot, ...change },
});

async function mount(frame: ChecksFrame | null): Promise<Element> {
	useChecksStore.getState().apply(frame);
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () =>
		root?.render(
			<I18nProvider>
				<ChecksPage />
			</I18nProvider>,
		),
	);
	return container as unknown as Element;
}

const text = (view: Element, selector: string) => view.querySelector(selector)?.textContent ?? "";
const click = (element: Element | null | undefined) =>
	act(async () => {
		element?.dispatchEvent(new Event("click", { bubbles: true }));
	});

beforeEach(() => {
	setPaused = vi.fn(async () => {});
	Object.assign(window, { omp: { checks: { setPaused } } });
});

afterEach(async () => {
	await act(async () => root?.unmount());
	document.body.replaceChildren();
	useChecksStore.getState().reset();
	useUiStore.setState({ checksTab: "now", checksRun: null });
	setLanguageOverride(null);
});

describe("Checks page", () => {
	it("says there is nothing yet, with no control, while main has sent no frame", async () => {
		const view = await mount(null);
		expect(view.querySelector("[data-checks-empty]")).not.toBeNull();
		expect(view.querySelector("[data-checks-pause]")).toBeNull();
		expect(view.querySelector("[data-check-pool]")).toBeNull();
	});

	it("shows every pool by device, runner and OS with its slots, queue and disk", async () => {
		const view = await mount(busy());
		const pools = [...view.querySelectorAll("[data-check-pool]")].map(pool => pool.textContent ?? "");
		expect(pools).toHaveLength(4);
		expect(pools[0]).toContain("GitHub macOS");
		expect(pools[0]).toContain("5 / 5 slots");
		expect(pools[0]).toContain("3 queued");
		expect(pools[0]).toContain("oldest 9m");
		expect(pools[1]).toContain("GitHub Linux");
		expect(pools[1]).not.toContain("idle");
		expect(pools[2]).toContain("MacBook");
		expect(pools[2]).toContain("this computer");
		expect(pools[2]).toContain("disk 212 GB free");
		expect(pools[3]).toContain("Mac mini");
		expect(pools[3]).toContain("offline");
		expect(
			view.querySelector('[data-check-pool="github-macos"] [role="progressbar"]')?.getAttribute("aria-label"),
		).toBe("GitHub macOS: 5 of 5 in use");
	});

	it("shows the release's gates, who started it, and what its jobs wait on", async () => {
		const frame = busy();
		const view = await mount(frame);
		const release = text(view, '[data-check-release="v1.4.0"]');
		expect(release).toContain("Release v1.4.0");
		expect(release).toContain("1 of 2 gates green");
		expect(release).toContain("Started by goal “Ship 1.4”");
		expect(release).toContain("Autopilot run on MacBook");
		expect(text(view, '[data-check-gate="gate-mac"]')).toContain("mac-smoke, mac-native");
		expect(view.querySelector('[data-check-gate="gate-mac"]')?.getAttribute("data-state")).toBe("running");
		expect(view.querySelector("[data-check-waits]")).toBeNull();

		await act(async () => root?.unmount());
		document.body.replaceChildren();
		const runs = frame.snapshot.runs.map(run =>
			run.id === "run-41"
				? {
						...run,
						jobs: [
							...run.jobs,
							{
								id: "job-413",
								os: "macos" as const,
								pool: "github-macos",
								state: "queued" as const,
								queuedAt: FIXED_NOW,
							},
						],
					}
				: run,
		);
		const waiting = await mount(withSnapshot(frame, { runs }));
		expect(text(waiting, "[data-check-waits]")).toContain("Waiting on GitHub macOS:");
		expect(text(waiting, "[data-check-waits]")).toContain("5 of 5 slots in use");
	});

	it("lists runs under their lane with the session, goal and computer behind each", async () => {
		const view = await mount(busy());
		expect([...view.querySelectorAll("[data-check-lane]")].map(lane => lane.getAttribute("data-check-lane"))).toEqual(
			["release", "branch"],
		);
		const release = text(view, '[data-check-run="run-41"]');
		expect(release).toContain("app · release/1.4");
		expect(release).toContain("9f2c1d7");
		expect(release).toContain("macOS 1 running · Linux done");
		expect(release).toContain("Ship 1.4 (Autopilot)");
		expect(release).toContain("Goal “Ship 1.4” · on MacBook");
		expect(release).toContain("Running");
		const held = text(view, '[data-check-run="run-42"]');
		expect(held).toContain("Held");
		expect(held).toContain("macOS is full (5 of 5) and a release job is ahead");
		expect(held).toContain("Search index");
		expect(held).toContain("on Mac mini");
		const person = text(view, '[data-check-run="run-40"]');
		expect(person).toContain("Started by a person");
		expect(person).toContain("Failed");
	});

	it("says a run no session started is another repository's, shown and never governed", async () => {
		const frame = busy();
		const runs = frame.snapshot.runs.map(run =>
			run.id === "run-40" ? { ...run, origin: { kind: "foreign" as const } } : run,
		);
		const view = await mount(withSnapshot(frame, { runs }));
		expect(text(view, '[data-check-run="run-40"]')).toContain("Another repository · shown, never governed");
	});

	it("shows the last answer an agent received and the decided-automatically log", async () => {
		const view = await mount(busy());
		const answer = text(view, "[data-check-answer]");
		expect(view.querySelector("[data-check-answer]")?.getAttribute("data-check-answer")).toBe("red");
		expect(answer).toContain("Ship 1.4 (Autopilot)");
		expect(answer).toContain("1 of 1144 failed");
		expect(answer).toContain("src/store/save.test.ts > saves the file once");
		expect(answer).toContain("AssertionError: expected 1 to be 2");
		expect(answer).toContain("rerun the failed ones");
		const decisions = [...view.querySelectorAll("[data-check-decision]")].map(row => row.textContent ?? "");
		expect(decisions).toHaveLength(2);
		expect(decisions.join(" ")).toContain("macOS is full (5 of 5) and a release job is ahead");
	});

	it("writes one sentence per policy action", async () => {
		const frame = busy();
		const decisions = [
			{ policy: "release-first", run: "run-42", action: "hold", reason: "macOS full", at: FIXED_NOW },
		];
		const view = await mount(withSnapshot(frame, { decisions }));
		expect(text(view, '[data-check-decision="hold"]')).toContain("Held 1 job of app · omp/agent/search-index");
	});

	it("marks the run it was opened on, as the work board's row opens it", async () => {
		useUiStore.getState().openChecks("tests", "run-42");
		const view = await mount(busy());
		expect(useUiStore.getState().checksTab).toBe("now");
		expect(view.querySelector('[data-check-run="run-42"]')?.getAttribute("aria-current")).toBe("true");
		expect(view.querySelector('[data-check-run="run-41"]')?.getAttribute("aria-current")).toBeNull();
		expect(scrolledTo).toEqual(["run-42"]);
	});

	it("switches between its three tabs", async () => {
		const view = await mount(busy());
		const tabs = [...view.querySelectorAll('[role="tab"]')];
		expect(tabs.map(tab => tab.textContent)).toEqual(["Now", "Merge queue", "Tests and cost"]);
		await click(tabs[1]);
		expect(view.querySelector("[data-checks-tab]")?.getAttribute("data-checks-tab")).toBe("queue");
		expect(text(view, "[data-checks-tab]")).toContain("#128");
		await click(tabs[2]);
		expect(view.querySelector("[data-checks-tab]")?.getAttribute("data-checks-tab")).toBe("tests");
		expect(text(view, "[data-checks-tab]")).toContain("e2e/smoke.e2e.ts › opens a tab");
	});

	it("has one control: Pause admission asks main, and a paused hub says so and offers Resume", async () => {
		const view = await mount(busy());
		const buttons = [...view.querySelectorAll("button")].filter(button => button.getAttribute("role") !== "tab");
		expect(buttons.map(button => button.textContent)).toEqual(["Pause admission"]);
		await click(buttons[0]);
		expect(setPaused).toHaveBeenCalledExactlyOnceWith(true);

		await act(async () => useChecksStore.getState().apply(withSnapshot(busy(), { paused: true })));
		expect(view.querySelector("[data-checks-paused]")).not.toBeNull();
		expect(text(view, "[data-checks-pause]")).toBe("Resume admission");
		await click(view.querySelector("[data-checks-pause]"));
		expect(setPaused).toHaveBeenLastCalledWith(false);
	});

	it("says above everything when the frame is the hub's last word or no pool was read lately", async () => {
		const view = await mount({ ...busy(), hub: "lost" });
		expect(view.querySelector("[data-checks-stale]")?.getAttribute("data-checks-stale")).toBe("lost");
		const frame = busy();
		const pools = frame.snapshot.pools.map(pool => ({ ...pool, state: "stale" as const }));
		await act(async () => useChecksStore.getState().apply(withSnapshot(frame, { pools })));
		expect(view.querySelector("[data-checks-stale]")?.getAttribute("data-checks-stale")).toBe("stale");
		await act(async () => useChecksStore.getState().apply(busy()));
		expect(view.querySelector("[data-checks-stale]")).toBeNull();
	});

	it("reads in Korean with no key left untranslated", async () => {
		await loadLocale("ko");
		setLanguageOverride("ko");
		const view = await mount(checksFrame("busy", FIXED_NOW, true));
		const page = view.textContent ?? "";
		expect(page).toContain("검사");
		expect(page).toContain("릴리스 v1.4.0");
		expect(page).toContain("게이트 2개 중 1개 통과");
		expect(page).not.toMatch(/checks\.[a-z]/);
		expect(page).not.toContain("Pause admission");
	});
});
