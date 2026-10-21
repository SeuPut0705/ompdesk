/**
 * DOM smoke tests for PlanApprovalDialog + use-plan-approval: plan_proposal
 * event capture (latest wins), per-option approve/refine/dismiss RPC mapping,
 * empty-options fallback, dispatched/reason handling, and Esc dismissal.
 * Rendered with react-dom/client into a linkedom document (see
 * ForkHandoffDialogs.test.tsx for the pattern).
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { AgentSessionEvent, RpcResponse } from "../../../shared/rpc-types";
import { usePlanApproval } from "../../hooks/use-plan-approval";
import { I18nProvider } from "../../lib/i18n";
import { usePlanApprovalStore } from "../../stores/plan-approval";
import { useSessionStore } from "../../stores/session";
import { useToastStore } from "../../stores/toast";
import { PlanApprovalDialog } from "./PlanApprovalDialog";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};

/** Structural stand-in for linkedom nodes, keeping tests decoupled from its types. */
interface TestElement {
	textContent: string | null;
	className: string;
	disabled: boolean;
	value: string;
	remove: () => void;
	appendChild: (child: TestElement) => void;
	dispatchEvent: (event: object) => boolean;
}

function success(data: unknown): RpcResponse {
	return { type: "response", command: "plan_approval", success: true, data };
}

function failure(error: string): RpcResponse {
	return { type: "response", command: "plan_approval", success: false, error };
}

type PlanApprovalFn = (
	approved: boolean,
	option?: string,
	feedback?: string,
	savePath?: string,
) => Promise<RpcResponse>;
type SaveDialogFn = (
	defaultPath?: string,
	filters?: { name: string; extensions: string[] }[],
) => Promise<string | null>;
type BatchListener = (events: AgentSessionEvent[], tabId: string) => void;

let batchListener: BatchListener | null = null;

function installMockOmp(
	planApproval: Mock<PlanApprovalFn>,
	showSaveDialog: Mock<SaveDialogFn> = vi.fn(async () => "/work/auth-refactor.md"),
): void {
	batchListener = null;
	const ompWindow = window as unknown as {
		omp: {
			rpc: { planApproval: Mock<PlanApprovalFn> };
			events: { onTabBatch: (callback: BatchListener) => () => void };
			system: { showSaveDialog: Mock<SaveDialogFn> };
		};
	};
	ompWindow.omp = {
		rpc: { planApproval },
		system: { showSaveDialog },
		events: {
			onTabBatch: callback => {
				batchListener = callback;
				return () => {
					batchListener = null;
				};
			},
		},
	};
}

function proposal(content: string, overrides: Partial<Extract<AgentSessionEvent, { type: "plan_proposal" }>> = {}) {
	return {
		type: "plan_proposal",
		planFilePath: "/session/plans/2026-08-03-auth-refactor.md",
		title: "Auth refactor",
		suggestedFileName: "AUTH_REFACTOR_PLAN.md",
		planContent: content,
		options: ["execute", "compact", "keep_context", "save", "refine"],
		...overrides,
	} satisfies AgentSessionEvent;
}

let container: TestElement;
let root: Root;

beforeEach(() => {
	useSessionStore.setState({ status: "ready" });
});

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

function PlanEvents({ children }: { children: ReactElement }) {
	usePlanApproval();
	return children;
}

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<PlanEvents>{element}</PlanEvents>
			</I18nProvider>,
		);
	});
	await flush();
}

async function emit(events: AgentSessionEvent[]): Promise<void> {
	await act(async () => {
		batchListener?.(events, "");
	});
	await flush();
}

function buttonWithText(text: string): TestElement | undefined {
	const buttons = Array.from(document.querySelectorAll("button")) as unknown as TestElement[];
	return buttons.find(button => button.textContent?.includes(text));
}

function click(element: TestElement): void {
	element.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
}

async function pressOnCard(key: string): Promise<void> {
	const card = document.querySelector("[data-prompt-card]") as unknown as TestElement | null;
	if (!card) throw new Error("plan card not rendered");
	const event = new Event("keydown", { bubbles: true, cancelable: true });
	Object.assign(event, { key, metaKey: false, ctrlKey: false, altKey: false });
	await act(async () => {
		card.dispatchEvent(event);
	});
	await flush();
}

afterEach(async () => {
	if (root) {
		await act(async () => {
			root.unmount();
		});
	}
	container?.remove();
	usePlanApprovalStore.getState().clearProposal();
	useToastStore.setState({ toasts: [] });
	batchListener = null;
	useSessionStore.getState().reset();
});

describe("plan-approval store", () => {
	it("keeps only the latest proposal and resets feedback with the proposal lifecycle", () => {
		const store = usePlanApprovalStore.getState();
		expect(usePlanApprovalStore.getState().pending).toBeNull();
		store.showProposal({ planFilePath: "/a.md", planContent: "first", options: [] });
		usePlanApprovalStore.getState().setFeedback("change something");
		expect(usePlanApprovalStore.getState().feedback).toBe("change something");
		usePlanApprovalStore.getState().showProposal({ planFilePath: "/b.md", planContent: "second", options: [] });
		expect(usePlanApprovalStore.getState().pending?.planFilePath).toBe("/b.md");
		expect(usePlanApprovalStore.getState().feedback).toBe("");
		usePlanApprovalStore.getState().setFeedback("more");
		usePlanApprovalStore.getState().clearProposal();
		expect(usePlanApprovalStore.getState().pending).toBeNull();
		expect(usePlanApprovalStore.getState().feedback).toBe("");
	});
});

describe("PlanApprovalDialog", () => {
	it("renders nothing without a proposal and subscribes to plan_proposal events", async () => {
		const planApproval = vi.fn<PlanApprovalFn>(async () => success({ approved: false, dispatched: false }));
		installMockOmp(planApproval);
		await mount(<PlanApprovalDialog />);
		expect(document.querySelector("[data-prompt-card]")).toBeNull();
		expect(batchListener).not.toBeNull();

		await emit([proposal("# The Plan\n\n1. Do the thing.")]);
		expect(document.querySelector("[data-prompt-card]")).not.toBeNull();
		// A docked card, not a modal: no dialog role, no scrim, focus off every row.
		expect(document.querySelector("[role='dialog']")).toBeNull();
		expect(document.querySelector(".omp-dialog-overlay")).toBeNull();
		expect((document.activeElement as unknown as { tagName?: string } | null)?.tagName).not.toBe("BUTTON");
		expect(document.body.textContent).toContain("Auth refactor");
		expect(document.body.textContent).toContain("Do the thing.");
	});

	it("closes when the proposal is resolved elsewhere, and only for its own plan", async () => {
		installMockOmp(vi.fn<PlanApprovalFn>(async () => success({ approved: true, dispatched: true })));
		await mount(<PlanApprovalDialog />);
		await emit([proposal("# Plan")]);
		await emit([{ type: "plan_proposal_resolved", planFilePath: "/session/plans/other.md" }]);
		expect(document.querySelector("[data-prompt-card]")).not.toBeNull();
		await emit([{ type: "plan_proposal_resolved", planFilePath: "/session/plans/2026-08-03-auth-refactor.md" }]);
		expect(document.querySelector("[data-prompt-card]")).toBeNull();
		expect(usePlanApprovalStore.getState().pending).toBeNull();
	});

	it("closes the card when another viewer answered first while this window's answer was in flight", async () => {
		const path = "/session/plans/2026-08-03-auth-refactor.md";
		installMockOmp(
			vi.fn<PlanApprovalFn>(async () => {
				// The other viewer wins: its resolution reaches this window before this answer fails.
				batchListener?.([{ type: "plan_proposal_resolved", planFilePath: path }], "");
				return failure("No plan is awaiting approval");
			}),
		);
		await mount(<PlanApprovalDialog />);
		await emit([proposal("# Plan")]);
		const execute = buttonWithText("Approve and execute");
		if (!execute) throw new Error("missing execute button");
		await act(async () => click(execute));
		await vi.waitFor(() => expect(document.querySelector("[data-prompt-card]")).toBeNull());
		expect(usePlanApprovalStore.getState()).toMatchObject({ pending: null, submitting: null, resolved: false });
	});

	it("shows one button per advertised option and approves with the matching option", async () => {
		const planApproval = vi.fn<PlanApprovalFn>(async () => success({ approved: true, dispatched: true }));
		installMockOmp(planApproval);
		await mount(<PlanApprovalDialog />);
		await emit([proposal("# Plan")]);

		expect(buttonWithText("Approve and execute")).toBeDefined();
		expect(buttonWithText("Approve and compact")).toBeDefined();
		expect(buttonWithText("Keep context")).toBeDefined();
		expect(buttonWithText("Save plan")).toBeDefined();
		expect(buttonWithText("Refine plan")).toBeDefined();
		expect(buttonWithText("Dismiss")).toBeDefined();

		const compact = buttonWithText("Approve and compact");
		if (!compact) throw new Error("missing compact button");
		await act(async () => click(compact));
		await flush();
		expect(planApproval).toHaveBeenCalledWith(true, "compact");
		// Dispatched → dialog closes with a success toast.
		expect(usePlanApprovalStore.getState().pending).toBeNull();
		expect(document.querySelector("[data-prompt-card]")).toBeNull();
		expect(useToastStore.getState().toasts.some(t => t.variant === "success")).toBe(true);
	});

	it("saves the plan to the host-selected Markdown path without dispatching execution", async () => {
		const planApproval = vi.fn<PlanApprovalFn>(async () =>
			success({
				approved: true,
				dispatched: false,
				reason: "saved",
				savedPath: "/work/auth-refactor.md",
				freshSessionStarted: true,
			}),
		);
		const showSaveDialog = vi.fn<SaveDialogFn>(async () => "/work/auth-refactor.md");
		installMockOmp(planApproval, showSaveDialog);
		await mount(<PlanApprovalDialog />);
		await emit([proposal("# Plan")]);

		const save = buttonWithText("Save plan");
		if (!save) throw new Error("missing save button");
		await act(async () => click(save));
		await flush();

		expect(showSaveDialog).toHaveBeenCalledWith(expect.stringContaining("AUTH_REFACTOR_PLAN.md"), [
			{ name: "Markdown", extensions: ["md"] },
		]);
		expect(planApproval).toHaveBeenCalledWith(true, "save", undefined, "/work/auth-refactor.md");
		expect(usePlanApprovalStore.getState().pending).toBeNull();
		expect(useToastStore.getState().toasts.at(-1)?.message).toContain("/work/auth-refactor.md");
		expect(useToastStore.getState().toasts.at(-1)?.variant).toBe("success");
	});

	it("closes with a warning when the plan saved but the fresh session was cancelled", async () => {
		const planApproval = vi.fn<PlanApprovalFn>(async () =>
			success({
				approved: true,
				dispatched: false,
				reason: "saved; new session cancelled",
				savedPath: "/work/auth-refactor.md",
				freshSessionStarted: false,
			}),
		);
		installMockOmp(planApproval);
		await mount(<PlanApprovalDialog />);
		await emit([proposal("# Plan")]);

		const save = buttonWithText("Save plan");
		if (!save) throw new Error("missing save button");
		await act(async () => click(save));
		await flush();

		expect(usePlanApprovalStore.getState().pending).toBeNull();
		expect(useToastStore.getState().toasts.at(-1)).toMatchObject({ variant: "warning" });
		expect(useToastStore.getState().toasts.at(-1)?.message).toContain("new session cancelled");
	});

	it("maps keep_context to planApproval(true, 'keep_context')", async () => {
		const planApproval = vi.fn<PlanApprovalFn>(async () => success({ approved: true, dispatched: true }));
		installMockOmp(planApproval);
		await mount(<PlanApprovalDialog />);
		await emit([proposal("# Plan")]);

		const keepContext = buttonWithText("Keep context");
		if (!keepContext) throw new Error("missing keep-context button");
		await act(async () => click(keepContext));
		await flush();
		expect(planApproval).toHaveBeenCalledWith(true, "keep_context");
		expect(usePlanApprovalStore.getState().pending).toBeNull();
	});

	it("sends refine feedback as planApproval(false, undefined, feedback)", async () => {
		const planApproval = vi.fn<PlanApprovalFn>(async () => success({ approved: false, dispatched: true }));
		installMockOmp(planApproval);
		await mount(<PlanApprovalDialog />);
		await emit([proposal("# Plan")]);

		// Refine stays disabled until feedback exists. (linkedom cannot drive
		// React's controlled-input onChange, so feedback is set via the store —
		// the same write the TextArea's onChange performs.)
		const refineBefore = buttonWithText("Refine plan");
		if (!refineBefore) throw new Error("missing refine button");
		expect(refineBefore.disabled).toBe(true);
		expect(document.querySelector("textarea")).not.toBeNull();

		await act(async () => {
			usePlanApprovalStore.getState().setFeedback("Add a rollback step.");
		});
		await flush();

		const refine = buttonWithText("Refine plan");
		if (!refine) throw new Error("missing refine button");
		expect(refine.disabled).toBe(false);
		await act(async () => click(refine));
		await flush();
		expect(planApproval).toHaveBeenCalledWith(false, undefined, "Add a rollback step.");
		expect(usePlanApprovalStore.getState().pending).toBeNull();
		expect(usePlanApprovalStore.getState().feedback).toBe("");
	});

	it("dismisses with planApproval(false) and closes", async () => {
		const planApproval = vi.fn<PlanApprovalFn>(async () =>
			success({ approved: false, dispatched: false, reason: "rejected" }),
		);
		installMockOmp(planApproval);
		await mount(<PlanApprovalDialog />);
		await emit([proposal("# Plan")]);

		const dismiss = buttonWithText("Dismiss");
		if (!dismiss) throw new Error("missing dismiss button");
		await act(async () => click(dismiss));
		await flush();
		expect(planApproval).toHaveBeenCalledWith(false);
		expect(usePlanApprovalStore.getState().pending).toBeNull();
		expect(document.querySelector("[data-prompt-card]")).toBeNull();
	});

	it("an approval leaves plan mode (an automatic plan ends with its plan)", async () => {
		installMockOmp(vi.fn<PlanApprovalFn>(async () => success({ approved: true, dispatched: true })));
		useSessionStore.setState({ planModeEnabled: true });
		await mount(<PlanApprovalDialog />);
		await emit([proposal("# Plan")]);
		const execute = buttonWithText("Approve and execute");
		if (!execute) throw new Error("missing execute button");
		await act(async () => click(execute));
		await flush();
		expect(useSessionStore.getState().planModeEnabled).toBe(false);
	});

	it("a rejection leaves the user's plan mode on", async () => {
		installMockOmp(
			vi.fn<PlanApprovalFn>(async () => success({ approved: false, dispatched: false, reason: "rejected" })),
		);
		useSessionStore.setState({ planModeEnabled: true });
		await mount(<PlanApprovalDialog />);
		await emit([proposal("# Plan")]);
		const dismiss = buttonWithText("Dismiss");
		if (!dismiss) throw new Error("missing dismiss button");
		await act(async () => click(dismiss));
		await flush();
		expect(useSessionStore.getState().planModeEnabled).toBe(true);
	});

	it("answers planApproval(false) on Escape", async () => {
		const planApproval = vi.fn<PlanApprovalFn>(async () =>
			success({ approved: false, dispatched: false, reason: "rejected" }),
		);
		installMockOmp(planApproval);
		await mount(<PlanApprovalDialog />);
		await emit([proposal("# Plan")]);

		await pressOnCard("Escape");
		expect(planApproval).toHaveBeenCalledWith(false);
		expect(usePlanApprovalStore.getState().pending).toBeNull();
	});

	it("digits pick the numbered rows: 1 approves with the first advertised option", async () => {
		const planApproval = vi.fn<PlanApprovalFn>(async () => success({ approved: true, dispatched: true }));
		installMockOmp(planApproval);
		await mount(<PlanApprovalDialog />);
		await emit([proposal("# Plan")]);

		await pressOnCard("1");
		expect(planApproval).toHaveBeenCalledWith(true, "execute");
		expect(usePlanApprovalStore.getState().pending).toBeNull();
	});

	it("the refine digit sends nothing until feedback is written, then sends it", async () => {
		const planApproval = vi.fn<PlanApprovalFn>(async () => success({ approved: false, dispatched: true }));
		installMockOmp(planApproval);
		await mount(<PlanApprovalDialog />);
		await emit([proposal("# Plan")]);

		// execute, compact, keep_context, save, then refine (5) and dismiss (6).
		await pressOnCard("5");
		expect(planApproval).not.toHaveBeenCalled();
		await act(async () => {
			usePlanApprovalStore.getState().setFeedback("Add a rollback step.");
		});
		await flush();
		await pressOnCard("5");
		expect(planApproval).toHaveBeenCalledWith(false, undefined, "Add a rollback step.");
	});

	it("the last digit dismisses with planApproval(false)", async () => {
		const planApproval = vi.fn<PlanApprovalFn>(async () =>
			success({ approved: false, dispatched: false, reason: "rejected" }),
		);
		installMockOmp(planApproval);
		await mount(<PlanApprovalDialog />);
		await emit([proposal("# Plan")]);

		await pressOnCard("6");
		expect(planApproval).toHaveBeenCalledWith(false);
		expect(usePlanApprovalStore.getState().pending).toBeNull();
	});

	it("falls back to execute/refine/dismiss when options are empty", async () => {
		const planApproval = vi.fn<PlanApprovalFn>(async () => success({ approved: true, dispatched: true }));
		installMockOmp(planApproval);
		await mount(<PlanApprovalDialog />);
		await emit([proposal("# Plan", { options: [] })]);

		expect(buttonWithText("Approve and execute")).toBeDefined();
		expect(buttonWithText("Approve and compact")).toBeUndefined();
		expect(buttonWithText("Keep context")).toBeUndefined();
		expect(buttonWithText("Refine plan")).toBeDefined();

		const execute = buttonWithText("Approve and execute");
		if (!execute) throw new Error("missing execute button");
		await act(async () => click(execute));
		await flush();
		expect(planApproval).toHaveBeenCalledWith(true, "execute");
	});

	it("shows the latest proposal when rapid proposals arrive", async () => {
		const planApproval = vi.fn<PlanApprovalFn>(async () => success({ approved: true, dispatched: true }));
		installMockOmp(planApproval);
		await mount(<PlanApprovalDialog />);
		await emit([
			proposal("# Old plan", { title: "Old title", planFilePath: "/plans/old.md" }),
			proposal("# New plan", { title: "New title", planFilePath: "/plans/new.md" }),
		]);
		expect(document.body.textContent).toContain("New title");
		expect(document.body.textContent).not.toContain("Old title");
	});

	it("stays open with an error toast when the RPC fails", async () => {
		const planApproval = vi.fn<PlanApprovalFn>(async () => failure("no plan is awaiting approval"));
		installMockOmp(planApproval);
		await mount(<PlanApprovalDialog />);
		await emit([proposal("# Plan")]);

		const execute = buttonWithText("Approve and execute");
		if (!execute) throw new Error("missing execute button");
		await act(async () => click(execute));
		await flush();
		expect(usePlanApprovalStore.getState().pending).not.toBeNull();
		expect(document.querySelector("[data-prompt-card]")).not.toBeNull();
		expect(useToastStore.getState().toasts.some(t => t.variant === "error")).toBe(true);
	});

	it("shows the reason inline when approval is recorded but not dispatched", async () => {
		const planApproval = vi.fn<PlanApprovalFn>(async () =>
			success({ approved: true, dispatched: false, reason: "compaction failed: model offline" }),
		);
		installMockOmp(planApproval);
		await mount(<PlanApprovalDialog />);
		await emit([proposal("# Plan")]);

		const compact = buttonWithText("Approve and compact");
		if (!compact) throw new Error("missing compact button");
		await act(async () => click(compact));
		await flush();
		expect(usePlanApprovalStore.getState().pending).not.toBeNull();
		expect(document.body.textContent).toContain("compaction failed: model offline");
	});
});
