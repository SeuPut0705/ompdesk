import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcResponse } from "../../../../shared/rpc-types";
import { I18nProvider } from "../../../lib/i18n";
import { usePlanApprovalStore } from "../../../stores/plan-approval";
import { useSessionStore } from "../../../stores/session";
import { useTabsStore } from "../../../stores/tabs";
import { useToastStore } from "../../../stores/toast";
import { PlanDockCard, resolvePlanFsPath } from "./PlanDockCard";

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

const PLAN = "# Plan\n\n1. Build the card\n2. Ship it";
let planText = PLAN;
let sent: PromiseWithResolvers<RpcResponse>;
const ok = (command: string, data: unknown = {}): RpcResponse => ({ type: "response", command, success: true, data });
const prompt: Mock<(message: string) => Promise<RpcResponse>> = vi.fn(() => sent.promise);
Object.assign(window as unknown as Record<string, unknown>, {
	omp: {
		rpc: {
			getPlanMode: async () => ok("get_plan_mode", { enabled: true, planFilePath: "/work/PLAN.md" }),
			prompt,
			steer: prompt,
		},
		fs: { readPlan: async () => ({ ok: true, path: "/work/PLAN.md", content: planText }) },
	},
});

let container: HTMLElement;
let root: Root;

const approveButton = () =>
	[...container.querySelectorAll("button")].find(button => button.textContent?.includes("Approve plan")) as
		| HTMLButtonElement
		| undefined;
const click = (element: HTMLElement | undefined) =>
	act(async () => void element?.dispatchEvent(new Event("click", { bubbles: true })));

beforeEach(async () => {
	planText = PLAN;
	sent = Promise.withResolvers<RpcResponse>();
	useTabsStore.setState({ activeTabId: "tab-1" });
	useSessionStore.setState({ planModeEnabled: true, isStreaming: false });
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () =>
		root.render(
			<I18nProvider>
				<PlanDockCard presentation="panel" />
			</I18nProvider>,
		),
	);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	prompt.mockClear();
	useToastStore.setState({ toasts: [] });
	useSessionStore.getState().reset();
	useTabsStore.getState().reset();
	usePlanApprovalStore.getState().clearProposal();
});

describe("PlanDockCard approval", () => {
	it("sends one approval however often it is pressed, then reads as approved", async () => {
		const button = approveButton();
		expect(button?.disabled).toBe(false);
		await click(button);
		// In flight: the button is disabled and a second press sends nothing.
		expect(approveButton()?.disabled).toBe(true);
		await click(button);
		expect(prompt).toHaveBeenCalledTimes(1);

		await act(async () => sent.resolve(ok("prompt")));
		expect(approveButton()).toBeUndefined();
		expect(container.querySelector('[role="status"]')?.textContent).toBe("Plan approved");
		expect(prompt).toHaveBeenCalledTimes(1);
	});

	it("offers approval again when the send failed", async () => {
		await click(approveButton());
		await act(async () => sent.resolve({ type: "response", command: "prompt", success: false, error: "offline" }));
		expect(approveButton()?.disabled).toBe(false);
		expect(container.querySelector('[role="status"]')).toBeNull();
	});

	it("puts a rewritten plan up for approval again", async () => {
		await click(approveButton());
		await act(async () => sent.resolve(ok("prompt")));
		expect(approveButton()).toBeUndefined();
		// The agent revises the plan in a turn; the card re-reads it when the turn ends.
		planText = `${PLAN}\n3. Measure it`;
		await act(async () => useSessionStore.setState({ isStreaming: true }));
		await act(async () => useSessionStore.setState({ isStreaming: false }));
		expect(approveButton()?.disabled).toBe(false);
	});

	it("leaves the decision to a pending proposal's own card", async () => {
		// The plan stays readable; review buttons beside the proposal's would be a second, weaker approval.
		await act(async () =>
			usePlanApprovalStore
				.getState()
				.showProposal({ planFilePath: "/work/PLAN.md", planContent: PLAN, options: [] }),
		);
		expect(container.textContent).toContain("Ship it");
		expect(approveButton()).toBeUndefined();
		await act(async () => usePlanApprovalStore.getState().clearProposal());
		expect(approveButton()?.disabled).toBe(false);
	});
});

describe("resolvePlanFsPath", () => {
	it("passes an absolute path through on both platforms", () => {
		expect(resolvePlanFsPath("/work/PLAN.md", null, "/work")).toEqual({ fsPath: "/work/PLAN.md", localRoot: null });
		expect(resolvePlanFsPath("C:\\work\\PLAN.md", null, "C:\\work")).toEqual({
			fsPath: "C:\\work\\PLAN.md",
			localRoot: null,
		});
		expect(resolvePlanFsPath("D:/plans/PLAN.md", null, "C:\\work")).toEqual({
			fsPath: "D:/plans/PLAN.md",
			localRoot: null,
		});
	});

	it("resolves a relative path against the session folder", () => {
		expect(resolvePlanFsPath("PLAN.md", null, "/work/")).toEqual({ fsPath: "/work/PLAN.md", localRoot: null });
		expect(resolvePlanFsPath("PLAN.md", null, "C:\\work\\")).toEqual({
			fsPath: "C:\\work/PLAN.md",
			localRoot: null,
		});
	});
});
