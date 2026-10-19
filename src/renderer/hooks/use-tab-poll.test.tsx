import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useTabsStore } from "../stores/tabs";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});
Reflect.set(window, "omp", { rpc: {} });

// Imported after the DOM globals above exist (react-dom reads them when it loads).
const { createRoot } = await import("react-dom/client");
const { TabPoll, useTabPoll, useTabPollPeek } = await import("./use-tab-poll");

let container: HTMLElement;
let root: Root;

afterEach(async () => {
	await act(async () => root.unmount());
	useTabsStore.getState().reset();
});

/** A poll whose every start publishes `value` once; nothing else re-reads it. */
function pollOf(value: number) {
	return new TabPoll<number>(0, (_rpc, publish) => {
		publish(() => value);
		return { read: () => {}, stop: () => {} };
	});
}

describe("useTabPollPeek", () => {
	it("shows a tab's value only while some surface of that tab polls it", async () => {
		useTabsStore.setState({ activeTabId: "t1" });
		const poll = pollOf(3);
		function Poller() {
			useTabPoll(poll, true, value => value);
			return null;
		}
		function Peek() {
			return <span data-peek>{useTabPollPeek(poll, "t1", value => value)}</span>;
		}
		const render = (polling: boolean) => (
			<>
				<Peek />
				{polling && <Poller />}
			</>
		);
		container = document.createElement("div") as unknown as HTMLElement;
		root = createRoot(container as unknown as Element);
		const peeked = () => container.querySelector("[data-peek]")?.textContent;

		await act(async () => root.render(render(false)));
		expect(peeked()).toBe("0");
		await act(async () => root.render(render(true)));
		expect(peeked()).toBe("3");
		// The pane that polled it is gone: the last value is nobody's fact any more (a shell that was running).
		await act(async () => root.render(render(false)));
		expect(peeked()).toBe("0");
	});
});
