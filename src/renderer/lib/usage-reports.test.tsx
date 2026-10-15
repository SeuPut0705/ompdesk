import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { UsageReport } from "../../shared/rpc-types";
import {
	inUseReport,
	USAGE_BACKOFF_MAX_MS,
	USAGE_POLL_MS,
	usagePollDelay,
	useLiveUsage,
	useUsageSignal,
} from "./usage-reports";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
let read: Mock<() => Promise<boolean>>;

function Poller({ active }: { active: boolean }) {
	useLiveUsage(read, active);
	return null;
}

async function mount(active = true): Promise<void> {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => root.render(<Poller active={active} />));
}

/** Advances the fake clock and lets the reads it starts settle. */
async function advance(ms: number): Promise<void> {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

function setVisibility(state: "visible" | "hidden"): void {
	Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
}

beforeEach(() => {
	vi.useFakeTimers();
	read = vi.fn(async () => true);
	setVisibility("visible");
});

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	vi.useRealTimers();
	useUsageSignal.getState().reset();
});

describe("usagePollDelay", () => {
	it("polls every 30 s and doubles the wait per failed read up to 5 minutes", () => {
		expect([0, 1, 2, 3, 4, 9].map(usagePollDelay)).toEqual([
			30_000,
			60_000,
			120_000,
			240_000,
			USAGE_BACKOFF_MAX_MS,
			USAGE_BACKOFF_MAX_MS,
		]);
	});
});

describe("useLiveUsage", () => {
	it("re-reads every poll interval while active and stops when unmounted", async () => {
		await mount();
		expect(read).not.toHaveBeenCalled();
		await advance(USAGE_POLL_MS - 1);
		expect(read).not.toHaveBeenCalled();
		await advance(1);
		expect(read).toHaveBeenCalledTimes(1);
		await advance(USAGE_POLL_MS);
		expect(read).toHaveBeenCalledTimes(2);
		await act(async () => root.unmount());
		await advance(USAGE_POLL_MS * 3);
		expect(read).toHaveBeenCalledTimes(2);
	});

	it("does nothing while inactive", async () => {
		await mount(false);
		await advance(USAGE_POLL_MS * 4);
		expect(read).not.toHaveBeenCalled();
	});

	it("re-reads at once when any tab's turn ends and when the window regains focus", async () => {
		await mount();
		await act(async () => useUsageSignal.getState().turnEnded());
		expect(read).toHaveBeenCalledTimes(1);
		await act(async () => {
			window.dispatchEvent(new Event("focus"));
		});
		expect(read).toHaveBeenCalledTimes(2);
		// Each read restarts the interval.
		await advance(USAGE_POLL_MS - 1);
		expect(read).toHaveBeenCalledTimes(2);
		await advance(1);
		expect(read).toHaveBeenCalledTimes(3);
	});

	it("skips polls while the window is hidden and reads when it comes back into view", async () => {
		await mount();
		setVisibility("hidden");
		await advance(USAGE_POLL_MS * 3);
		expect(read).not.toHaveBeenCalled();
		setVisibility("visible");
		await act(async () => {
			document.dispatchEvent(new Event("visibilitychange"));
		});
		expect(read).toHaveBeenCalledTimes(1);
	});

	it("backs off after failed reads, ignores turn ends meanwhile, and resumes the interval after a success", async () => {
		read.mockResolvedValue(false);
		await mount();
		await advance(USAGE_POLL_MS);
		expect(read).toHaveBeenCalledTimes(1);
		// One failure: the next poll waits twice as long, and a turn end does not jump it.
		await act(async () => useUsageSignal.getState().turnEnded());
		await advance(USAGE_POLL_MS * 2 - 1);
		expect(read).toHaveBeenCalledTimes(1);
		await advance(1);
		expect(read).toHaveBeenCalledTimes(2);
		// Two failures: four intervals; a thrown read counts as a failure too.
		read.mockRejectedValueOnce(new Error("bridge gone"));
		await advance(USAGE_POLL_MS * 4);
		expect(read).toHaveBeenCalledTimes(3);
		read.mockResolvedValue(true);
		await advance(USAGE_POLL_MS * 8);
		expect(read).toHaveBeenCalledTimes(4);
		await advance(USAGE_POLL_MS);
		expect(read).toHaveBeenCalledTimes(5);
	});

	it("never overlaps reads: a nudge while one is in flight waits for it", async () => {
		let finish: (ok: boolean) => void = () => undefined;
		read.mockImplementation(() => new Promise<boolean>(resolve => (finish = resolve)));
		await mount();
		await advance(USAGE_POLL_MS);
		await act(async () => useUsageSignal.getState().turnEnded());
		expect(read).toHaveBeenCalledTimes(1);
		await act(async () => finish(true));
		await advance(USAGE_POLL_MS);
		expect(read).toHaveBeenCalledTimes(2);
	});
});

describe("inUseReport", () => {
	const limit = { id: "anthropic:5h", label: "Claude 5 Hour", usedFraction: 0.4 };
	const report = (credentialId: number, active?: boolean): UsageReport => ({
		provider: "anthropic",
		fetchedAt: 0,
		credentialId,
		limits: [limit],
		...(active ? { active } : {}),
	});

	it("is the session's account, else the first one with limits", () => {
		expect(inUseReport([report(1), report(2, true), report(3)], "anthropic")?.credentialId).toBe(2);
		expect(inUseReport([{ ...report(1), limits: [] }, report(3)], "anthropic")?.credentialId).toBe(3);
		expect(inUseReport([report(1)], "openai-codex")).toBeUndefined();
	});
});
