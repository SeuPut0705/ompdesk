/**
 * The Autopilot tab of the composer's Mode popover: the chip names the run (cycle, area, ending, the pause reason, a
 * quota wait) and replaces the Goal chip of the Goal it is made of, "open screen" shows the side panel view, and the
 * start sheet explains why it cannot start or sends explicit values to `set_autopilot`.
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type {
	AutopilotAction,
	AutopilotBranchInfo,
	AutopilotStatus,
} from "../../../../../resources/gui-bridge/modes/autopilot-contracts";
import type { RpcResponse } from "../../../../shared/rpc-types";
import { I18nProvider, translate } from "../../../lib/i18n";
import { useAutopilotStore } from "../../../stores/autopilot";
import { useQuotaResumeStore } from "../../../stores/quota-resume";
import { useSessionStore } from "../../../stores/session";
import { setFocusedSessionRuntime } from "../../../stores/session-runtime-context";
import { useTabsStore } from "../../../stores/tabs";
import { useUiStore } from "../../../stores/ui";
import { ComposerModeExtras } from "./ComposerModes";
import { RunChip } from "./RunChip";

/** The Run chip with its conditional extras (Autopilot's "open screen" button), as the toolbar renders them. */
function ComposerModes() {
	return (
		<>
			<RunChip />
			<ComposerModeExtras />
		</>
	);
}

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
	const button = document.querySelector("button[data-run-settings-trigger]") as unknown as TestElement | null;
	if (!button) throw new Error("Run chip missing");
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

		await act(async () => useAutopilotStore.getState().apply({ ...running, state: "paused", reason: "cycles" }));
		expect(trigger().textContent).toContain(translate("autopilot.reason.cycles"));

		await act(async () => useAutopilotStore.getState().apply({ ...running, state: "waiting_quota" }));
		expect(trigger().textContent).toContain(translate("autopilot.state.waiting_quota"));
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
		expect(trigger().textContent).toBe(translate("input.runSettings.title"));
	});

	it("an ended run shows no chip", async () => {
		installMockOmp();
		useAutopilotStore.getState().apply({ active: true, state: "ended", reason: "user" });
		await mount(<ComposerModes />);
		expect(trigger().textContent).toBe(translate("input.runSettings.title"));
	});
});

describe("Autopilot start sheet", () => {
	async function openSheet(): Promise<void> {
		await act(async () => useUiStore.getState().openModes("autopilot"));
		await flush();
	}

	it("sends only what the user chose: Start on the closed sheet leaves shipping, fan-out, notifications and ceilings to main", async () => {
		installMockOmp();
		await mount(<ComposerModes />);
		await openSheet();
		expect($("[data-autopilot-warning]")?.textContent).toContain(translate("input.approval.yoloConfirmBody"));
		expect($("[data-autopilot-warning]")?.textContent).toContain(translate("autopilot.sheet.worktreeNote"));
		await act(async () => $("button[data-autopilot-start]")?.click());
		await flush();
		expect(setAutopilot).toHaveBeenCalledTimes(1);
		const action = setAutopilot.mock.calls[0]?.[0];
		expect(action).toEqual({ action: "start" });
	});

	it("sends a shipping level picked in Advanced", async () => {
		installMockOmp();
		await mount(<ComposerModes />);
		await openSheet();
		const local = [...document.querySelectorAll("[data-autopilot-sheet] [role='tab']")].find(
			tab => tab.textContent === translate("autopilot.ship.preset.local"),
		) as unknown as HTMLElement | undefined;
		await act(async () => local?.click());
		await act(async () => $("button[data-autopilot-start]")?.click());
		await flush();
		expect(setAutopilot.mock.calls[0]?.[0]).toEqual({ action: "start", preset: "local" });
	});

	it("is one dense row per setting: no paragraphs, a short warning line, the details behind (i) glyphs", async () => {
		installMockOmp();
		await mount(<ComposerModes />);
		await openSheet();
		const count = (selector: string) => document.querySelectorAll(`[data-autopilot-sheet] ${selector}`).length;
		// Descriptions ride tooltips; the only paragraph left sits inside the closed ceilings disclosure.
		expect(count("p:not(details p)")).toBe(0);
		expect(count("[data-setting-row]")).toBeGreaterThanOrEqual(4);
		expect(count("[data-setting-info]")).toBeGreaterThanOrEqual(4);
		expect($("[data-autopilot-warning] .truncate")?.textContent).toBe(translate("autopilot.sheet.warningShort"));
		// The release procedure is a glyph with the sentence as its name, not a line of text.
		expect($("button[data-autopilot-no-procedure]")?.getAttribute("aria-label")).toBe(
			translate("autopilot.ship.noProcedure"),
		);
		expect(document.body.textContent).not.toContain("Changes apply to the current session immediately.");
		expect($("[data-settings-advanced]")?.getAttribute("open")).toBeNull();
	});

	it("shows only the guide and Start with Advanced closed; shipping, branch, focus and backlog sit in that one disclosure", async () => {
		installMockOmp();
		useAutopilotStore.getState().apply({
			active: false,
			guide: { exists: true, text: "# Ours\n" },
			branches: { repo: "/work/app", remote: "origin", defaultBranch: "main", current: "main" },
		});
		await mount(<ComposerModes />);
		await openSheet();
		const sheet = $("[data-autopilot-sheet]") as unknown as Element;
		const advanced = sheet.querySelectorAll("[data-settings-advanced]");
		expect(advanced).toHaveLength(1);
		expect(advanced[0]?.getAttribute("open")).toBeNull();
		const rows = [...sheet.querySelectorAll("[data-setting-row]")];
		const outside = rows.filter(row => !row.closest("[data-settings-advanced]")).map(row => row.textContent ?? "");
		const inside = rows.filter(row => row.closest("[data-settings-advanced]")).map(row => row.textContent ?? "");
		const has = (list: string[], key: string) => list.some(text => text.includes(translate(key)));
		expect(outside).toHaveLength(1);
		expect(has(outside, "autopilot.sheet.guide")).toBe(true);
		for (const key of [
			"autopilot.sheet.ship",
			"autopilot.sheet.branch",
			"autopilot.sheet.focus",
			"autopilot.sheet.backlog",
		]) {
			expect(has(inside, key), `${key} inside`).toBe(true);
		}
		// Nothing to cap or limit: no parallel picker, no notifications, no ceilings, no remote field.
		expect(sheet.querySelectorAll("select")).toHaveLength(0);
		expect(sheet.querySelectorAll("input[type='number']")).toHaveLength(0);
		expect($("button[data-autopilot-start]")).not.toBeNull();
	});

	it("opens Shipping on Automatic and says where the run will push", async () => {
		installMockOmp();
		useAutopilotStore.getState().apply({
			active: false,
			guide: { exists: true, text: "# Ours\n" },
			branches: { repo: "/work/app", remote: "origin", defaultBranch: "main", current: "main" },
		});
		await mount(<ComposerModes />);
		await openSheet();
		const selected = document.querySelector("[data-autopilot-sheet] [role='tab'][aria-selected='true']");
		expect(selected?.textContent).toBe(translate("autopilot.ship.preset.auto"));
		expect(document.body.textContent).toContain(
			translate("autopilot.ship.preset.auto.descRemote", { remote: "origin" }),
		);
	});

	it("changes no layout on blur: the guide box keeps its rows and the sheet its row count", async () => {
		installMockOmp();
		useAutopilotStore.getState().apply({
			active: false,
			guide: { exists: true, text: "# Ours\n" },
			branches: { repo: "/work/app", remote: "origin", defaultBranch: "main", current: "main" },
		});
		await mount(<ComposerModes />);
		await openSheet();
		const sheet = $("[data-autopilot-sheet]") as unknown as Element;
		const box = $("textarea[data-autopilot-guide]") as unknown as HTMLTextAreaElement;
		await act(async () => handlersOf(box).onFocus?.({ target: box, currentTarget: box }));
		const before = { rows: box.getAttribute("rows"), count: sheet.querySelectorAll("[data-setting-row]").length };
		await act(async () => handlersOf(box).onBlur?.({ target: box, currentTarget: box }));
		expect(box.getAttribute("rows")).toBe(before.rows);
		expect(sheet.querySelectorAll("[data-setting-row]")).toHaveLength(before.count);
		expect(sheet.querySelector("[data-settings-advanced]")?.getAttribute("open")).toBeNull();
	});

	it("holds Start back only outside a git repository: Plan mode or a Goal in this tab does not touch the run's own new tab", async () => {
		installMockOmp();
		gitStatus.isRepo = false;
		await mount(<ComposerModes />);
		await openSheet();
		expect(document.body.textContent).toContain(translate("autopilot.sheet.blocked.notRepo"));
		expect($("button[data-autopilot-start]")?.disabled).toBe(true);
		await act(async () => root.unmount());

		gitStatus.isRepo = true;
		useSessionStore.setState({
			planModeEnabled: true,
			goal: { objective: "ship it" },
			goalState: { status: "active" },
		});
		await mount(<ComposerModes />);
		await openSheet();
		expect($("button[data-autopilot-start]")?.disabled).toBe(false);
	});

	it("starts from a paired host's tab: the host runs it and this device opens the run's session", async () => {
		installMockOmp();
		setAutopilot.mockImplementation(async () =>
			success({ active: true, tabId: "host-tab", sessionPath: "/host/sessions/run.jsonl" }),
		);
		const openTab = vi.fn(async () => "view-tab");
		useTabsStore.setState({
			tabs: [{ id: "t1", cwd: "/host/repo", status: "ready", kind: "agent", unreadDone: false, device: "host-1" }],
			activeTabId: "t1",
			openTab,
		} as never);
		setFocusedSessionRuntime("t1");
		try {
			await mount(<ComposerModes />);
			await openSheet();
			expect(document.body.textContent).not.toContain("paired");
			expect($("button[data-autopilot-start]")?.disabled).toBe(false);
			await act(async () => $("button[data-autopilot-start]")?.click());
			await flush();
			expect(setAutopilot).toHaveBeenCalledTimes(1);
			expect(openTab).toHaveBeenCalledWith({ sessionPath: "/host/sessions/run.jsonl", device: "host-1" });
		} finally {
			setFocusedSessionRuntime(null);
		}
	});

	interface FieldHandlers {
		onChange?: (event: object) => void;
		onFocus?: (event: object) => void;
		onBlur?: (event: object) => void;
	}

	/** linkedom fires no React synthetic events, so the test calls the element's own handlers, as React would. */
	function handlersOf(element: HTMLTextAreaElement): FieldHandlers {
		const record = element as unknown as Record<string, unknown>;
		const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
		return (key ? record[key] : {}) as FieldHandlers;
	}

	async function typeInto(selector: string, value: string): Promise<void> {
		const element = document.querySelector(selector) as unknown as HTMLTextAreaElement;
		Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set?.call(element, value);
		await act(async () => handlersOf(element).onChange?.({ target: element, currentTarget: element }));
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

	it("Start sends the edited guide even though the press blurs the guide box first, and the box keeps its size", async () => {
		installMockOmp();
		draftOnRequest("# Drafted guide\n");
		useAutopilotStore.getState().apply({ active: false, guide: { exists: false, text: "" } });
		await mount(<ComposerModes />);
		await openSheet();
		await flush();
		const box = $("textarea[data-autopilot-guide]") as unknown as HTMLTextAreaElement;
		expect(box.getAttribute("rows")).toBe("1");
		await act(async () => handlersOf(box).onFocus?.({ target: box, currentTarget: box }));
		expect(box.getAttribute("rows")).toBe("8");
		await typeInto("textarea[data-autopilot-guide]", "# Mine\n\nMARKER-ONE\n");
		// A press on Start blurs the box at mousedown, before the click: the sheet must not reflow under the pointer,
		// or the release lands beside Start and the click never reaches it (v0.35.0: Start did nothing).
		await act(async () => handlersOf(box).onBlur?.({ target: box, currentTarget: box }));
		expect(box.getAttribute("rows")).toBe("8");
		await act(async () => $("button[data-autopilot-start]")?.click());
		await flush();
		const starts = setAutopilot.mock.calls.filter(call => call[0].action === "start");
		expect(starts).toHaveLength(1);
		expect(starts[0]?.[0]).toMatchObject({ action: "start", guide: "# Mine\n\nMARKER-ONE\n" });
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

	describe("the Branch row", () => {
		const branches = (over: Partial<AutopilotBranchInfo> = {}): AutopilotBranchInfo => ({
			repo: "/work/app",
			remote: "origin",
			defaultBranch: "main",
			current: "dev",
			...over,
		});
		const seed = (info: AutopilotBranchInfo | undefined) =>
			useAutopilotStore.getState().apply({ active: false, ...(info ? { branches: info } : {}) });
		const startAction = () => setAutopilot.mock.calls.find(call => call[0].action === "start")?.[0];

		async function startNow(): Promise<void> {
			await act(async () => $("button[data-autopilot-start]")?.click());
			await flush();
		}

		it("shows the folder's own branch as one plain line, no list, no other name, and sends no branch", async () => {
			installMockOmp();
			// Whatever an earlier release remembered names no branch here.
			(window as unknown as { omp: { prefs: { get: Mock } } }).omp.prefs.get.mockResolvedValue({
				"/work/app": { kind: "existing", name: "feature/login" },
			});
			seed(branches());
			await mount(<ComposerModes />);
			await openSheet();
			const row = $("[data-autopilot-branch]");
			expect(row?.textContent).toBe("dev");
			expect(document.querySelectorAll("[data-autopilot-sheet] select, [data-autopilot-sheet] option")).toHaveLength(
				0,
			);
			expect($("input[data-autopilot-branch-name]")).toBeNull();
			expect(document.body.textContent).not.toContain("feature/login");
			expect(document.body.textContent).not.toMatch(/autopilot\/\d{4}/);
			// A description rides a tooltip glyph, never a paragraph.
			expect(document.querySelectorAll("[data-autopilot-sheet] p:not(details p)")).toHaveLength(0);
			await startNow();
			expect(startAction()).not.toHaveProperty("branch");
			const prefs = (window as unknown as { omp: { prefs: { set: Mock } } }).omp.prefs.set;
			expect(prefs).not.toHaveBeenCalledWith("autopilotBranch", expect.anything());
		});

		it("has no row on a detached folder or before git answered", async () => {
			installMockOmp();
			seed(branches({ current: null }));
			await mount(<ComposerModes />);
			await openSheet();
			expect($("[data-autopilot-branch]")).toBeNull();
			expect($("button[data-autopilot-start]")?.disabled).toBe(false);
		});

		it("reads the branch again when the sheet opens: the status the tab hydrated with may be old", async () => {
			installMockOmp();
			(window as unknown as { omp: { rpc: Record<string, unknown> } }).omp.rpc.getAutopilot = vi.fn(async () =>
				success({ active: false, branches: branches({ current: "feature/new" }) }),
			);
			seed(branches());
			await mount(<ComposerModes />);
			await openSheet();
			await flush();
			expect($("[data-autopilot-branch]")?.textContent).toBe("feature/new");
		});
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
