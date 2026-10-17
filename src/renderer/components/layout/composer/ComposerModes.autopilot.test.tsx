/**
 * The Autopilot tab of the composer's Mode popover: the chip names the run (cycle, area, ending, the pause reason, a
 * quota wait) and replaces the Goal chip of the Goal it is made of, "open screen" shows the side panel view, and the
 * start sheet explains why it cannot start or sends explicit values to `set_autopilot`.
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { AutopilotAction, AutopilotStatus } from "../../../../../resources/gui-bridge/modes/autopilot-contracts";
import type { RpcResponse } from "../../../../shared/rpc-types";
import { I18nProvider, translate } from "../../../lib/i18n";
import { useAutopilotStore } from "../../../stores/autopilot";
import { useQuotaResumeStore } from "../../../stores/quota-resume";
import { useSessionStore } from "../../../stores/session";
import { useUiStore } from "../../../stores/ui";
import { ComposerModes } from "./ComposerModes";

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

interface TestElement {
	textContent: string | null;
	disabled?: boolean;
	remove: () => void;
	className: string;
	click: () => void;
	getAttribute: (name: string) => string | null;
}

function success(data: unknown): RpcResponse {
	return { type: "response", command: "test", success: true, data };
}

let setAutopilot: Mock<(action: AutopilotAction) => Promise<RpcResponse>>;
let gitStatus: { isRepo: boolean };

function installMockOmp(): void {
	gitStatus = { isRepo: true };
	setAutopilot = vi.fn(async () => success({ active: true, tabId: "new-tab" }));
	const events = new Proxy({}, { get: () => vi.fn(() => () => {}) });
	(window as unknown as { omp: unknown }).omp = {
		rpc: {
			getSettings: vi.fn(async () => success({ values: {} })),
			getGitStatus: vi.fn(async () => success(gitStatus)),
			setAutopilot,
		},
		prefs: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) },
		events,
	};
}

let container: TestElement;
let root: Root;

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
		root.render(<I18nProvider>{element}</I18nProvider>);
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
	document.body.innerHTML = "";
	useSessionStore.getState().reset();
	useAutopilotStore.getState().reset();
	useQuotaResumeStore.setState({ reservations: {} });
	useUiStore.setState({ modesOpen: false, modesTab: "plan", panelVisible: false, panelTab: "diff" });
});

function trigger(): TestElement {
	const button = document.querySelector("button[data-composer-modes-trigger]") as unknown as TestElement | null;
	if (!button) throw new Error("mode chip missing");
	return button;
}

function $(selector: string): TestElement | null {
	return document.querySelector(selector) as unknown as TestElement | null;
}

const running: AutopilotStatus = {
	active: true,
	state: "running",
	cycle: 7,
	now: { n: 7, area: "performance", startedAt: 1 },
	branch: "autopilot/2026-10-17",
};

function live(status: AutopilotStatus): void {
	useAutopilotStore.getState().apply(status);
	// The run is a Goal underneath: the Goal chip must not show it.
	useSessionStore.setState({ goal: { objective: "Autopilot: keep developing" }, goalState: { status: "active" } });
}

describe("Autopilot chip", () => {
	it("names the cycle and area, and shows no separate Goal", async () => {
		installMockOmp();
		live(running);
		await mount(<ComposerModes />);
		const text = `${translate("input.modes.name.autopilot")} · ${translate("autopilot.cycleArea", { n: 7, area: translate("autopilot.area.performance") })}`;
		expect(trigger().textContent).toBe(text);
		expect(trigger().textContent).not.toContain(translate("input.modes.name.goal"));
	});

	it("says ending, the pause reason and a quota wait", async () => {
		installMockOmp();
		live({ ...running, state: "stopping" });
		await mount(<ComposerModes />);
		expect(trigger().textContent).toContain(translate("autopilot.stopping"));

		await act(async () =>
			useAutopilotStore.getState().apply({ ...running, state: "paused", reason: "tests_failing" }),
		);
		expect(trigger().textContent).toContain(translate("autopilot.reason.tests_failing"));

		await act(async () => useAutopilotStore.getState().apply({ ...running, state: "waiting_quota" }));
		expect(trigger().textContent).toContain(translate("autopilot.state.waiting_quota"));
	});

	it("treats a booked usage-limit resume as a quota wait", async () => {
		installMockOmp();
		useSessionStore.setState({ sessionId: "s1" });
		live(running);
		await mount(<ComposerModes />);
		const resetAt = Date.now() + 3_600_000;
		await act(async () => useQuotaResumeStore.setState({ reservations: { s1: resetAt } }));
		const time = new Date(resetAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		expect(trigger().textContent).toContain(translate("autopilot.chip.quotaUntil", { time }));
	});

	it("opens the Autopilot screen from the small button beside the chip", async () => {
		installMockOmp();
		live(running);
		await mount(<ComposerModes />);
		await act(async () => $("button[data-autopilot-chip-open]")?.click());
		expect(useUiStore.getState().panelTab).toBe("autopilot");
		expect(useUiStore.getState().panelVisible).toBe(true);
	});

	it("has no chip button for a session that is no run", async () => {
		installMockOmp();
		await mount(<ComposerModes />);
		expect($("button[data-autopilot-chip-open]")).toBeNull();
		expect(trigger().textContent).toBe(translate("input.modes.label"));
	});

	it("an ended run shows no chip", async () => {
		installMockOmp();
		useAutopilotStore.getState().apply({ active: true, state: "ended", reason: "user" });
		await mount(<ComposerModes />);
		expect(trigger().textContent).toBe(translate("input.modes.label"));
	});
});

describe("Autopilot start sheet", () => {
	async function openSheet(): Promise<void> {
		await act(async () => useUiStore.getState().openModes("autopilot"));
		await flush();
	}

	it("starts with explicit cautious values: local only, every ceiling off, three children", async () => {
		installMockOmp();
		await mount(<ComposerModes />);
		await openSheet();
		expect($("[data-autopilot-warning]")?.textContent).toContain(translate("input.approval.yoloConfirmBody"));
		expect($("[data-autopilot-warning]")?.textContent).toContain(translate("autopilot.sheet.worktreeNote"));
		await act(async () => $("button[data-autopilot-start]")?.click());
		await flush();
		expect(setAutopilot).toHaveBeenCalledTimes(1);
		const action = setAutopilot.mock.calls[0]?.[0];
		expect(action).toMatchObject({
			action: "start",
			focus: [],
			preset: "local",
			maxParallel: 3,
			notify: "stops",
			limits: { tokens: null, minutes: null, cycles: null, usd: null },
			ship: { autoPush: false, autoRelease: { on: false }, remote: "origin" },
		});
	});

	it("is one dense row per setting: no paragraphs, a short warning line, the details behind (i) glyphs", async () => {
		installMockOmp();
		await mount(<ComposerModes />);
		await openSheet();
		const count = (selector: string) => document.querySelectorAll(`[data-autopilot-sheet] ${selector}`).length;
		// Descriptions ride tooltips; the only paragraph left sits inside the closed ceilings disclosure.
		expect(count("p:not(details p)")).toBe(0);
		expect(count("[data-setting-row]")).toBeGreaterThanOrEqual(7);
		expect(count("[data-setting-info]")).toBeGreaterThanOrEqual(4);
		expect($("[data-autopilot-warning] .truncate")?.textContent).toBe(translate("autopilot.sheet.warningShort"));
		// The release procedure is a glyph with the sentence as its name, not a line of text.
		expect($("button[data-autopilot-no-procedure]")?.getAttribute("aria-label")).toBe(
			translate("autopilot.ship.noProcedure"),
		);
		expect(document.body.textContent).not.toContain("Changes apply to the current session immediately.");
		expect($("[data-autopilot-limits]")?.getAttribute("open")).toBeNull();
	});

	it("says why it cannot start and keeps Start disabled: no repository, Plan on, an existing Goal", async () => {
		installMockOmp();
		gitStatus.isRepo = false;
		await mount(<ComposerModes />);
		await openSheet();
		expect(document.body.textContent).toContain(translate("autopilot.sheet.blocked.notRepo"));
		expect($("button[data-autopilot-start]")?.disabled).toBe(true);

		gitStatus.isRepo = true;
		await act(async () => useSessionStore.setState({ planModeEnabled: true }));
		await flush();
		expect($("button[data-autopilot-start]")?.disabled).toBe(true);
	});

	/** linkedom fires no React synthetic events, so the test calls the element's own handler. */
	async function typeInto(selector: string, value: string): Promise<void> {
		const element = document.querySelector(selector) as unknown as HTMLTextAreaElement;
		const record = element as unknown as Record<string, unknown>;
		const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
		const props = (key ? record[key] : {}) as { onChange?: (event: object) => void };
		Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set?.call(element, value);
		await act(async () => props.onChange?.({ target: element, currentTarget: element }));
	}

	function draftOnRequest(draft: string): void {
		setAutopilot.mockImplementation(async action =>
			action.action === "guide_draft"
				? success({ active: false, guide: { exists: false, text: draft, draft: "model" } })
				: success({ active: true, tabId: "new-tab" }),
		);
	}

	it("shows a drafted guide for a repo without one and commits the user's edit with the start", async () => {
		installMockOmp();
		draftOnRequest("# Drafted guide\n\nKeep it small.\n");
		useAutopilotStore.getState().apply({ active: false, guide: { exists: false, text: "" } });
		await mount(<ComposerModes />);
		await openSheet();
		await flush();
		expect(setAutopilot.mock.calls.map(call => call[0].action)).toEqual(["guide_draft"]);
		const box = $("textarea[data-autopilot-guide]") as unknown as HTMLTextAreaElement | null;
		expect(box?.value).toBe("# Drafted guide\n\nKeep it small.\n");
		expect(document.body.textContent).toContain(translate("autopilot.sheet.guideModel"));

		await typeInto("textarea[data-autopilot-guide]", "# Mine\n\nEdited by the user.\n");
		await act(async () => $("button[data-autopilot-start]")?.click());
		await flush();
		const start = setAutopilot.mock.calls.find(call => call[0].action === "start")?.[0];
		expect(start).toMatchObject({ action: "start", guide: "# Mine\n\nEdited by the user.\n" });
		// One draft only, however often the sheet re-renders.
		expect(setAutopilot.mock.calls.filter(call => call[0].action === "guide_draft")).toHaveLength(1);
	});

	it("shows the repo's own guide for editing and drafts nothing", async () => {
		installMockOmp();
		useAutopilotStore.getState().apply({ active: false, guide: { exists: true, text: "# Ours\n\nDo X.\n" } });
		await mount(<ComposerModes />);
		await openSheet();
		await flush();
		expect(setAutopilot).not.toHaveBeenCalled();
		expect(($("textarea[data-autopilot-guide]") as unknown as HTMLTextAreaElement | null)?.value).toBe(
			"# Ours\n\nDo X.\n",
		);
		expect(document.body.textContent).toContain(translate("autopilot.sheet.guideExists"));
	});

	it("sends no guide when the box is cleared", async () => {
		installMockOmp();
		useAutopilotStore.getState().apply({ active: false, guide: { exists: true, text: "# Ours\n" } });
		await mount(<ComposerModes />);
		await openSheet();
		await typeInto("textarea[data-autopilot-guide]", "");
		await act(async () => $("button[data-autopilot-start]")?.click());
		await flush();
		expect(setAutopilot.mock.calls[0]?.[0]).not.toHaveProperty("guide");
	});

	it("shows the run's controls instead of the sheet while a run is live", async () => {
		installMockOmp();
		live(running);
		await mount(<ComposerModes />);
		await openSheet();
		expect($("[data-autopilot-run]")).not.toBeNull();
		expect($("button[data-autopilot-start]")).toBeNull();
		await act(async () => $("button[data-autopilot-stop]")?.click());
		expect(setAutopilot).toHaveBeenCalledWith({ action: "stop" });
	});
});
