/**
 * The tab strip's single status glyph, shared by the chip, the sidebar, and the
 * close rules. What a tab looks like while it is NOT running matters as much as
 * while it is: a restored session shows several of these at once, before any of
 * them has a process.
 */

import { describe, expect, it } from "vitest";
import type { SessionTab } from "../stores/tabs";
import { isSessionHeld, isTabFailed, tabSignalPresentation } from "./tab-signal";

function tab(overrides: Partial<SessionTab>): SessionTab {
	return { kind: "agent", id: "a", cwd: "/work/a", status: "ready", unreadDone: false, ...overrides };
}

describe("tabSignalPresentation", () => {
	it("pulses only for work that is actually in flight", () => {
		expect(tabSignalPresentation(tab({ status: "running" })).running).toBe(true);
		expect(tabSignalPresentation(tab({ status: "ready", compacting: true })).active).toBe(true);
		expect(tabSignalPresentation(tab({ status: "ready" })).active).toBe(false);
	});

	it("marks a never-spawned restored tab inert instead of booting", () => {
		// "starting" pulses a warning dot; a deferred tab has nothing coming up
		// until it is shown, so a strip full of warning dots would be a lie.
		expect(tabSignalPresentation(tab({ status: "asleep" }))).toEqual({
			active: false,
			color: "var(--omp-dim)",
			labelKey: "titlebar.status.asleep",
			running: false,
		});
		expect(tabSignalPresentation(tab({ status: "starting" })).active).toBe(true);
	});

	it("shows a session another omp still holds as a wait, not a failure", () => {
		expect(tabSignalPresentation(tab({ status: "error", sessionHeld: true }))).toEqual({
			active: true,
			color: "var(--omp-warning)",
			labelKey: "titlebar.status.sessionHeld",
			running: false,
		});
		expect(tabSignalPresentation(tab({ status: "error" })).labelKey).toBe("titlebar.status.error");
	});

	it("tells a held session from a failed one, the rule every surface reads", () => {
		expect([
			isSessionHeld({ status: "error", sessionHeld: true }),
			isTabFailed({ status: "error", sessionHeld: true }),
		]).toEqual([true, false]);
		expect([isSessionHeld({ status: "error" }), isTabFailed({ status: "error" })]).toEqual([false, true]);
		// A stale flag on a tab that is no longer failing says nothing.
		expect([isSessionHeld({ status: "ready", sessionHeld: true }), isTabFailed({ status: "ready" })]).toEqual([
			false,
			false,
		]);
	});

	it("keeps a finished background run readable over the idle state", () => {
		expect(tabSignalPresentation(tab({ status: "ready", unreadDone: true })).labelKey).toBe("tabs.done");
	});

	it("flags a tab waiting on the user over its run, without hiding that it is still running", () => {
		const waiting = tabSignalPresentation(tab({ status: "running", awaitingInput: "input" }));
		// A question is not an approval: the question word, the approval word only for approvals.
		expect(waiting.labelKey).toBe("attention.question");
		expect(tabSignalPresentation(tab({ status: "running", awaitingInput: "approval" })).labelKey).toBe(
			"attention.approval",
		);
		// ⌘W's confirm reads `running`: a blocked run is still a run.
		expect(waiting.running).toBe(true);
		expect(tabSignalPresentation(tab({ status: "ready", awaitingInput: "input" })).active).toBe(true);
	});

	it("shows a tab whose turn waits for the connection as a wait, never as an idle tab (tab strip, sidebar row, a paired device's row)", () => {
		expect(tabSignalPresentation(tab({ status: "ready", awaitingConnection: true }))).toEqual({
			active: true,
			color: "var(--omp-warning)",
			labelKey: "titlebar.status.connectionWait",
			running: false,
		});
		// A relaunch's continuation held offline, its tab's omp not started yet.
		expect(tabSignalPresentation(tab({ status: "asleep", awaitingConnection: true })).labelKey).toBe(
			"titlebar.status.connectionWait",
		);
		// Its own state, a question or a run that began meanwhile still outranks the wait.
		expect(tabSignalPresentation(tab({ status: "error", awaitingConnection: true })).labelKey).toBe(
			"titlebar.status.error",
		);
		expect(tabSignalPresentation(tab({ status: "running", awaitingConnection: true })).labelKey).toBe(
			"titlebar.status.working",
		);
		expect(
			tabSignalPresentation(tab({ status: "ready", awaitingConnection: true, awaitingInput: "input" })).labelKey,
		).toBe("attention.question");
		// No wait, no signal: the tab stays as idle as before.
		expect(tabSignalPresentation(tab({ status: "ready" })).active).toBe(false);
	});
});
