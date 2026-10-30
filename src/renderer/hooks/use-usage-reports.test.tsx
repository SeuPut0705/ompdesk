import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { USAGE_POLL_MS, type UsageRead } from "../lib/usage-reports";
import { useSessionStore } from "../stores/session";
import { useTabsStore } from "../stores/tabs";
import { type UsageFeed, useUsage, useUsageRead, useUsageReports } from "./use-usage-reports";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const report = { provider: "anthropic", account: "me@example.com", limits: [] };
const getUsage = vi.fn(async () => ({ success: true, data: { reports: [report] } }));
const seen: Record<string, unknown> = {};

function Surface({ name }: { name: string }) {
	seen[name] = useUsageReports();
	return null;
}

let root: Root;

async function render(names: string[]): Promise<void> {
	await act(async () => root.render(names.map(name => <Surface key={name} name={name} />)));
}

beforeEach(() => {
	vi.useFakeTimers();
	getUsage.mockClear();
	Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
	Reflect.set(window, "omp", { rpc: { getUsage } });
	useTabsStore.setState({ activeTabId: "tab-1" });
	useSessionStore.setState({ status: "ready" });
	root = createRoot(document.createElement("div") as unknown as Element);
});

afterEach(async () => {
	await act(async () => root.unmount());
	vi.useRealTimers();
});

describe("useUsageReports", () => {
	it("reads once for every surface of a tab, however many mount, then keeps one poll for all of them", async () => {
		await render(["sidebar"]);
		expect(getUsage).toHaveBeenCalledTimes(1);
		expect(seen.sidebar).toEqual([report]);

		// The board mounts later (a tab switch mounts it after the sidebar): it shows the tab's reports and reads nothing.
		await render(["sidebar", "board"]);
		expect(getUsage).toHaveBeenCalledTimes(1);
		expect(seen.board).toBe(seen.sidebar);

		// One poll for both, and its reads show on both.
		const later = { ...report, account: "work@example.com" };
		getUsage.mockResolvedValueOnce({ success: true, data: { reports: [later] } });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(USAGE_POLL_MS);
		});
		expect(getUsage).toHaveBeenCalledTimes(2);
		expect(seen.board).toEqual([later]);
		expect(seen.sidebar).toBe(seen.board);

		// One surface leaves: the other keeps the poll.
		await render(["sidebar"]);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(USAGE_POLL_MS);
		});
		expect(getUsage).toHaveBeenCalledTimes(3);

		// The last one leaves: nothing polls, and the next mount (the tab shown again) reads afresh.
		await render([]);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(USAGE_POLL_MS * 3);
		});
		expect(getUsage).toHaveBeenCalledTimes(3);
		await render(["board"]);
		expect(getUsage).toHaveBeenCalledTimes(4);
	});

	it("counts only the schedule's reads, keeps the reports through a failed one, and shows a read made outside the poll", async () => {
		let feed: UsageFeed | undefined;
		let readOutside: ((refresh?: boolean) => Promise<UsageRead>) | undefined;
		function FeedSurface() {
			feed = useUsage(usage => usage);
			readOutside = useUsageRead();
			return null;
		}
		await act(async () => root.render(<FeedSurface />));
		expect(feed).toEqual({ reports: [report], error: null, polls: 0 });

		getUsage.mockResolvedValueOnce({ success: false, error: "bridge gone" } as never);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(USAGE_POLL_MS);
		});
		expect(feed).toEqual({ reports: [report], error: "bridge gone", polls: 1 });

		const later = { ...report, account: "work@example.com" };
		getUsage.mockResolvedValueOnce({ success: true, data: { reports: [later] } });
		await act(async () => {
			await readOutside?.(true);
		});
		expect(getUsage).toHaveBeenLastCalledWith(true);
		expect(feed).toEqual({ reports: [later], error: null, polls: 1 });
	});
});
