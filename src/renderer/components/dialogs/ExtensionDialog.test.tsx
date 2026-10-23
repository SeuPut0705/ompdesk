import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { ExtensionUIRequest, ExtensionUIResponse } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { useAutopilotStore } from "../../stores/autopilot";
import { awaitedInput, useExtensionUiStore } from "../../stores/extension-ui";
import { useToastStore } from "../../stores/toast";
import { AskDockSlot, BelowEditorDockSlot } from "./ask-dock";
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
				{withComposerDock && <BelowEditorDockSlot />}
				<ExtensionDialog />
			</I18nProvider>,
		);
	});
}

async function push(...requests: ExtensionUIRequest[]): Promise<void> {
	await act(async () => {
		for (const request of requests) useExtensionUiStore.getState().pushRequest(request);
	});
	await flush();
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
	useToastStore.setState({ toasts: [] });
	vi.useRealTimers();
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

	it("keeps the card open and says why when main refuses the answer (a paired host's tab with its link down)", async () => {
		await mount();
		respondExtensionUi.mockRejectedValueOnce(new Error("[remote_offline] The device running this tab is offline"));
		await act(async () => {
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "approval-offline",
				method: "select",
				title: "Choose a connection",
				options: ["API key", "Subscription"],
			});
		});
		const choice = buttonWithText("API key");
		if (!choice) throw new Error("missing choice");
		await click(choice);

		expect(useExtensionUiStore.getState().pendingRequests.map(request => request.id)).toEqual(["approval-offline"]);
		expect(document.body.textContent).toContain("Choose a connection");
		expect(useToastStore.getState().toasts.at(-1)).toMatchObject({
			variant: "error",
			title: translate("extDialog.answerFailed"),
			message: translate("ipcError.remote_offline"),
		});

		// The link is back: the same click answers it and the card goes.
		const again = buttonWithText("API key");
		if (!again) throw new Error("card gone");
		await click(again);
		expect(respondExtensionUi).toHaveBeenCalledTimes(2);
		expect(useExtensionUiStore.getState().pendingRequests).toEqual([]);
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
		// A chip cuts a long label: hovering it names the label and the question that step asks.
		expect(card().querySelector('[data-ask-step="0"]')?.getAttribute("title")).toBe(
			"Target · Where should this deploy?",
		);
		expect(card().querySelector('[data-ask-step="1"]')?.getAttribute("title")).toBe("Run the tests first?");

		// The current step is the one tab stop of the step chips; the arrows move between questions.
		const chips = () => Array.from(card().querySelectorAll("[data-ask-step]"));
		expect(chips().map(chip => chip.getAttribute("tabindex"))).toEqual(["0", "-1"]);
		const arrow = async (key: string) => {
			const event = new Event("keydown", { bubbles: true, cancelable: true });
			Object.assign(event, { key });
			await act(async () => {
				(chips()[0] as unknown as TestElement).dispatchEvent(event);
			});
		};
		const focused: unknown[] = [];
		const focus = vi
			.spyOn(HTMLElement.prototype as unknown as { focus(): void }, "focus")
			.mockImplementation(function (this: unknown) {
				focused.push(this);
			});
		await arrow("ArrowRight");
		await flush();
		expect(card().textContent).toContain("Run the tests first?");
		expect(chips().map(chip => chip.getAttribute("tabindex"))).toEqual(["-1", "0"]);
		// Focus ends on the step the arrow picked, not on the new question's first option.
		expect(focused.at(-1)).toBe(chips()[1]);
		focus.mockRestore();
		await arrow("Home");
		expect(card().textContent).toContain("Where should this deploy?");

		const production = buttonWithText("Production");
		if (!production) throw new Error("missing Production option");
		await click(production);
		expect(card().textContent).toContain("Run the tests first?");
		expect(card().querySelector('[data-ask-step="0"] svg')).not.toBeNull();
		// The check mark is decorative: the chip's words say the step is answered.
		expect(card().querySelector('[data-ask-step="0"] .sr-only')?.textContent).toBe(
			`, ${translate("extDialog.ask.stepAnswered")}`,
		);
		expect(card().querySelector('[data-ask-step="1"] .sr-only')).toBeNull();

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

	it("counts its steps, a digit on a middle question moves on, and a multi-select stays put until Next", async () => {
		await mount({ withComposerDock: true });
		await act(async () =>
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "ask-three",
				method: "ask",
				questions: [
					{
						id: "env",
						question: "Where should this deploy?",
						options: [{ label: "Staging" }, { label: "Production" }],
					},
					{
						id: "checks",
						question: "Which checks should run first?",
						multi: true,
						options: [{ label: "Unit tests" }, { label: "E2E" }, { label: "Lint" }],
					},
					{ id: "notify", question: "Tell the team when it lands?", options: [{ label: "Yes" }, { label: "No" }] },
				],
			}),
		);
		const card = () => document.querySelector("[data-prompt-card]") as unknown as TestElement & Element;
		const press = async (key: string) => {
			const event = new Event("keydown", { bubbles: true, cancelable: true });
			Object.assign(event, { key });
			await act(async () => {
				card().dispatchEvent(event);
			});
			await flush();
		};
		expect(card().textContent).toContain(translate("extDialog.ask.step", { current: 1, total: 3 }));
		await press("2");
		expect(card().textContent).toContain("Which checks should run first?");
		expect(card().textContent).toContain(translate("extDialog.ask.step", { current: 2, total: 3 }));
		await press("1");
		await press("3");
		expect(card().textContent).toContain("Which checks should run first?");
		// Next is the form's submit button on a step that is not the last (linkedom does not submit on click).
		expect(buttonWithText(translate("extDialog.ask.next"))).toBeDefined();
		const submitStep = async () => {
			const form = card().querySelector("form") as unknown as TestElement;
			await act(async () => {
				form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
			});
			await flush();
		};
		await submitStep();
		expect(card().textContent).toContain("Tell the team when it lands?");
		await press("1");
		await submitStep();
		expect(respondExtensionUi).toHaveBeenCalledWith({
			type: "extension_ui_response",
			id: "ask-three",
			answers: [
				{ id: "env", selectedOptions: ["Production"], customInput: undefined },
				{ id: "checks", selectedOptions: ["Unit tests", "Lint"], customInput: undefined },
				{ id: "notify", selectedOptions: ["Yes"], customInput: undefined },
			],
		});
	});

	it.each([
		{
			name: "a single-select pick",
			multi: false,
			pick: "Production",
			custom: "",
			expected: { selectedOptions: [], customInput: "Production (note: after the freeze)" },
		},
		{
			name: "a multi-select pick",
			multi: true,
			pick: "Production",
			custom: "",
			expected: { selectedOptions: ["Production"], customInput: "(note: after the freeze)" },
		},
		{
			name: "a custom answer",
			multi: false,
			pick: null,
			custom: "Canary",
			expected: { selectedOptions: [], customInput: "Canary (note: after the freeze)" },
		},
	])(
		"folds the note into customInput for $name, the only free text the wire carries",
		async ({ multi, pick, custom, expected }) => {
			await mount({ withComposerDock: true });
			await push({
				type: "extension_ui_request",
				id: "ask-note",
				method: "ask",
				questions: [
					{ id: "env", question: "Where?", multi, options: [{ label: "Staging" }, { label: "Production" }] },
				],
			});
			const card = dockedCard() as TestElement & Element;
			if (pick) {
				const option = buttonWithText(pick);
				if (!option) throw new Error(`missing ${pick}`);
				await click(option);
			}
			// React's value tracker ignores linkedom input events; call the field's onChange the way ForceToolDialog.test does.
			const typeInto = async (field: HTMLInputElement, value: string) => {
				field.value = value;
				const record: Record<string, unknown> = Object(field);
				const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
				const props = propsKey ? (record[propsKey] as { onChange?: (event: object) => void }) : undefined;
				await act(async () => props?.onChange?.({ target: field, currentTarget: field }));
			};
			if (custom) {
				const customField = card.querySelector(
					'input[aria-label="Custom answer (optional)"]',
				) as unknown as HTMLInputElement | null;
				if (!customField) throw new Error("missing custom field");
				await typeInto(customField, custom);
			}
			const addNote = buttonWithText("Add a note");
			if (!addNote) throw new Error("missing Add a note");
			await click(addNote);
			const noteField = card.querySelector(
				'input[aria-label="Add a note (optional)"]',
			) as unknown as HTMLInputElement | null;
			if (!noteField) throw new Error("missing note field");
			await typeInto(noteField, "after the freeze");
			const form = card.querySelector("form") as unknown as TestElement;
			await act(async () => {
				form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
			});
			await flush();
			expect(respondExtensionUi).toHaveBeenCalledWith({
				type: "extension_ui_response",
				id: "ask-note",
				answers: [{ id: "env", ...expected }],
			});
		},
	);

	it("keeps Submit off until a lone single-choice question is answered (stock aborts the turn on an empty answer)", async () => {
		await mount({ withComposerDock: true });
		await push({
			type: "extension_ui_request",
			id: "ask-empty",
			method: "ask",
			questions: [{ id: "env", question: "Where?", options: [{ label: "Staging" }, { label: "Production" }] }],
		});
		const card = dockedCard() as TestElement & Element;
		const submit = buttonWithText("Submit") as unknown as HTMLButtonElement | undefined;
		expect(submit?.disabled).toBe(true);
		const form = card.querySelector("form") as unknown as TestElement;
		await act(async () => {
			form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});
		await flush();
		expect(respondExtensionUi).not.toHaveBeenCalled();
		const staging = buttonWithText("Staging");
		if (!staging) throw new Error("missing Staging");
		await click(staging);
		expect((buttonWithText("Submit") as unknown as HTMLButtonElement | undefined)?.disabled).toBe(false);
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

	it("offers a visible Cancel on a confirm", async () => {
		await mount({ withComposerDock: true });
		await push({
			type: "extension_ui_request",
			id: "confirm-cancel",
			method: "confirm",
			title: "Deploy to staging?",
			message: "",
		});
		const cancel = buttonWithText("Cancel");
		if (!cancel) throw new Error("confirm has no visible Cancel");
		await click(cancel);
		expect(respondExtensionUi).toHaveBeenCalledWith({
			type: "extension_ui_response",
			id: "confirm-cancel",
			cancelled: true,
		});
	});

	it("shows one prompt at a time with a +N waiting badge, then the next one", async () => {
		await mount({ withComposerDock: true });
		await push(
			{ type: "extension_ui_request", id: "c1", method: "confirm", title: "First?", message: "" },
			{ type: "extension_ui_request", id: "c2", method: "confirm", title: "Second?", message: "" },
			{ type: "extension_ui_request", id: "s1", method: "setStatus", statusKey: "k", statusText: "busy" },
			{ type: "extension_ui_request", id: "c3", method: "confirm", title: "Third?", message: "" },
		);
		expect(document.querySelectorAll("[data-prompt-card]")).toHaveLength(1);
		expect(dockedCard().textContent).toContain("First?");
		expect(document.querySelector("[data-prompt-waiting]")?.textContent).toBe("+2 waiting");
		await press(dockedCard(), "1");
		expect(dockedCard().textContent).toContain("Second?");
		expect(document.querySelector("[data-prompt-waiting]")?.textContent).toBe("+1 waiting");
		await press(dockedCard(), "2");
		expect(dockedCard().textContent).toContain("Third?");
		expect(document.querySelector("[data-prompt-waiting]")).toBeNull();
	});

	it("counts a queued request's timeout from its arrival, like stock's timer", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
		await mount({ withComposerDock: true });
		await push(
			{ type: "extension_ui_request", id: "first", method: "confirm", title: "First?", message: "" },
			{
				type: "extension_ui_request",
				id: "queued",
				method: "confirm",
				title: "Queued?",
				message: "",
				timeout: 10_000,
			},
		);
		vi.setSystemTime(new Date("2026-10-14T12:00:04Z"));
		await press(dockedCard(), "1");
		expect(dockedCard().textContent).toContain("Queued?");
		expect(document.querySelector("[data-prompt-countdown]")?.textContent).toBe("auto-dismiss in 6s");
	});

	it("shows an approval's countdown and how long the agent has waited on it", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
		// Arrived while the tab was in the background: the card shows up 12 s later.
		useExtensionUiStore.getState().pushRequest({
			type: "extension_ui_request",
			id: "approval-timed",
			method: "select",
			title: "Allow tool: bash\nls",
			options: ["Approve", "Deny"],
			timeout: 30_000,
		});
		vi.setSystemTime(new Date("2026-10-14T12:00:12Z"));
		await mount({ withComposerDock: true });
		expect(document.querySelector("[data-prompt-countdown]")?.textContent).toBe("auto-dismiss in 18s");
		expect(document.querySelector("[data-approval-waited]")?.textContent).toBe("Waiting 12s");
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

	it("draws stock's approval with the session option as the approval card and sends the option chosen", async () => {
		await mount({ withComposerDock: true });
		await act(async () =>
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "approval",
				method: "select",
				title: "Allow tool: bash\nls -la",
				options: ["Approve", "Approve bash for this session", "Deny"],
			}),
		);
		expect(awaitedInput(useExtensionUiStore.getState())).toBe("approval");
		const rows = [...document.querySelectorAll(".omp-ask-dock [data-prompt-card] [data-choice]")] as unknown as Array<
			TestElement & { getAttribute(name: string): string | null; click(): void }
		>;
		expect(rows.map(row => row.getAttribute("data-choice"))).toEqual([
			"Approve",
			"Approve bash for this session",
			"Deny",
		]);
		expect(rows[1]?.textContent).toContain(translate("approval.approveSession", { subject: "bash" }));
		await act(async () => {
			rows[1]?.click();
		});
		await flush();
		expect(respondExtensionUi).toHaveBeenCalledWith({
			type: "extension_ui_response",
			id: "approval",
			value: "Approve bash for this session",
		});
	});

	it("holds an Autopilot tab's approval card back for main's approver, and shows one that waits on", async () => {
		useAutopilotStore.getState().apply({ active: true, state: "running" });
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
		await mount({ withComposerDock: true });
		await act(async () =>
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "held",
				method: "select",
				title: "Allow tool: bash\nls",
				options: ["Approve", "Deny"],
			}),
		);
		expect(document.querySelector("[data-prompt-card]")).toBeNull();
		expect(useExtensionUiStore.getState().pendingRequests.map(request => request.id)).toEqual(["held"]);

		// An approver that never answered: the card shows once the grace period has passed.
		await act(async () => {
			root.unmount();
		});
		vi.setSystemTime(new Date("2026-10-14T12:00:10Z"));
		await mount({ withComposerDock: true });
		expect(document.querySelector("[data-prompt-card]")).not.toBeNull();
		await act(async () => useAutopilotStore.getState().reset());
	});

	it("never holds a card back in a session that is no Autopilot run", async () => {
		await mount({ withComposerDock: true });
		await act(async () =>
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "shown",
				method: "select",
				title: "Allow tool: bash\nls",
				options: ["Approve", "Deny"],
			}),
		);
		expect(document.querySelector("[data-prompt-card]")).not.toBeNull();
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

	it("with promptStyle, Enter submits and Shift+Enter keeps the newline, like stock's prompt editor", async () => {
		await mount({ withComposerDock: true });
		await push({
			type: "extension_ui_request",
			id: "editor-prompt",
			method: "editor",
			title: "Goal objective",
			promptStyle: true,
		});
		const field = document.querySelector(
			".omp-ask-dock [data-prompt-card] textarea",
		) as unknown as HTMLTextAreaElement;
		field.value = "ship it";
		const shiftEnter = new Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(shiftEnter, { key: "Enter", shiftKey: true, metaKey: false, ctrlKey: false, altKey: false });
		await act(async () => {
			(field as unknown as TestElement).dispatchEvent(shiftEnter);
		});
		expect(shiftEnter.defaultPrevented).toBe(false);
		expect(respondExtensionUi).not.toHaveBeenCalled();
		expect(Array.from(document.querySelectorAll("kbd")).map(kbd => kbd.textContent)).toContain("↵");
		await press(field, "Enter");
		expect(respondExtensionUi).toHaveBeenCalledWith({
			type: "extension_ui_response",
			id: "editor-prompt",
			value: "ship it",
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
	it("shows extension status under the input box, key-sorted on one line, without control codes", async () => {
		await mount({ withComposerDock: true });
		await push(
			{
				type: "extension_ui_request",
				id: "status-ansi",
				method: "setStatus",
				statusKey: "mode",
				statusText: "\x1b[38;5;39m●\x1b[39m ponytail: \x1b[1mFULL\x1b[0m",
			},
			{
				type: "extension_ui_request",
				id: "status-a",
				method: "setStatus",
				statusKey: "a-index",
				statusText: "Indexer\nready",
			},
		);
		const line = document.querySelector(".omp-below-editor-dock [data-extension-status]");
		expect(line?.textContent).toBe("Indexer ready·● ponytail: FULL");
		expect(document.querySelector(".omp-ask-dock")?.textContent).toBe("");

		await push({ type: "extension_ui_request", id: "status-clear", method: "setStatus", statusKey: "a-index" });
		expect(document.querySelector("[data-extension-status]")?.textContent).toBe("● ponytail: FULL");
	});

	it("places widgets above or under the input box by their placement", async () => {
		await mount({ withComposerDock: true });
		await push(
			{
				type: "extension_ui_request",
				id: "widget-ansi",
				method: "setWidget",
				widgetKey: "progress",
				widgetLines: ["\x1b[32mPASS\x1b[0m"],
			},
			{
				type: "extension_ui_request",
				id: "widget-below",
				method: "setWidget",
				widgetKey: "hints",
				widgetLines: ["below the editor"],
				widgetPlacement: "belowEditor",
			},
		);
		const above = document.querySelector(".omp-ask-dock")?.textContent ?? "";
		const below = document.querySelector(".omp-below-editor-dock")?.textContent ?? "";
		expect(above).toContain("PASS");
		expect(above).not.toContain("[32m");
		expect(above).not.toContain("below the editor");
		expect(below).toContain("below the editor");
	});

	it("keeps an error notification until it is dismissed; other notices expire", async () => {
		await mount();
		await push(
			{ type: "extension_ui_request", id: "n-err", method: "notify", message: "Index failed", notifyType: "error" },
			{ type: "extension_ui_request", id: "n-info", method: "notify", message: "Indexed", notifyType: "info" },
		);
		const toasts = useToastStore.getState().toasts;
		expect(toasts.find(toast => toast.message === "Index failed")?.expiresAt).toBe(Number.POSITIVE_INFINITY);
		expect(Number.isFinite(toasts.find(toast => toast.message === "Indexed")?.expiresAt)).toBe(true);
	});

	it("leaves a sign-in's own requests to the inline login panel; warnings still toast", async () => {
		useExtensionUiStore.getState().beginInlineLogin();
		try {
			await mount();
			await push(
				{
					type: "extension_ui_request",
					id: "p-1",
					method: "notify",
					message: "Waiting for browser…",
					notifyType: "info",
				},
				{
					type: "extension_ui_request",
					id: "p-2",
					method: "notify",
					message: "Slow network",
					notifyType: "warning",
				},
				{
					type: "extension_ui_request",
					id: "p-3",
					method: "input",
					title: "Paste the authorization code (or full redirect URL):",
					timeout: 600_000,
				},
			);
			const messages = useToastStore.getState().toasts.map(toast => toast.message);
			expect(messages).not.toContain("Waiting for browser…");
			expect(messages).toContain("Slow network");
			expect(useExtensionUiStore.getState().pendingRequests.map(request => request.id)).toEqual(["p-1", "p-3"]);
			expect(document.querySelector("[data-prompt-countdown]")).toBeNull();
			expect(buttonWithText(translate("extDialog.submit"))).toBeUndefined();
		} finally {
			await act(async () => useExtensionUiStore.getState().endInlineLogin());
		}
	});

	it("names a code paste outside the login panel as a sign-in step, in the UI language, with no countdown", async () => {
		await mount();
		// The bridge's MCP sign-in: its page first, then stock's paste prompt as the placeholder.
		await push(
			{
				type: "extension_ui_request",
				id: "mcp-url",
				method: "open_url",
				url: "https://auth.linear.app/authorize?state=s",
				launchUrl: "http://localhost:3334/launch",
			},
			{
				type: "extension_ui_request",
				id: "mcp-paste",
				method: "input",
				title: "MCP OAuth authorization",
				placeholder: "Paste the authorization code (or full redirect URL):",
				timeout: 600_000,
			},
		);
		const open = buttonWithText(translate("extDialog.openUrl.open"));
		if (!open) throw new Error("open_url card missing");
		await click(open);
		const card = container.textContent ?? "";
		expect(card).toContain(translate("extDialog.oauthPaste.title", { host: "auth.linear.app" }));
		expect(card).toContain(translate("extDialog.oauthPaste.hint"));
		expect(card).not.toContain("Paste the authorization code");
		expect(card).not.toContain("MCP OAuth authorization");
		expect(document.querySelector("[data-prompt-countdown]")).toBeNull();
		expect(document.querySelector("input")?.getAttribute("aria-label")).toBe(translate("extDialog.oauthPaste.field"));
	});

	it("fills the composer for set_editor_text and keeps the extension title with its tab", async () => {
		await mount();
		let editorDetail: { text?: string; images?: unknown[]; prepend?: boolean } | undefined;
		window.addEventListener(
			"omp:fill-composer",
			(event: Event) => {
				editorDetail = (event as CustomEvent<{ text?: string; images?: unknown[]; prepend?: boolean }>).detail;
			},
			{ once: true },
		);

		await push(
			{
				type: "extension_ui_request",
				id: "editor-1",
				method: "set_editor_text",
				text: "restored draft",
				images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
				prepend: true,
			},
			{ type: "extension_ui_request", id: "title-1", method: "setTitle", title: "Extension task" },
		);

		expect(editorDetail).toEqual({
			text: "restored draft",
			images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
			prepend: true,
			tabId: null,
		});
		// The title lives in the tab's store; the focused tab's title names the window (App).
		expect(useExtensionUiStore.getState().title).toBe("Extension task");
		expect(useExtensionUiStore.getState().pendingRequests).toEqual([]);
	});
});
