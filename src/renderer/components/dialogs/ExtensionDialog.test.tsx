import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { ExtensionUIResponse } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useExtensionUiStore } from "../../stores/extension-ui";
import { AskDockSlot } from "./ask-dock";
import { ExtensionDialog } from "./ExtensionDialog";

const { document, window, Event, CustomEvent, HTMLElement, HTMLTextAreaElement, Node } =
	parseHTML("<html><body></body></html>");
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
// linkedom's textarea lacks `defaultValue` (per spec, its text content), which
// React writes the initial value through.
if (!("defaultValue" in HTMLTextAreaElement.prototype)) {
	Object.defineProperty(HTMLTextAreaElement.prototype, "defaultValue", {
		configurable: true,
		get(this: { textContent: string }) {
			return this.textContent;
		},
		set(this: { textContent: string }, value: string) {
			this.textContent = value;
		},
	});
}
// React snapshots `isInputEventSupported` at module load via `"oninput" in
// document`; without it, keys in a textarea take the IE propertychange polyfill.
Object.defineProperty(document, "oninput", { value: null, writable: true, configurable: true });

// Deferred until after the globals above: react-dom-client computes its DOM
// support flags (canUseDOM, isInputEventSupported) at evaluation time.
const { createRoot } = await import("react-dom/client");

interface TestElement {
	textContent: string | null;
	remove(): void;
	dispatchEvent(event: object): boolean;
}

let container: TestElement;
let root: Root;
let respondExtensionUi: Mock<(response: ExtensionUIResponse) => void>;
let openExternal: Mock<(url: string) => Promise<void>>;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount({ withComposerDock = false }: { withComposerDock?: boolean } = {}): Promise<void> {
	respondExtensionUi = vi.fn();
	openExternal = vi.fn(async () => {});
	const ompWindow = window as unknown as {
		omp: {
			ui: { respondExtensionUi: typeof respondExtensionUi };
			system: { openExternal: typeof openExternal };
		};
	};
	ompWindow.omp = { ui: { respondExtensionUi }, system: { openExternal } };
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

	it("walks one question at a time: picking moves on, digits pick, the last step submits every answer", async () => {
		await mount({ withComposerDock: true });
		await act(async () =>
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "ask-steps",
				method: "ask",
				questions: [
					{
						id: "env",
						header: "Target",
						question: "Where should this deploy?",
						options: [{ label: "Staging" }, { label: "Production" }],
					},
					{ id: "tests", question: "Run the tests first?", options: [{ label: "Yes" }, { label: "No" }] },
				],
			}),
		);
		const card = () => document.querySelector("[data-prompt-card]") as unknown as TestElement & Element;
		// Only the current question is on screen.
		expect(card().textContent).toContain("Where should this deploy?");
		expect(card().textContent).not.toContain("Run the tests first?");
		expect(buttonWithText("Submit")).toBeUndefined();

		const production = buttonWithText("Production");
		if (!production) throw new Error("missing Production option");
		await click(production);
		expect(card().textContent).toContain("Run the tests first?");
		expect(card().querySelector('[data-ask-step="0"] svg')).not.toBeNull();

		// "2" picks the second option of the current question.
		const two = new Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(two, { key: "2" });
		await act(async () => {
			card().dispatchEvent(two);
		});
		await flush();
		expect(respondExtensionUi).not.toHaveBeenCalled();

		const submit = buttonWithText("Submit");
		if (!submit) throw new Error("the last step offers Submit");
		const form = card().querySelector("form") as unknown as TestElement;
		await act(async () => {
			form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});
		await flush();
		expect(respondExtensionUi).toHaveBeenCalledWith({
			type: "extension_ui_response",
			id: "ask-steps",
			answers: [
				{ id: "env", selectedOptions: ["Production"], customInput: undefined },
				{ id: "tests", selectedOptions: ["No"], customInput: undefined },
			],
		});
	});
});

describe("ExtensionDialog docked prompts", () => {
	it("shows a confirm above the composer with numbered choices; 1 approves", async () => {
		await mount({ withComposerDock: true });
		await act(async () =>
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "confirm-1",
				method: "confirm",
				title: "Deploy to staging?",
				message: "The agent wants to run the deploy script.",
			}),
		);
		const card = document.querySelector(".omp-ask-dock [data-prompt-card]") as unknown as TestElement | null;
		if (!card) throw new Error("confirm is not docked above the composer");
		expect(document.querySelector(".omp-dialog-overlay")).toBeNull();
		const one = new Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(one, { key: "1" });
		await act(async () => {
			card.dispatchEvent(one);
		});
		await flush();
		expect(respondExtensionUi).toHaveBeenCalledWith({
			type: "extension_ui_response",
			id: "confirm-1",
			confirmed: true,
		});
	});

	it("keeps the full approval operation visible, never focuses Approve, and Escape denies", async () => {
		await mount({ withComposerDock: true });
		const operation = `${"x".repeat(2200)}\ncritical final argument`;
		await act(async () =>
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "approval",
				method: "select",
				title: `Allow tool: bash\n${operation}`,
				options: ["Approve", "Deny"],
			}),
		);
		const card = document.querySelector(".omp-ask-dock [data-prompt-card]") as unknown as TestElement | null;
		if (!card) throw new Error("approval is not docked above the composer");
		expect(document.querySelector("pre")?.textContent).toBe(operation);
		expect((document.activeElement as unknown as TestElement | null)?.textContent ?? "").not.toBe("Approve");
		const escapeKey = new Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(escapeKey, { key: "Escape" });
		await act(async () => {
			card.dispatchEvent(escapeKey);
		});
		await flush();
		expect(respondExtensionUi).toHaveBeenCalledWith({ type: "extension_ui_response", id: "approval", value: "Deny" });
	});
});

/** Fires a keydown with optional modifiers on `target`, the way the browser would. */
async function press(
	target: object,
	key: string,
	modifiers: { metaKey?: boolean; ctrlKey?: boolean } = {},
): Promise<boolean> {
	const event = new Event("keydown", { bubbles: true, cancelable: true });
	Object.assign(event, { key, metaKey: false, ctrlKey: false, altKey: false, ...modifiers });
	await act(async () => {
		(target as TestElement).dispatchEvent(event);
	});
	await flush();
	return event.defaultPrevented;
}

function dockedCard(): TestElement {
	const card = document.querySelector(".omp-ask-dock [data-prompt-card]") as unknown as TestElement | null;
	if (!card) throw new Error("prompt is not docked above the composer");
	return card;
}

describe("ExtensionDialog input", () => {
	async function showInput(): Promise<HTMLInputElement> {
		await mount({ withComposerDock: true });
		await act(async () =>
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "input-1",
				method: "input",
				title: "Branch name",
				placeholder: "feature/…",
			}),
		);
		await flush();
		const field = document.querySelector(".omp-ask-dock [data-prompt-card] input") as unknown as HTMLInputElement;
		if (!field) throw new Error("missing input field");
		return field;
	}

	it("docks without a scrim, keeps focus off the buttons, and Enter submits the typed value", async () => {
		const field = await showInput();
		expect(document.querySelector(".omp-dialog-overlay")).toBeNull();
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(document.activeElement?.tagName).not.toBe("BUTTON");
		field.value = "feature/docked";
		// Digits type into the field; they never pick anything here.
		await press(field, "1");
		expect(respondExtensionUi).not.toHaveBeenCalled();
		await press(field, "Enter");
		expect(respondExtensionUi).toHaveBeenCalledWith({
			type: "extension_ui_response",
			id: "input-1",
			value: "feature/docked",
		});
	});

	it("Escape cancels", async () => {
		const field = await showInput();
		await press(field, "Escape");
		expect(respondExtensionUi).toHaveBeenCalledWith({
			type: "extension_ui_response",
			id: "input-1",
			cancelled: true,
		});
	});
});

describe("ExtensionDialog editor", () => {
	async function showEditor(): Promise<HTMLTextAreaElement> {
		await mount({ withComposerDock: true });
		await act(async () =>
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "editor-1",
				method: "editor",
				title: "Commit message",
				prefill: "fix: docked prompts",
			}),
		);
		await flush();
		const field = document.querySelector(
			".omp-ask-dock [data-prompt-card] textarea",
		) as unknown as HTMLTextAreaElement;
		if (!field) throw new Error("missing editor textarea");
		return field;
	}

	it("prefills, keeps plain Enter and digits in the text, and Cmd+Enter submits", async () => {
		const field = await showEditor();
		expect(field.value).toBe("fix: docked prompts");
		expect(dockedCard().textContent).toContain("Submit");
		expect(document.querySelector(".omp-ask-dock [data-prompt-card] kbd")).not.toBeNull();
		field.value = "fix: docked prompts\n\nbody";
		expect(await press(field, "Enter")).toBe(false);
		expect(await press(field, "2")).toBe(false);
		expect(respondExtensionUi).not.toHaveBeenCalled();
		await press(field, "Enter", { metaKey: true });
		expect(respondExtensionUi).toHaveBeenCalledWith({
			type: "extension_ui_response",
			id: "editor-1",
			value: "fix: docked prompts\n\nbody",
		});
	});

	it("Ctrl+Enter submits too", async () => {
		const field = await showEditor();
		await press(field, "Enter", { ctrlKey: true });
		expect(respondExtensionUi).toHaveBeenCalledWith({
			type: "extension_ui_response",
			id: "editor-1",
			value: "fix: docked prompts",
		});
	});

	it("Escape cancels", async () => {
		const field = await showEditor();
		await press(field, "Escape");
		expect(respondExtensionUi).toHaveBeenCalledWith({
			type: "extension_ui_response",
			id: "editor-1",
			cancelled: true,
		});
	});
});

describe("ExtensionDialog open_url", () => {
	async function showOpenUrl(): Promise<TestElement> {
		await mount({ withComposerDock: true });
		await act(async () =>
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "url-1",
				method: "open_url",
				url: "https://example.com/login",
				launchUrl: "https://example.com/login?launch=1",
				instructions: "Sign in, then come back.",
			}),
		);
		await flush();
		return dockedCard();
	}

	it("shows the URL plainly and 1 opens it, answering done", async () => {
		const card = await showOpenUrl();
		expect(card.textContent).toContain("https://example.com/login?launch=1");
		expect(card.textContent).toContain("Sign in, then come back.");
		expect(document.activeElement?.tagName).not.toBe("BUTTON");
		await press(card, "1");
		expect(openExternal).toHaveBeenCalledWith("https://example.com/login?launch=1");
		expect(respondExtensionUi).toHaveBeenCalledWith({ type: "extension_ui_response", id: "url-1", value: "done" });
	});

	it("2 cancels without opening anything", async () => {
		const card = await showOpenUrl();
		await press(card, "2");
		expect(openExternal).not.toHaveBeenCalled();
		expect(respondExtensionUi).toHaveBeenCalledWith({ type: "extension_ui_response", id: "url-1", cancelled: true });
	});

	it("Escape cancels", async () => {
		const card = await showOpenUrl();
		await press(card, "Escape");
		expect(openExternal).not.toHaveBeenCalled();
		expect(respondExtensionUi).toHaveBeenCalledWith({ type: "extension_ui_response", id: "url-1", cancelled: true });
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
			tabId: null,
		});
		expect(document.title).toBe("Extension task");
		expect(useExtensionUiStore.getState().pendingRequests).toEqual([]);
	});
});
