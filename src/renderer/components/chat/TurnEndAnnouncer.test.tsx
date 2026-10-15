import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useMessagesStore } from "../../stores/messages";
import { useSessionStore } from "../../stores/session";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

// Loaded after the linkedom globals exist: react-dom reads `window`/`document` at import.
const { createRoot } = await import("react-dom/client");
const { TurnEndAnnouncer } = await import("./TurnEndAnnouncer");

let container: HTMLElement;
let root: Root;

async function mount(): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<TurnEndAnnouncer />
			</I18nProvider>,
		);
	});
}

/** Run one turn that ends with this assistant message. */
async function turn(end: Partial<AgentMessage>): Promise<string> {
	await act(async () => useSessionStore.setState({ isStreaming: true }));
	expect(container.textContent).toBe("");
	await act(async () => {
		useMessagesStore.setState({ messages: [{ role: "assistant", content: [], ...end } as AgentMessage] });
		useSessionStore.setState({ isStreaming: false });
	});
	return String(container.textContent);
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	useSessionStore.getState().reset();
	useMessagesStore.getState().reset();
});

describe("TurnEndAnnouncer", () => {
	it("says nothing on mount, then how each turn ended", async () => {
		await mount();
		expect(container.querySelector('[role="status"][aria-live="polite"]')).not.toBeNull();
		expect(container.textContent).toBe("");
		expect(await turn({ stopReason: "stop" } as Partial<AgentMessage>)).toBe("Response complete");
		expect(await turn({ stopReason: "aborted" } as Partial<AgentMessage>)).toBe("Response stopped");
		expect(
			await turn({ stopReason: "error", errorMessage: "429 Too Many Requests" } as Partial<AgentMessage>),
		).toMatch(/^Response failed: /);
	});
});
