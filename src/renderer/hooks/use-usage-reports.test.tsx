import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { USAGE_POLL_MS } from "../lib/usage-reports";
import { useSessionStore } from "../stores/session";
import { useTabsStore } from "../stores/tabs";
import { useUsageReports } from "./use-usage-reports";

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
	it("serves every surface of one tab from a single read and a single poll", async () => {
		await render(["sidebar", "board"]);
		expect(getUsage).toHaveBeenCalledTimes(1);
		expect(seen.sidebar).toEqual([report]);
		expect(seen.board).toBe(seen.sidebar);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(USAGE_POLL_MS);
		});
		expect(getUsage).toHaveBeenCalledTimes(2);

		// One surface leaves: the other keeps the poll.
		await render(["sidebar"]);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(USAGE_POLL_MS);
		});
		expect(getUsage).toHaveBeenCalledTimes(3);

		// The last one leaves: nothing polls, and the next mount reads afresh.
		await render([]);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(USAGE_POLL_MS * 3);
		});
		expect(getUsage).toHaveBeenCalledTimes(3);
		await render(["board"]);
		expect(getUsage).toHaveBeenCalledTimes(4);
	});
});
