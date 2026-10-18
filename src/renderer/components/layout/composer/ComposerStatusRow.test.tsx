/**
 * The phone's status chip row: the live run state as chips in a fixed order (model · thinking, Plan, the tool approval
 * with the delegation strength, the context share), the suggestions after a divider, one tap on Plan, a sheet per
 * chip, focus that never leaves the field (`mousedown` cancelled, never `pointerdown`), and the row's absence while
 * the soft keyboard is up (`html[data-kb="open"]`) with the Run sheet still reachable for the `+` sheet's rows.
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { RpcResponse } from "../../../../shared/rpc-types";
import { I18nProvider, translate } from "../../../lib/i18n";
import { useModelStore } from "../../../stores/model";
import { useSessionStore } from "../../../stores/session";
import { useSettingsStore } from "../../../stores/settings";
import { useUiStore } from "../../../stores/ui";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);
Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};

const { ComposerStatusRow } = await import("./ComposerStatusRow");
const { statusRowFits } = await import("./use-status-row-room");

interface TestElement {
	textContent: string | null;
	click: () => void;
	getAttribute: (name: string) => string | null;
	hasAttribute: (name: string) => boolean;
	dispatchEvent: (event: unknown) => boolean;
	querySelector: (selector: string) => TestElement | null;
}

const success = (data: unknown): RpcResponse => ({ type: "response", command: "test", success: true, data });
let setPlanMode: Mock<(enabled: boolean) => Promise<RpcResponse>>;
let root: Root | undefined;
let container: TestElement | undefined;

function installOmp(delegation = "default"): void {
	setPlanMode = vi.fn(async (enabled: boolean) => success({ enabled }));
	const events = new Proxy({}, { get: () => vi.fn(() => () => {}) });
	(window as unknown as { omp: unknown }).omp = {
		rpc: {
			getSettings: vi.fn(async () => success({ values: {} })),
			getDelegation: vi.fn(async () => success({ mode: delegation })),
			setDelegation: vi.fn(async (mode: string) => success({ mode })),
			setPlanMode,
			getContextReport: vi.fn(async () => success({ breakdown: undefined })),
		},
		prefs: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) },
		events,
	};
	// A ready session that has used a little context: the delegation reads and the context chip shows.
	useSessionStore.setState({
		status: "ready",
		contextUsage: { tokens: 8000, contextWindow: 200_000, percent: 4 } as never,
	});
}

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root?.render(<I18nProvider>{element}</I18nProvider>);
	});
	await flush();
}

function row(): { querySelector: (s: string) => TestElement | null; children: TestElement[] } | null {
	return document.querySelector("[data-status-row]") as never;
}
const chip = (name: string) => document.querySelector(`[data-chip="${name}"]`) as unknown as TestElement | null;

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	root = undefined;
	(container as unknown as { remove: () => void } | undefined)?.remove();
	document.body.innerHTML = "";
	document.documentElement.removeAttribute("data-kb");
	useSessionStore.getState().reset();
	useModelStore.getState().reset();
	useUiStore.setState({ modesOpen: false, modesTab: "plan" });
	useSettingsStore.setState({ approvalMode: "yolo" });
});

const noop = () => {};

describe("ComposerStatusRow", () => {
	it("is a labelled toolbar of model · thinking, Plan, Run and context chips in that order", async () => {
		installOmp();
		useModelStore.setState({
			model: { provider: "anthropic", id: "claude-sonnet-5-5", name: "Sonnet 5.5" },
			thinkingLevel: "medium",
			thinkingConfigured: "auto",
			availableThinkingLevels: ["low", "medium", "high"],
		});
		useSessionStore.setState({ contextUsage: { tokens: 8000, contextWindow: 200_000, percent: 4 } as never });
		await mount(<ComposerStatusRow onRunOpenChange={noop} runOpen={false} shown />);

		const bar = row() as unknown as TestElement;
		expect(bar.getAttribute("role")).toBe("toolbar");
		expect(bar.getAttribute("aria-label")).toBe(translate("input.statusRow"));
		const names = Array.from(document.querySelectorAll("[data-status-row] [data-chip]")).map(element =>
			element.getAttribute("data-chip"),
		);
		expect(names).toEqual(["model", "plan", "run", "context"]);
		expect(chip("model")?.textContent).toContain("Sonnet 5.5");
		expect(chip("model")?.textContent).toContain(translate("input.thinking.name.auto"));
		expect(chip("model")?.getAttribute("aria-label")).toContain("Sonnet 5.5");
		expect(chip("plan")?.textContent).toContain(translate("input.modes.tab.plan"));
		expect(chip("context")?.textContent).toContain("4 %");
	});

	it("opens the model picker from the model chip", async () => {
		installOmp();
		await mount(<ComposerStatusRow onRunOpenChange={noop} runOpen={false} shown />);
		await act(async () => chip("model")?.click());
		expect(useUiStore.getState().modelPickerOpen).toBe(true);
	});

	it("toggles plan mode with one tap and shows it pressed", async () => {
		installOmp();
		await mount(<ComposerStatusRow onRunOpenChange={noop} runOpen={false} shown />);
		expect(chip("plan")?.getAttribute("aria-pressed")).toBe("false");
		await act(async () => chip("plan")?.click());
		await flush();
		expect(setPlanMode).toHaveBeenCalledWith(true);
		expect(chip("plan")?.getAttribute("aria-pressed")).toBe("true");
		expect(chip("plan")?.hasAttribute("data-active")).toBe(true);
	});

	it("names an active Goal and opens the Run settings on it instead of toggling plan", async () => {
		installOmp();
		useSessionStore.setState({ goal: { objective: "Ship it" }, goalState: { status: "active" } } as never);
		await mount(<ComposerStatusRow onRunOpenChange={noop} runOpen={false} shown />);
		expect(chip("plan")?.textContent).toContain(translate("input.modes.tab.goal"));
		expect(chip("plan")?.getAttribute("aria-pressed")).toBeNull();
		await act(async () => chip("plan")?.click());
		expect(setPlanMode).not.toHaveBeenCalled();
		expect(useUiStore.getState().modesOpen).toBe(true);
		expect(useUiStore.getState().modesTab).toBe("goal");
	});

	it("shows the approval, and a delegation that is not 'your settings', on the Run chip and asks to open its sheet", async () => {
		installOmp("assisted");
		useSettingsStore.setState({ approvalMode: "write" });
		const open = vi.fn();
		await mount(<ComposerStatusRow onRunOpenChange={open} runOpen={false} shown />);
		expect(chip("run")?.textContent).toContain(translate("input.approval.write"));
		expect(chip("run")?.textContent).toContain(translate("input.delegation.mode.assisted"));
		expect(chip("run")?.getAttribute("aria-label")).toContain(translate("input.runSettings.title"));
		await act(async () => chip("run")?.click());
		expect(open).toHaveBeenCalledWith(true);
	});

	it("keeps focus where it is: every chip cancels its mousedown and never its pointerdown", async () => {
		installOmp();
		await mount(<ComposerStatusRow onRunOpenChange={noop} runOpen={false} shown />);
		for (const name of ["model", "plan", "run", "context"]) {
			const target = chip(name) as TestElement;
			const down = new Event("mousedown", { bubbles: true, cancelable: true });
			await act(async () => target.dispatchEvent(down));
			expect((down as unknown as { defaultPrevented: boolean }).defaultPrevented, name).toBe(true);
			const pointer = new Event("pointerdown", { bubbles: true, cancelable: true });
			await act(async () => target.dispatchEvent(pointer));
			expect((pointer as unknown as { defaultPrevented: boolean }).defaultPrevented, name).toBe(false);
		}
	});

	it("puts the suggestions after a divider in the same row, hidden but in place while they are away", async () => {
		installOmp();
		await mount(
			<ComposerStatusRow
				onRunOpenChange={noop}
				runOpen={false}
				shown
				trailing={
					<button data-next-chip="0" type="button">
						Run the tests again
					</button>
				}
				trailingAway
			/>,
		);
		const children = Array.from((row() as unknown as { children: ArrayLike<TestElement> }).children);
		const divider = children.findIndex(child => child.hasAttribute("data-status-divider"));
		expect(divider).toBeGreaterThan(3);
		expect(children[divider]?.hasAttribute("data-away")).toBe(true);
		expect(children[divider + 1]?.getAttribute("data-next-chip")).toBe("0");
	});

	it("has no row while the soft keyboard is up, with no suggestions either", async () => {
		installOmp();
		document.documentElement.setAttribute("data-kb", "open");
		await mount(
			<ComposerStatusRow
				onRunOpenChange={noop}
				runOpen={false}
				shown
				trailing={
					<button data-next-chip="0" type="button">
						x
					</button>
				}
			/>,
		);
		expect(row()).toBeNull();
		expect(document.querySelector("[data-next-chip]")).toBeNull();
	});

	it("has no row while the composer is expanded", async () => {
		installOmp();
		await mount(<ComposerStatusRow onRunOpenChange={noop} runOpen={false} shown={false} />);
		expect(row()).toBeNull();
	});

	it("still serves the Run sheet (Tool approval as 44 px radio rows, Delegation) with the row hidden", async () => {
		installOmp("solo");
		document.documentElement.setAttribute("data-kb", "open");
		useSettingsStore.setState({ approvalMode: "write" });
		await mount(<ComposerStatusRow onRunOpenChange={noop} runOpen shown />);
		await flush();
		expect(row()).toBeNull();
		const sheet = document.querySelector("[data-composer-sheet]") as unknown as TestElement;
		expect(sheet).not.toBeNull();
		const checked = Array.from(
			sheet.querySelector("[data-run-sheet]") ? document.querySelectorAll("[data-approval-option]") : [],
		);
		expect(checked.map(option => option.getAttribute("data-approval-option"))).toEqual([
			"yolo",
			"write",
			"always-ask",
		]);
		expect(
			checked.find(option => option.getAttribute("aria-checked") === "true")?.getAttribute("data-approval-option"),
		).toBe("write");
		expect(document.querySelectorAll("[data-delegation-option]").length).toBeGreaterThan(1);
		// Rows ask for the touch action height; the sheet never takes focus from the field (mousedown cancelled on it).
		expect((checked[0] as unknown as { className: string }).className).toContain("min-h-(--sc-row-action)");
		const down = new Event("mousedown", { bubbles: true, cancelable: true });
		await act(async () => (checked[0] as unknown as TestElement).dispatchEvent(down));
		expect((down as unknown as { defaultPrevented: boolean }).defaultPrevented).toBe(true);
	});

	it("applies a stricter approval at once and asks to confirm Full access (never a direct switch)", async () => {
		installOmp();
		const setApprovalMode = vi.fn(async () => {});
		useSettingsStore.setState({ approvalMode: "write", setApprovalMode });
		const close = vi.fn();
		await mount(<ComposerStatusRow onRunOpenChange={close} runOpen shown />);
		await flush();
		const option = (name: string) =>
			document.querySelector(`[data-approval-option="${name}"]`) as unknown as TestElement;
		await act(async () => option("always-ask").click());
		expect(setApprovalMode).toHaveBeenCalledWith("always-ask");
		await act(async () => option("yolo").click());
		expect(setApprovalMode).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledWith(false);
		await flush();
		expect(document.body.textContent).toContain(translate("input.approval.yoloConfirmTitle"));
	});

	it("opens the full Run settings from the sheet's last row", async () => {
		installOmp();
		const close = vi.fn();
		await mount(<ComposerStatusRow onRunOpenChange={close} runOpen shown />);
		await flush();
		await act(async () => (document.querySelector("[data-run-sheet-more]") as unknown as TestElement).click());
		expect(close).toHaveBeenCalledWith(false);
		expect(useUiStore.getState().modesOpen).toBe(true);
	});
});

describe("statusRowFits", () => {
	it("needs no keyboard and 420 px of visible height", () => {
		expect(statusRowFits(false, 844)).toBe(true);
		expect(statusRowFits(false, 420)).toBe(true);
		expect(statusRowFits(false, 419)).toBe(false);
		expect(statusRowFits(true, 844)).toBe(false);
		expect(statusRowFits(false, 390)).toBe(false);
	});
});
