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
	AutopilotBranchEntry,
	AutopilotBranchInfo,
	AutopilotStatus,
} from "../../../../../resources/gui-bridge/modes/autopilot-contracts";
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

		await act(async () => useAutopilotStore.getState().apply({ ...running, state: "paused", reason: "cycles" }));
		expect(trigger().textContent).toContain(translate("autopilot.reason.cycles"));

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
			maxParallel: 4,
			notify: "stops",
			limits: { tokens: null, minutes: null, cycles: null, usd: null },
			ship: { autoPush: false, autoRelease: { on: false, cadence: { kind: "agent" } } },
		});
		// The remote is auto: nothing is sent unless the user typed one.
		expect(action?.action === "start" ? action.ship : null).not.toHaveProperty("remote");
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
		expect($("[data-settings-advanced]")?.getAttribute("open")).toBeNull();
	});

	it("shows only the guide, Shipping, the Branch row and Start with Advanced closed; the rest sits in that one disclosure", async () => {
		installMockOmp();
		useAutopilotStore.getState().apply({
			active: false,
			guide: { exists: true, text: "# Ours\n" },
			branches: {
				repo: "/work/app",
				remote: "origin",
				defaultBranch: "main",
				suggested: "autopilot/2026-10-18",
				branches: [{ name: "main", local: true, remote: true, default: true, current: false }],
			},
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
		for (const key of ["autopilot.sheet.guide", "autopilot.sheet.ship", "autopilot.sheet.branch"]) {
			expect(has(outside, key), key).toBe(true);
		}
		for (const key of [
			"autopilot.sheet.focus",
			"autopilot.sheet.parallel",
			"autopilot.sheet.notify",
			"autopilot.sheet.backlog",
			"autopilot.sheet.limits",
		]) {
			expect(has(outside, key), `${key} outside`).toBe(false);
			expect(has(inside, key), `${key} inside`).toBe(true);
		}
		expect($("button[data-autopilot-start]")).not.toBeNull();
	});

	it("opens Advanced on the defaults: all areas, the agent decides the parallel sessions, notify on stops, remote auto, no ceilings", async () => {
		installMockOmp();
		await mount(<ComposerModes />);
		await openSheet();
		const parallel = $(
			"select[aria-label='" + translate("autopilot.sheet.parallel") + "']",
		) as unknown as HTMLSelectElement;
		expect(parallel.value).toBe("4");
		const labels = [...document.querySelectorAll("[data-autopilot-sheet] option")].map(option => option.textContent);
		expect(labels).toContain(translate("autopilot.sheet.parallelAuto", { n: 4 }));
		const notify = $(
			"select[aria-label='" + translate("autopilot.sheet.notify") + "']",
		) as unknown as HTMLSelectElement;
		expect(notify.value).toBe("stops");
		expect(document.querySelectorAll("[data-autopilot-limits] input[type='number']")).toHaveLength(4);
		for (const input of document.querySelectorAll("[data-autopilot-limits] input"))
			expect((input as unknown as HTMLInputElement).value).toBe("");
	});

	it("changes no layout on blur: the guide box and the Branch name keep their rows and the sheet its row count", async () => {
		installMockOmp();
		useAutopilotStore.getState().apply({
			active: false,
			guide: { exists: true, text: "# Ours\n" },
			branches: {
				repo: "/work/app",
				remote: "origin",
				defaultBranch: "main",
				suggested: "autopilot/2026-10-18",
				branches: [{ name: "main", local: true, remote: true, default: true, current: false }],
			},
		});
		await mount(<ComposerModes />);
		await openSheet();
		const sheet = $("[data-autopilot-sheet]") as unknown as Element;
		const box = $("textarea[data-autopilot-guide]") as unknown as HTMLTextAreaElement;
		const name = $("input[data-autopilot-branch-name]") as unknown as HTMLInputElement;
		await act(async () => handlersOf(box).onFocus?.({ target: box, currentTarget: box }));
		const before = { rows: box.getAttribute("rows"), count: sheet.querySelectorAll("[data-setting-row]").length };
		for (const field of [box, name]) {
			await act(async () =>
				handlersOf(field as unknown as HTMLTextAreaElement).onBlur?.({ target: field, currentTarget: field }),
			);
		}
		expect(box.getAttribute("rows")).toBe(before.rows);
		expect(sheet.querySelectorAll("[data-setting-row]")).toHaveLength(before.count);
		expect(sheet.querySelector("[data-settings-advanced]")?.getAttribute("open")).toBeNull();
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
		const entry = (name: string, over: Partial<AutopilotBranchEntry> = {}): AutopilotBranchEntry => ({
			name,
			local: true,
			remote: false,
			default: false,
			current: false,
			...over,
		});
		const branches = (over: Partial<AutopilotBranchInfo> = {}): AutopilotBranchInfo => ({
			repo: "/work/app",
			remote: "origin",
			defaultBranch: "main",
			suggested: "autopilot/2026-10-18",
			branches: [
				entry("main", { remote: true, default: true }),
				entry("dev", { current: true, checkedOutAt: "/work/app" }),
				entry("feature/login", { remote: true }),
				entry("hotfix", { local: false, remote: true }),
				entry("release/1", { checkedOutAt: "/wt/gui-release-1" }),
			],
			...over,
		});
		const seed = (info: AutopilotBranchInfo | undefined) =>
			useAutopilotStore.getState().apply({ active: false, ...(info ? { branches: info } : {}) });
		const select = () => $("[data-autopilot-branch] select") as unknown as HTMLSelectElement;
		const nameInput = () => $("input[data-autopilot-branch-name]") as unknown as HTMLInputElement | null;
		const startAction = () => setAutopilot.mock.calls.find(call => call[0].action === "start")?.[0];

		async function choose(value: string): Promise<void> {
			const element = select();
			await act(async () => handlersOf(element as unknown as HTMLTextAreaElement).onChange?.({ target: { value } }));
		}

		async function startNow(): Promise<void> {
			await act(async () => $("button[data-autopilot-start]")?.click());
			await flush();
		}

		it("is one compact row under Shipping and absent when git gave no list", async () => {
			installMockOmp();
			seed(undefined);
			await mount(<ComposerModes />);
			await openSheet();
			expect($("[data-autopilot-branch]")).toBeNull();
			await startNow();
			expect(startAction()).not.toHaveProperty("branch");

			await act(async () => root.unmount());
			document.body.innerHTML = "";
			seed(branches());
			await mount(<ComposerModes />);
			await openSheet();
			expect(select().getAttribute("aria-label")).toBe(translate("autopilot.sheet.branch"));
			// A description rides a tooltip glyph, never a paragraph.
			expect(document.querySelectorAll("[data-autopilot-sheet] p:not(details p)")).toHaveLength(0);
		});

		it("starts on a new autopilot/<date> branch by default, with an editable name and nothing sent for the untouched one", async () => {
			installMockOmp();
			seed(branches());
			await mount(<ComposerModes />);
			await openSheet();
			expect(select().value).toBe("new");
			expect(nameInput()?.value).toBe("autopilot/2026-10-18");
			await startNow();
			const untouched = startAction();
			expect(untouched).toMatchObject({ branch: { kind: "new" } });
			expect(untouched?.action === "start" ? untouched.branch : null).not.toHaveProperty("name");

			// Start closed the popover: open a fresh sheet for the typed name.
			await act(async () => root.unmount());
			document.body.innerHTML = "";
			setAutopilot.mockClear();
			await mount(<ComposerModes />);
			await openSheet();
			await typeInto("input[data-autopilot-branch-name]", "work/night");
			await startNow();
			expect(startAction()).toMatchObject({ branch: { kind: "new", name: "work/night" } });
		});

		it("holds Start back for a name git would not take or one that already exists, with the reason", async () => {
			installMockOmp();
			seed(branches());
			await mount(<ComposerModes />);
			await openSheet();
			await typeInto("input[data-autopilot-branch-name]", "bad name");
			expect($("button[data-autopilot-start]")?.disabled).toBe(true);
			expect(document.body.textContent).toContain(translate("autopilot.branch.invalid"));
			await typeInto("input[data-autopilot-branch-name]", "feature/login");
			expect($("button[data-autopilot-start]")?.disabled).toBe(true);
			expect(document.body.textContent).toContain(translate("autopilot.branch.exists"));
			await typeInto("input[data-autopilot-branch-name]", "work/ok");
			expect($("button[data-autopilot-start]")?.disabled).toBe(false);
		});

		it("lists the repo's branches, the default first, none greyed: a branch another worktree holds says it goes via a work branch", async () => {
			installMockOmp();
			seed(branches());
			await mount(<ComposerModes />);
			await openSheet();
			const options = [...document.querySelectorAll("[data-autopilot-branch] option")];
			const via = translate("autopilot.branch.viaWork");
			expect(options.map(option => option.textContent)).toEqual([
				translate("autopilot.branch.new"),
				`main · ${translate("autopilot.branch.default")}`,
				`dev · ${via}`,
				"feature/login",
				`hotfix · ${translate("autopilot.branch.remoteOnly")}`,
				`release/1 · ${via}`,
			]);
			expect(options.some(option => option.getAttribute("disabled") !== null)).toBe(false);
			// The line "work branch → push target" shows only for a target another worktree holds.
			expect($("[data-autopilot-branch-via]")).toBeNull();
			await choose("branch:release/1");
			expect($("[data-autopilot-branch-via]")?.textContent).toBe(
				translate("autopilot.branch.viaLine", { work: "autopilot/2026-10-18", target: "release/1" }),
			);
			await choose("branch:feature/login");
			expect($("[data-autopilot-branch-via]")).toBeNull();
		});

		it("sends an existing branch, remembers it per repository and shows no warning for it", async () => {
			installMockOmp();
			seed(branches());
			await mount(<ComposerModes />);
			await openSheet();
			await choose("branch:feature/login");
			expect(nameInput()).toBeNull();
			expect($("[data-autopilot-branch-warning]")).toBeNull();
			await startNow();
			expect(startAction()).toMatchObject({ branch: { kind: "existing", name: "feature/login" } });
			const prefs = (window as unknown as { omp: { prefs: { set: Mock } } }).omp.prefs.set;
			expect(prefs).toHaveBeenCalledWith("autopilotBranch", {
				"/work/app": { kind: "existing", name: "feature/login" },
			});
			// The ship defaults are a separate pref and never carry the branch.
			expect(prefs.mock.calls.some(call => call[0] === "autopilotShip")).toBe(false);
		});

		it("warns in one line when the default branch is picked: commits land on it and Push pushes to it", async () => {
			installMockOmp();
			seed(branches());
			await mount(<ComposerModes />);
			await openSheet();
			expect($("[data-autopilot-branch-warning]")).toBeNull();
			await choose("branch:main");
			expect($("[data-autopilot-branch-warning]")?.textContent).toBe(
				translate("autopilot.branch.defaultWarning", { branch: "main" }),
			);
			await choose("new");
			expect($("[data-autopilot-branch-warning]")).toBeNull();
			await choose("branch:main");
			await startNow();
			expect(startAction()).toMatchObject({ branch: { kind: "existing", name: "main" } });
		});

		it("does not move the sheet when the name field loses focus", async () => {
			installMockOmp();
			seed(branches());
			await mount(<ComposerModes />);
			await openSheet();
			const input = nameInput() as unknown as HTMLTextAreaElement;
			const before = document.querySelectorAll("[data-autopilot-sheet] *").length;
			await act(async () => handlersOf(input).onFocus?.({ target: input, currentTarget: input }));
			await act(async () => handlersOf(input).onBlur?.({ target: input, currentTarget: input }));
			expect(document.querySelectorAll("[data-autopilot-sheet] *").length).toBe(before);
		});

		it("opens on the choice remembered for this repository, and on a new branch when it is no longer usable", async () => {
			installMockOmp();
			seed(branches({ last: { kind: "existing", name: "feature/login" } }));
			await mount(<ComposerModes />);
			await openSheet();
			expect(select().value).toBe("branch:feature/login");

			await act(async () => root.unmount());
			document.body.innerHTML = "";
			useAutopilotStore.getState().reset();
			// `dev` is held by the user's own folder: still usable, as a target reached through a work branch.
			seed(branches({ last: { kind: "existing", name: "dev" } }));
			await mount(<ComposerModes />);
			await openSheet();
			expect(select().value).toBe("branch:dev");
			expect($("[data-autopilot-branch-via]")?.textContent).toBe(
				translate("autopilot.branch.viaLine", { work: "autopilot/2026-10-18", target: "dev" }),
			);
		});

		it("reads the list again when the sheet opens: the status the tab hydrated with may be old", async () => {
			installMockOmp();
			const fresh = branches({ branches: [entry("main", { default: true }), entry("feature/new")] });
			(window as unknown as { omp: { rpc: Record<string, unknown> } }).omp.rpc.getAutopilot = vi.fn(async () =>
				success({ active: false, branches: fresh }),
			);
			seed(branches());
			await mount(<ComposerModes />);
			await openSheet();
			await flush();
			expect(
				[...document.querySelectorAll("[data-autopilot-branch] option")].map(option => option.textContent),
			).toContain("feature/new");
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
