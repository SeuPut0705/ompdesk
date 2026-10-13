import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { useMessagesStore } from "../../stores/messages";
import { useSessionStore } from "../../stores/session";
import { useUiStore } from "../../stores/ui";

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
Object.assign(window, {
	matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	requestAnimationFrame: () => 0,
	cancelAnimationFrame: () => {},
});

const { createRoot } = await import("react-dom/client");
const { ProcessGroup, STREAMING_WORK_ROW, TurnStatusRow } = await import("./ChatStream");

let container: HTMLElement;
let root: Root;

async function mount(node: ReactNode): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{node}</I18nProvider>);
	});
}

/** The wrappers from the card up to the row: equal chains put both cards in the same place. */
function frameOf(card: Element | null | undefined): string[] {
	const chain: string[] = [];
	for (
		let element = card?.parentElement;
		element && element !== (container as unknown);
		element = element.parentElement
	)
		chain.push(`${element.tagName}.${element.className}`);
	return chain;
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	useSessionStore.getState().reset();
	useMessagesStore.setState({ streamingMessage: null, streamingThinking: "" });
});

describe("TurnStatusRow", () => {
	it("a normal wait is the work card's own head, announced once for screen readers", async () => {
		useSessionStore.setState({ awaitingModelSince: Date.now() - 5_000 });
		await mount(<TurnStatusRow />);

		const status = container.querySelector('[role="status"]');
		expect(status?.textContent).toBe("Waiting for model response…");
		expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
		const card = container.querySelector(".omp-live-step[data-pending]");
		expect(card?.querySelector(".omp-work-narrative")?.textContent).toBe("Thinking…");
		// No bare spinner before the card: the head is already there.
		expect(container.querySelectorAll(".animate-spin")).toHaveLength(0);
	});

	it("mounts the pending card in the same frame the streaming work card takes over", async () => {
		useSessionStore.setState({ awaitingModelSince: Date.now() - 5_000 });
		useUiStore.setState({ transcriptDetail: "compact" });
		await mount(<TurnStatusRow />);
		const pending = frameOf(container.querySelector(".omp-live-step"));
		await act(async () => root.unmount());
		container.remove();
		useMessagesStore.setState({
			streamingMessage: { role: "assistant", content: [], timestamp: Date.now() },
			streamingThinking: "Planning the first step.",
		});
		await mount(
			<ProcessGroup
				expanded={false}
				live
				onExpandedChange={() => {}}
				row={STREAMING_WORK_ROW}
				rowKey="message-live"
				streaming
			/>,
		);
		const streaming = frameOf(container.querySelector(".omp-live-step"));
		expect(streaming.length).toBeGreaterThan(0);
		expect(pending).toEqual(streaming);
	});

	it("renders nothing when the wait rides on the turn's last work row", async () => {
		useSessionStore.setState({ awaitingModelSince: Date.now() - 5_000 });
		await mount(<TurnStatusRow attached />);
		expect(container.childElementCount).toBe(0);
	});

	it("a long wait stays the plain pending head: no elapsed clock, warning, or recovery buttons", async () => {
		useSessionStore.setState({ awaitingModelSince: Date.now() - 1_013_000 });
		await mount(<TurnStatusRow />);
		expect(container.querySelector(".omp-work-head-clock")).toBeNull();
		expect(container.textContent).not.toMatch(/\d+s/);
		expect(container.querySelector("button")).toBeNull();
	});
});
