import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { QueueEntry } from "../../../shared/checks-contract";
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
const { ChecksQueue, QueueCard } = await import("./ChecksQueue");

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

const entry = (pr: number, position: number, over: Partial<QueueEntry> = {}): QueueEntry => ({
	id: `q-${pr}`,
	repo: "example/app",
	base: "main",
	pr,
	sha: `${pr}a3c5e7092b4d6f8a0c2e4f6081a3c5e7092b4d6`,
	lane: "land",
	position,
	state: "testing",
	...over,
});

function withQueue(queue: QueueEntry[]) {
	const frame = checksFrame("busy", FIXED_NOW, false);
	return { ...frame, snapshot: { ...frame.snapshot, queue } };
}

describe("QueueCard", () => {
	it("shows the fixture's entry with its short sha, state and batch sentence", async () => {
		const host = await mount(<QueueCard frame={checksFrame("busy", FIXED_NOW, false)} />);
		const rows = [...host.querySelectorAll("[data-queue-entry]")];
		expect(rows).toHaveLength(1);
		expect(rows[0]?.textContent).toContain("#128");
		expect(rows[0]?.textContent).toContain("1a3c5e7");
		expect(rows[0]?.textContent).toContain("testing");
		expect(host.textContent).toContain("Batch batch-3 tests this pull request and lands it when green.");
	});

	it("lists entries in position order, names the batch size and calls an unbatched waiter next batch", async () => {
		const frame = withQueue([
			entry(425, 4, { state: "waiting" }),
			entry(421, 2, { batch: "B-7" }),
			entry(418, 1, { batch: "B-7" }),
			entry(423, 3, { batch: "B-7" }),
		]);
		const host = await mount(<QueueCard frame={frame} />);
		const rows = [...host.querySelectorAll("[data-queue-entry]")].map(row => row.textContent ?? "");
		expect(rows.map(row => row.match(/#\d+/)?.[0])).toEqual(["#418", "#421", "#423", "#425"]);
		expect(rows.filter(row => row.endsWith("testing"))).toHaveLength(3);
		expect(rows[3]?.endsWith("next batch")).toBe(true);
		expect(host.textContent).toContain("Batch B-7 tests the 3 together and lands them in order when green.");
	});

	it("renders nothing for an empty queue", async () => {
		const host = await mount(<QueueCard frame={withQueue([])} />);
		expect(host.textContent).toBe("");
	});
});

describe("ChecksQueue", () => {
	it("says nothing waits to land when the queue and the land lane are empty", async () => {
		const host = await mount(<ChecksQueue frame={checksFrame("idle", FIXED_NOW, false)} />);
		expect(host.textContent).toContain("No pull request is waiting to land");
		expect(host.querySelector("table, ul, ol")).toBeNull();
	});

	it("shows a landing run with its progress and who started it", async () => {
		const frame = checksFrame("busy", FIXED_NOW, false);
		const [first, ...rest] = frame.snapshot.runs;
		if (!first) throw new Error("fixture has runs");
		const landing = {
			...frame,
			snapshot: { ...frame.snapshot, runs: [{ ...first, lane: "land" as const }, ...rest] },
		};
		const host = await mount(<ChecksQueue frame={landing} />);
		const runs = host.querySelectorAll("[data-land-run]");
		expect(runs).toHaveLength(1);
		expect(runs[0]?.textContent).toContain("app");
		expect(runs[0]?.textContent).toContain("1 of 2 jobs done");
		expect(runs[0]?.textContent).toContain("Ship 1.4 (Autopilot)");
		expect(runs[0]?.textContent).toContain("Running");
	});

	it("reads in Korean without leaking a key", async () => {
		await loadLocale("ko");
		setLanguageOverride("ko");
		const host = await mount(<ChecksQueue frame={checksFrame("busy", FIXED_NOW, true)} />);
		expect(host.textContent).not.toContain("checks.");
		expect(host.textContent).toContain("검사 중");
	});
});
