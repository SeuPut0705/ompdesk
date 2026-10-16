/**
 * PathLink: opens through main for its tab; a remote tab's file (refused with
 * `remote_path_native`) opens in the in-app file preview instead of toasting.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IpcOpenPathResult } from "../../../../shared/ipc-types";
import { I18nProvider } from "../../../lib/i18n";
import { setFocusedSessionRuntime } from "../../../stores/session-runtime-context";
import { useToastStore } from "../../../stores/toast";
import { useUiStore } from "../../../stores/ui";
import { PathLink } from "./PathLink";

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

const openPath = vi.fn(async (_path: string, _tabId?: string): Promise<IpcOpenPathResult> => ({ ok: true }));
Object.assign(window as unknown as Record<string, unknown>, { omp: { system: { openPath } } });

let root: Root | null = null;

async function clickLink(path: string): Promise<void> {
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<PathLink path={path} />
			</I18nProvider>,
		);
	});
	const button = document.body.querySelector("button") as unknown as HTMLButtonElement;
	await act(async () => button.click());
	await act(async () => {
		await Promise.resolve();
	});
}

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	setFocusedSessionRuntime(null);
	useUiStore.getState().closeFilePreview();
	useToastStore.setState({ toasts: [] });
	vi.clearAllMocks();
});

describe("PathLink", () => {
	it("opens the file natively for its tab", async () => {
		setFocusedSessionRuntime("t-local");
		await clickLink("src/app.ts");

		expect(openPath).toHaveBeenCalledWith("src/app.ts", "t-local");
		expect(useUiStore.getState().filePreviewPath).toBeNull();
		expect(useToastStore.getState().toasts).toHaveLength(0);
	});

	it("falls back to the in-app preview for a remote tab's file", async () => {
		setFocusedSessionRuntime("t-remote");
		openPath.mockResolvedValueOnce({ ok: false, code: "remote_path_native", error: "remote path" });
		await clickLink("/Users/kim/code/app/src/app.ts");

		expect(openPath).toHaveBeenCalledWith("/Users/kim/code/app/src/app.ts", "t-remote");
		expect(useUiStore.getState().filePreviewPath).toBe("/Users/kim/code/app/src/app.ts");
		expect(useUiStore.getState().panelTab).toBe("files");
		expect(useToastStore.getState().toasts).toHaveLength(0);
	});

	it("still toasts other failures", async () => {
		openPath.mockResolvedValueOnce({ ok: false, error: "missing" });
		await clickLink("gone.ts");

		expect(useUiStore.getState().filePreviewPath).toBeNull();
		expect(useToastStore.getState().toasts).toHaveLength(1);
	});
});
