/**
 * The sidebar row's inline title editor: its auto button asks the omp of the tab that holds the session. A stored
 * session no tab has open has no omp to ask, so the button is inert and says why (and a click never reaches an omp).
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcCommand, RpcResponse } from "../../../../shared/rpc-types";
import { I18nProvider, translate } from "../../../lib/i18n";
import { useToastStore } from "../../../stores/toast";
import { SidebarRenameField } from "./SidebarRenameField";

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

const commandForTab = vi.fn(
	async (_tabId: string, _command: RpcCommand): Promise<RpcResponse> => ({
		type: "response",
		command: "regenerate_session_title",
		success: true,
		data: { title: "🐛 Fix login bug" },
	}),
);
Object.assign(window as unknown as Record<string, unknown>, { omp: { rpc: { commandForTab } } });

let root: Root | undefined;
const onCommit = vi.fn();
const onGenerated = vi.fn();

async function mount(tabId: string | undefined): Promise<Element> {
	root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<SidebarRenameField
					onCancel={() => {}}
					onChange={() => {}}
					onCommit={onCommit}
					onGenerated={onGenerated}
					tabId={tabId}
					value="Old title"
				/>
			</I18nProvider>,
		);
	});
	const button = document.querySelector("[data-auto-title]");
	if (!button) throw new Error("auto button missing");
	return button as unknown as Element;
}

beforeEach(() => {
	commandForTab.mockClear();
	onCommit.mockClear();
	onGenerated.mockClear();
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	useToastStore.setState({ toasts: [] });
});

describe("SidebarRenameField auto button", () => {
	it("asks the holding tab's omp, hands back the saved title, and never saves the draft over it on the way out", async () => {
		const button = await mount("tab-1");
		await act(async () => (button as unknown as HTMLElement).click());
		expect(commandForTab).toHaveBeenCalledExactlyOnceWith("tab-1", { type: "regenerate_session_title" });
		expect(onGenerated).toHaveBeenCalledExactlyOnceWith("🐛 Fix login bug");
		// A blur while the field unmounts must not commit the old draft as a typed name.
		await act(async () => {
			document.querySelector("input")?.dispatchEvent(new Event("focusout", { bubbles: true }));
		});
		expect(onCommit).not.toHaveBeenCalled();
	});

	it("is inert for a stored session no tab has open, and says why", async () => {
		const button = await mount(undefined);
		expect(button.getAttribute("aria-disabled")).toBe("true");
		expect(button.getAttribute("aria-label")).toBe(translate("titleAuto.needsTab"));
		await act(async () => (button as unknown as HTMLElement).click());
		expect(commandForTab).not.toHaveBeenCalled();
		expect(onGenerated).not.toHaveBeenCalled();
	});

	it("shows a failure under the field, not as a toast, and keeps the field", async () => {
		commandForTab.mockResolvedValueOnce({
			type: "response",
			command: "regenerate_session_title",
			success: true,
			data: { title: null, reason: "none" },
		});
		const button = await mount("tab-1");
		await act(async () => (button as unknown as HTMLElement).click());
		expect(document.body.textContent).toContain(translate("titleAuto.none"));
		expect(document.querySelector("input")?.getAttribute("aria-invalid")).toBe("true");
		expect(onGenerated).not.toHaveBeenCalled();
		expect(useToastStore.getState().toasts).toEqual([]);
	});
});
