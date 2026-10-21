/**
 * A shortcut pressed while the active tab's route moves runs once it lands, in order, and is dropped when it never
 * lands: never dropped at once, never run against the outgoing route.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	beginTabRoute,
	openingTab,
	ROUTE_WAIT_MS,
	resetTabRoute,
	settleTabRoute,
	waitForActiveTab,
} from "./tab-routing";

afterEach(() => {
	resetTabRoute();
	vi.useRealTimers();
});

describe("waitForActiveTab", () => {
	it("lets the caller run at once while the route is in place", () => {
		const run = vi.fn();
		expect(waitForActiveTab(run)).toBe(false);
		expect(run).not.toHaveBeenCalled();
	});

	it("holds keys pressed while a new tab's route moves and runs them in order once it lands", () => {
		beginTabRoute("a", "b");
		const ran: string[] = [];
		expect(waitForActiveTab(() => ran.push("w"))).toBe(true);
		waitForActiveTab(() => ran.push("1"));
		expect(ran).toEqual([]);
		settleTabRoute("b");
		expect(ran).toEqual(["w", "1"]);
		// Nothing left waiting: the next key runs at once.
		expect(waitForActiveTab(() => ran.push("2"))).toBe(false);
	});

	it("drops them when the route never lands", () => {
		vi.useFakeTimers();
		beginTabRoute("a", "b");
		const run = vi.fn();
		waitForActiveTab(run);
		vi.advanceTimersByTime(ROUTE_WAIT_MS);
		settleTabRoute("b");
		expect(run).not.toHaveBeenCalled();
	});

	it("holds a command given while a new tab opens until it is in and routed, so it never reaches the tab being left", async () => {
		const opened = Promise.withResolvers<string>();
		openingTab(opened.promise);
		const ran: string[] = [];
		expect(waitForActiveTab(() => ran.push("w"))).toBe(true);
		beginTabRoute("a", "b");
		opened.resolve("b");
		// Every promise step after the open settled.
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(ran).toEqual([]);
		settleTabRoute("b");
		expect(ran).toEqual(["w"]);
	});
});
