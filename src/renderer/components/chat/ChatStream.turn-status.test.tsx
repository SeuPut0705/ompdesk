import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemoteState } from "../../../shared/ipc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { useMessagesStore } from "../../stores/messages";
import { useRemoteStore } from "../../stores/remote";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { useToastStore } from "../../stores/toast";
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
const { ProcessGroup, STREAMING_WORK_ROW, TranscriptHistoryStatus, TurnStatusRow } = await import("./ChatStream");

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

	it("a turn waiting for the internet connection says so calmly and offers Cancel, not a failure", async () => {
		const cancelWait = vi.fn(async () => {});
		Object.assign(window, { omp: { resume: { cancelWait } } });
		useTabsStore.setState({
			activeTabId: "t1",
			tabs: [
				{ id: "t1", cwd: "/work", status: "ready", kind: "agent", unreadDone: false, awaitingConnection: true },
			],
		});
		await mount(<TurnStatusRow />);

		const row = container.querySelector("[data-connection-wait]");
		expect(row?.querySelector('[role="status"]')?.textContent).toBe("Waiting for the internet connection…");
		expect(container.querySelector(".omp-message-error")).toBeNull();
		const cancel = container.querySelector("button");
		expect(cancel?.textContent).toBe("Cancel");
		await act(async () => cancel?.click());
		expect(cancelWait).toHaveBeenCalledWith("t1");
		useTabsStore.setState({ activeTabId: null, tabs: [] });
	});

	it("a resuming tab shows one calm row with the Stop the old toast offered, no other indicator", async () => {
		const stop = vi.fn(async () => {});
		Object.assign(window, { omp: { resume: { stop } } });
		useTabsStore.setState({
			activeTabId: "t1",
			tabs: [{ id: "t1", cwd: "/work", status: "ready", kind: "agent", unreadDone: false, resuming: true }],
		});
		await mount(<TurnStatusRow />);

		expect(container.querySelectorAll("[data-resuming]")).toHaveLength(1);
		expect(container.querySelector('[role="status"]')?.textContent).toBe("Continuing where it left off…");
		expect(container.querySelector(".omp-message-error")).toBeNull();
		const buttons = container.querySelectorAll("button");
		expect(buttons).toHaveLength(1);
		expect(buttons[0]?.textContent).toBe("Stop");
		await act(async () => buttons[0]?.click());
		expect(stop).toHaveBeenCalledWith("t1");
		useTabsStore.setState({ activeTabId: null, tabs: [] });
	});

	it("a paired host's tab names the host whose connection it waits for, and a refused Cancel says so", async () => {
		const cancelWait = vi.fn(async () => {
			throw new Error("[remote_offline] The device running this tab is offline");
		});
		Object.assign(window, { omp: { resume: { cancelWait } } });
		useRemoteStore.setState({
			state: { hosts: [{ deviceId: "host-b", name: "Studio", state: "online" }] } as unknown as RemoteState,
		});
		useTabsStore.setState({
			activeTabId: "t1",
			tabs: [
				{
					id: "t1",
					cwd: "/work",
					status: "ready",
					kind: "agent",
					unreadDone: false,
					awaitingConnection: true,
					device: "host-b",
				},
			],
		});
		await mount(<TurnStatusRow />);

		const row = container.querySelector("[data-connection-wait]");
		expect(row?.querySelector('[role="status"]')?.textContent).toBe("Waiting for Studio's internet connection…");
		await act(async () => container.querySelector("button")?.click());
		expect(cancelWait).toHaveBeenCalledWith("t1");
		expect(useToastStore.getState().toasts.at(-1)?.title).toBe("Couldn't cancel the wait");
		useTabsStore.setState({ activeTabId: null, tabs: [] });
		useRemoteStore.getState().reset();
	});
});

describe("TranscriptHistoryStatus", () => {
	it("says the rows are the last known state while the live read answers, as a delayed fade-in note", async () => {
		await mount(<TranscriptHistoryStatus error={null} loading={false} onRetry={() => {}} updating />);
		const status = container.querySelector('[data-testid="transcript-history-status"]');
		expect(status?.textContent).toContain(translate("chat.history.updating"));
		expect(status?.className).toContain("omp-updating-hint");
		expect(container.querySelectorAll(".animate-spin")).toHaveLength(0);
	});

	it("says a failed page of earlier messages as an alert whose Retry loads it again", async () => {
		const onRetry = vi.fn();
		await mount(<TranscriptHistoryStatus error="disk read failed" loading={false} onRetry={onRetry} />);
		const status = container.querySelector('[data-testid="transcript-history-status"]');
		expect(status?.getAttribute("role")).toBe("alert");
		expect(status?.textContent).toContain(translate("chat.history.failed"));
		const retry = status?.querySelector("button");
		if (!retry) throw new Error("no Retry");
		await act(async () => (retry as unknown as HTMLButtonElement).click());
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it("is a still note while loading (no spinner, out of the flow), and nothing at all otherwise", async () => {
		await mount(<TranscriptHistoryStatus error={null} loading onRetry={() => {}} />);
		const status = container.querySelector('[data-testid="transcript-history-status"]');
		// A status, so a screen reader hears it, and no turning spinner.
		expect(status?.getAttribute("role")).toBe("status");
		expect(status?.querySelector("button")).toBeNull();
		expect(status?.textContent).toContain(translate("chat.history.loading"));
		expect(container.querySelectorAll(".animate-spin")).toHaveLength(0);
		expect(status?.className).toContain("absolute");
		await act(async () => {
			root.render(
				<I18nProvider>
					<TranscriptHistoryStatus error={null} loading={false} onRetry={() => {}} />
				</I18nProvider>,
			);
		});
		expect(container.querySelector('[data-testid="transcript-history-status"]')).toBeNull();
	});
});
