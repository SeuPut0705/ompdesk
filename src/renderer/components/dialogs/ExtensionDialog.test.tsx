import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { ExtensionUIResponse } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useExtensionUiStore } from "../../stores/extension-ui";
import { AskDockSlot } from "./ask-dock";
import { ExtensionDialog } from "./ExtensionDialog";

const { document, window, Event, CustomEvent, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.CustomEvent = CustomEvent;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};

interface TestElement {
	textContent: string | null;
	remove(): void;
	dispatchEvent(event: object): boolean;
}

let container: TestElement;
let root: Root;
let respondExtensionUi: Mock<(response: ExtensionUIResponse) => void>;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount({ withComposerDock = false }: { withComposerDock?: boolean } = {}): Promise<void> {
	respondExtensionUi = vi.fn();
	const ompWindow = window as unknown as { omp: { ui: { respondExtensionUi: typeof respondExtensionUi } } };
	ompWindow.omp = { ui: { respondExtensionUi } };
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				{withComposerDock && <AskDockSlot />}
				<ExtensionDialog />
			</I18nProvider>,
		);
	});
}

function buttonWithText(text: string): TestElement | undefined {
	const buttons = Array.from(document.querySelectorAll("button")) as unknown as TestElement[];
	return buttons.find(button => button.textContent?.includes(text));
}

async function click(element: TestElement): Promise<void> {
	await act(async () => {
		element.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
	});
	await flush();
}

function showAskDialog(): void {
	useExtensionUiStore.getState().pushRequest({
		type: "extension_ui_request",
		id: "ask-1",
		method: "ask",
		questions: [
			{
				id: "deploy",
				question: "Where should this deploy?",
				options: [
					{ label: "Staging", description: "Safe environment" },
					{ label: "Production", preview: "Deploys to **all users**." },
				],
				recommended: 0,
			},
		],
	});
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	useExtensionUiStore.getState().clearAll();
	vi.restoreAllMocks();
	document.title = "";
});

describe("ExtensionDialog select", () => {
	it("shows positional descriptions without including them in the returned choice", async () => {
		await mount();
		await act(async () => {
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "select-details",
				method: "select",
				title: "Choose a connection",
				options: ["API key", "Subscription"],
				optionDetails: [{}, { description: "Sign in with your existing subscription" }],
			});
		});
		const apiKey = buttonWithText("API key");
		const subscription = buttonWithText("Subscription");
		if (!apiKey || !subscription) throw new Error("missing connection choices");
		expect(apiKey.textContent).not.toContain("existing subscription");
		expect(subscription.textContent).toContain("Sign in with your existing subscription");
		await click(subscription);
		expect(respondExtensionUi).toHaveBeenCalledWith({
			type: "extension_ui_response",
			id: "select-details",
			value: "Subscription",
		});
	});
});

describe("ExtensionDialog ask", () => {
	it("answers one entry per question and renders the selected option preview", async () => {
		await mount();
		await act(async () => showAskDialog());

		const production = buttonWithText("Production");
		if (!production) throw new Error("missing Production option");
		await click(production);
		expect(document.body.textContent).toContain("Deploys to all users.");

		const form = document.querySelector("form") as unknown as TestElement | null;
		if (!form) throw new Error("missing ask form");
		await act(async () => {
			form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});
		await flush();

		expect(respondExtensionUi).toHaveBeenCalledWith({
			type: "extension_ui_response",
			id: "ask-1",
			answers: [{ id: "deploy", selectedOptions: ["Production"], customInput: undefined }],
		});
	});

	it("reports the chat redirect as a cancel (stock ask has no chat answer)", async () => {
		await mount();
		await act(async () => showAskDialog());

		const chat = buttonWithText("Chat about this");
		if (!chat) throw new Error("missing Chat about this button");
		await click(chat);

		expect(respondExtensionUi).toHaveBeenCalledWith({
			type: "extension_ui_response",
			id: "ask-1",
			cancelled: true,
		});
	});

	it("docks above the composer as a non-modal card: no scrim, no dialog role, Escape cancels", async () => {
		await mount({ withComposerDock: true });
		await act(async () => showAskDialog());

		const dock = document.querySelector(".omp-ask-dock");
		const card = dock?.querySelector("section");
		if (!card) throw new Error("ask card not rendered inside the composer dock");
		expect(card.querySelector("form")).not.toBeNull();
		expect(document.querySelector(".omp-dialog-overlay")).toBeNull();
		expect(document.querySelector('[role="dialog"]')).toBeNull();

		const keydown = new Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(keydown, { key: "Escape" });
		await act(async () => {
			(card as unknown as TestElement).dispatchEvent(keydown);
		});
		await flush();

		expect(respondExtensionUi).toHaveBeenCalledWith({
			type: "extension_ui_response",
			id: "ask-1",
			cancelled: true,
		});
	});
});

describe("ExtensionDialog non-dialog mutations", () => {
	it("hides transient extension status and renders widget ANSI without control codes", async () => {
		await mount();
		await act(async () => {
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "status-ansi",
				method: "setStatus",
				statusKey: "mode",
				statusText: "\x1b[38;5;39m●\x1b[39m ponytail: \x1b[1mFULL\x1b[0m",
			});
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "widget-ansi",
				method: "setWidget",
				widgetKey: "progress",
				widgetLines: ["\x1b[32mPASS\x1b[0m"],
			});
		});

		expect(document.body.textContent).not.toContain("ponytail");
		expect(document.body.textContent).toContain("PASS");
		expect(document.body.textContent).not.toContain("[32m");
	});

	it("fills the composer for set_editor_text and applies extension window titles", async () => {
		await mount();
		let editorDetail: { text?: string; images?: unknown[]; prepend?: boolean } | undefined;
		window.addEventListener(
			"omp:fill-composer",
			(event: Event) => {
				editorDetail = (event as CustomEvent<{ text?: string; images?: unknown[]; prepend?: boolean }>).detail;
			},
			{ once: true },
		);

		await act(async () => {
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "editor-1",
				method: "set_editor_text",
				text: "restored draft",
				images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
				prepend: true,
			});
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "title-1",
				method: "setTitle",
				title: "Extension task",
			});
		});
		await flush();

		expect(editorDetail).toEqual({
			text: "restored draft",
			images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
			prepend: true,
		});
		expect(document.title).toBe("Extension task");
		expect(useExtensionUiStore.getState().pendingRequests).toEqual([]);
	});
});
