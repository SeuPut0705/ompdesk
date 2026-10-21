/**
 * useSubagentRosterPoll: polls get_subagents while a turn streams and a live
 * agent exists (parked/idle transitions emit no wire frame, so the store goes
 * stale mid-run without it).
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { SubagentSnapshot } from "../../shared/rpc-types";
import { resetTabRoute } from "../lib/tab-routing";
import { useSessionStore } from "../stores/session";
import { setFocusedSessionRuntime } from "../stores/session-runtime-context";
import { useSubagentsStore } from "../stores/subagents";
import { useTabsStore } from "../stores/tabs";
import { routeCommands } from "../test-support/route-commands";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

// Deferred until after the globals above: react-dom computes DOM support
// flags at evaluation time.
const { createRoot } = await import("react-dom/client");
const { useSubagentRosterPoll } = await import("./use-subagent-roster-poll");

import type { PollSchedule } from "./use-subagent-roster-poll";

const getSubagents: Mock = vi.fn(async () => ({
	type: "response",
	command: "get_subagents",
	success: true,
	data: { subagents: [] },
}));
// Window carries the omp bridge at runtime; named cast keeps the mock wiring typed.
const ompWindow = window as unknown as { omp: { rpc: { getSubagents: Mock } } };
ompWindow.omp = { rpc: routeCommands({ getSubagents }) };

function snap(overrides: Partial<SubagentSnapshot>): SubagentSnapshot {
	return { id: "a1", index: 1, agent: "scout", status: "running", lastUpdate: Date.now(), ...overrides };
}

// A hand-driven schedule: `tick()` runs every active poll once; `ticks` holds the active ones.
const ticks = new Set<() => void>();
const manualSchedule: PollSchedule = tick => {
	ticks.add(tick);
	return () => ticks.delete(tick);
};
function tick(): void {
	for (const run of ticks) run();
}

function Poller() {
	useSubagentRosterPoll(25, manualSchedule);
	return null;
}

let container: HTMLElement;
let root: Root;

async function mount(): Promise<void> {
	useTabsStore.setState({
		tabs: [{ id: "t1", cwd: "/w", status: "ready", kind: "agent", unreadDone: false }],
		activeTabId: "t1",
		bundles: new Map(),
	});
	useSessionStore.setState({ sessionId: "s1" });
	resetTabRoute();
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<Poller />);
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	getSubagents.mockClear();
	ticks.clear();
	setFocusedSessionRuntime(null);
	useSubagentsStore.getState().reset();
	useSessionStore.setState({ isStreaming: false });
	useTabsStore.getState().reset();
	resetTabRoute();
});

describe("useSubagentRosterPoll", () => {
	it("polls get_subagents while streaming, stops when the turn ends", async () => {
		useSubagentsStore.getState().setSnapshots([snap({ id: "a1", status: "running" })]);
		useSessionStore.setState({ isStreaming: true });
		await mount();
		expect(getSubagents).not.toHaveBeenCalled();
		await act(async () => tick());
		expect(getSubagents).toHaveBeenCalledTimes(1);

		// Turn ends → the poll stops, no further calls.
		await act(async () => useSessionStore.setState({ isStreaming: false }));
		expect(ticks.size).toBe(0);
		await act(async () => tick());
		expect(getSubagents).toHaveBeenCalledTimes(1);
	});

	it("does not poll while streaming when no agent is live", async () => {
		useSubagentsStore.getState().setSnapshots([snap({ id: "a1", status: "completed" })]);
		useSessionStore.setState({ isStreaming: true });
		await mount();
		expect(ticks.size).toBe(0);
		await act(async () => tick());
		// A finished roster has nothing frame-less to catch up on; a new spawn
		// arrives as a lifecycle frame and starts the poll.
		expect(getSubagents).not.toHaveBeenCalled();

		await act(async () => {
			useSubagentsStore.getState().applyFrame({
				type: "subagent_lifecycle",
				payload: { id: "a2", index: 2, agent: "scout", agentSource: "bundled", status: "started" },
			});
		});
		await act(async () => tick());
		expect(getSubagents).toHaveBeenCalledTimes(1);
	});

	it("asks nothing while the window is hidden and catches up once when it shows", async () => {
		let visibility: DocumentVisibilityState = "hidden";
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
		try {
			useSubagentsStore.getState().setSnapshots([snap({ id: "a1", status: "running" })]);
			useSessionStore.setState({ isStreaming: true });
			await mount();
			await act(async () => tick());
			await act(async () => tick());
			expect(getSubagents).not.toHaveBeenCalled();

			visibility = "visible";
			await act(async () => {
				document.dispatchEvent(new Event("visibilitychange"));
			});
			expect(getSubagents).toHaveBeenCalledTimes(1);
		} finally {
			Reflect.deleteProperty(document, "visibilityState");
		}
	});
});
