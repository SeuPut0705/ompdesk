/** The web page tells the computer which tab's Files editor holds unsaved edits (FileEditReporter.tsx). */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTabsStore } from "../stores/tabs";
import { useUiStore } from "../stores/ui";
import { FileEditReporter } from "./FileEditReporter";
import { setWebRuntime } from "./runtime";
import type { WsConnectionState } from "./ws-transport";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

// After the DOM globals: react-dom reads `document`/`window` when it loads.
const { createRoot } = await import("react-dom/client");

let root: Root | undefined;

async function mount(element: ReactElement): Promise<void> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () => root?.render(element));
}

const reportFileEdits = vi.fn(async (_dirtyTabId: string | null): Promise<void> => undefined);
(window as unknown as { omp: unknown }).omp = { tabs: { reportFileEdits } };

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	reportFileEdits.mockClear();
	useUiStore.setState({ fileEditDirty: false, fileEditTabId: null });
	useTabsStore.getState().reset();
});

describe("FileEditReporter", () => {
	it("reports nothing in the desktop app", async () => {
		useUiStore.setState({ fileEditDirty: true, fileEditTabId: "t1" });
		await mount(<FileEditReporter />);
		expect(reportFileEdits).not.toHaveBeenCalled();
	});

	it("reports the editor's tab on change, and again on every (re)connect", async () => {
		let onState: ((state: WsConnectionState) => void) | undefined;
		setWebRuntime({
			host: {} as never,
			connectionState: () => "open",
			onConnectionState: listener => {
				onState = listener;
				return () => {
					onState = undefined;
				};
			},
			features: () => null,
			emitMenuAction: () => {},
			onResynced: () => () => {},
			reload: () => {},
			requestNotifications: async () => "granted" as const,
		});
		await mount(<FileEditReporter />);
		expect(reportFileEdits.mock.calls).toEqual([[null]]);

		await act(async () => useUiStore.setState({ fileEditDirty: true, fileEditTabId: "t1" }));
		expect(reportFileEdits).toHaveBeenLastCalledWith("t1");

		// The panel has not named the owner yet: the edits are the focused tab's.
		await act(async () => {
			useTabsStore.setState({ activeTabId: "t0" });
			useUiStore.setState({ fileEditTabId: null });
		});
		expect(reportFileEdits).toHaveBeenLastCalledWith("t0");

		await act(async () => useUiStore.setState({ fileEditDirty: false, fileEditTabId: null }));
		expect(reportFileEdits).toHaveBeenLastCalledWith(null);

		const before = reportFileEdits.mock.calls.length;
		onState?.("reconnecting" as WsConnectionState);
		expect(reportFileEdits.mock.calls).toHaveLength(before);
		onState?.("open");
		expect(reportFileEdits.mock.calls).toHaveLength(before + 1);
		expect(reportFileEdits).toHaveBeenLastCalledWith(null);
	});
});
