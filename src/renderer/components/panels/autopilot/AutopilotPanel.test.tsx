/**
 * The Autopilot screen: it draws only what `AutopilotStatus` and the tool/todo stores hold, and every control sends one
 * `set_autopilot` action.
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type {
	AutopilotAction,
	AutopilotCycleRecord,
	AutopilotStatus,
} from "../../../../../resources/gui-bridge/modes/autopilot-contracts";
import type { RpcResponse } from "../../../../shared/rpc-types";
import { I18nProvider, translate } from "../../../lib/i18n";
import { useAutopilotStore } from "../../../stores/autopilot";
import { useSessionStore } from "../../../stores/session";
import { useUiStore } from "../../../stores/ui";
import { AutopilotPanel } from "./AutopilotPanel";

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
	click: () => void;
	getAttribute: (name: string) => string | null;
	value?: string;
}

let setAutopilot: Mock<(action: AutopilotAction) => Promise<RpcResponse>>;
let prompt: Mock<(message: string) => Promise<RpcResponse>>;

function installMockOmp(): void {
	setAutopilot = vi.fn(
		async () => ({ type: "response", command: "test", success: true, data: undefined }) as RpcResponse,
	);
	prompt = vi.fn(async () => ({ type: "response", command: "test", success: true, data: undefined }) as RpcResponse);
	const events = new Proxy({}, { get: () => vi.fn(() => () => {}) });
	(window as unknown as { omp: unknown }).omp = {
		rpc: {
			setAutopilot,
			prompt,
			steer: prompt,
			autopilotBranchStatus: vi.fn(async () => ({
				type: "response",
				command: "test",
				success: true,
				data: { ahead: 12, behind: 0 },
			})),
		},
		prefs: { get: vi.fn(async () => undefined), set: vi.fn(async () => {}) },
		system: { openExternal: vi.fn(async () => {}) },
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
	useAutopilotStore.getState().reset();
	useSessionStore.getState().reset();
	useUiStore.setState({ panelVisible: false, panelTab: "diff", changesFocusCommit: null, changesMode: "repository" });
});

function $(selector: string): TestElement | null {
	return document.querySelector(selector) as unknown as TestElement | null;
}

function all(selector: string): TestElement[] {
	return Array.from(document.querySelectorAll(selector)) as unknown as TestElement[];
}

interface ReactProps {
	onChange?: (event: object) => void;
	onSubmit?: (event: object) => void;
}

/** linkedom fires no React synthetic events, so the test calls the element's own handlers. */
function reactProps(element: Element | null): ReactProps {
	const record = element as unknown as Record<string, unknown> | null;
	const key = record ? Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$")) : undefined;
	return record && key ? (record[key] as ReactProps) : {};
}

async function typeInto(selector: string, value: string): Promise<void> {
	const input = document.querySelector(selector) as unknown as HTMLInputElement;
	Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set?.call(input, value);
	await act(async () => reactProps(input).onChange?.({ target: input, currentTarget: input }));
}

async function submit(selector: string): Promise<void> {
	const form = document.querySelector(selector)?.closest("form") ?? null;
	await act(async () => reactProps(form).onSubmit?.({ preventDefault() {} }));
}

function cycle(n: number, partial: Partial<AutopilotCycleRecord> = {}): AutopilotCycleRecord {
	return {
		n,
		area: "tests",
		title: `Cycle ${n} title`,
		summary: "",
		verify: "green",
		commit: `${n}a9f1c2deadbeef`,
		followups: [],
		children: [],
		startedAt: 1_000 * n,
		durationMs: 252_000,
		tokens: 212_000,
		usd: 0.4,
		compactions: 0,
		...partial,
	};
}

const status: AutopilotStatus = {
	active: true,
	state: "running",
	cycle: 3,
	run: "2026-10-17",
	root: "/work/wt",
	branch: "autopilot/2026-10-17",
	baseBranch: "main",
	now: { n: 3, area: "performance", startedAt: Date.now() },
	startedAt: 1,
	activeMs: 3_600_000,
	settings: {
		focus: ["design"],
		ship: { autoPush: false, autoRelease: { on: false, cadence: { kind: "every", n: 5 } }, remote: "origin" },
		limits: { tokens: null, minutes: null, cycles: null, usd: null },
		maxParallel: 3,
		notify: "stops",
	},
	cycles: [cycle(1, { area: "design" }), cycle(2, { verify: "red", commit: undefined })],
	backlog: [
		{ id: "b1", text: "Keyboard access in settings", done: false },
		{ id: "b2", text: "README screenshots", done: true, cycle: 1 },
	],
	totals: { tokens: 1_840_000, usd: 6.2 },
	ship: {
		policy: { autoPush: false, autoRelease: { on: false, cadence: { kind: "every", n: 5 } }, remote: "origin" },
		queue: [{ id: "q1", kind: "push", state: "queued", at: 1 }],
		releaseProcedure: { file: "AGENTS.md", anchors: ["Change workflow", "Release"] },
	},
	children: [{ tabId: "c1", area: "performance", status: "running" }],
};

describe("Autopilot screen", () => {
	it("explains an off session and offers the Mode tab", async () => {
		installMockOmp();
		await mount(<AutopilotPanel />);
		expect(document.body.textContent).toContain(translate("autopilot.empty.title"));
		await act(async () => document.querySelector("button")?.click());
		expect(useUiStore.getState().modesOpen).toBe(true);
		expect(useUiStore.getState().modesTab).toBe("autopilot");
	});

	it("draws the header, the cycle in progress, the mix, the backlog, the timeline and shipping from the status", async () => {
		installMockOmp();
		useAutopilotStore.getState().apply(status);
		await mount(<AutopilotPanel />);
		expect($("[data-autopilot-state]")?.getAttribute("data-autopilot-state")).toBe("running");
		expect($("[data-autopilot-header]")?.textContent).toContain(translate("autopilot.cycleN", { n: 3 }));
		expect($("[data-autopilot-totals]")?.textContent).toContain("1.8M");
		expect($("[data-autopilot-ahead]")?.textContent).toContain("↑12");
		expect($("[data-autopilot-now]")?.textContent).toContain(translate("autopilot.area.performance"));
		expect(all("[data-autopilot-steps] li")).toHaveLength(4);
		expect($("[data-autopilot-child]")).not.toBeNull();
		expect(all("[data-mix-area]").map(row => row.getAttribute("data-mix-area"))).toEqual(["design", "tests"]);
		expect($('[data-focus-area="design"]')?.getAttribute("aria-pressed")).toBe("true");
		expect(all("[data-backlog-item]")).toHaveLength(2);
		expect(all("[data-autopilot-cycle]").map(row => row.getAttribute("data-autopilot-cycle"))).toEqual(["2", "1"]);
		expect($('[data-autopilot-cycle="2"]')?.getAttribute("data-verify")).toBe("red");
		expect($("[data-ship-queue] [data-ship-state]")?.getAttribute("data-ship-state")).toBe("queued");
		expect($("[data-ship-procedure]")?.textContent).toContain("AGENTS.md › Change workflow › Release");
	});

	it("shows the picked item, what a cycle changed and why a reported green was not taken", async () => {
		installMockOmp();
		useAutopilotStore.getState().apply({
			...status,
			now: { n: 3, startedAt: Date.now() },
			cycles: [
				cycle(1, { change: { files: 3, added: 13, removed: 1, commits: 1 } }),
				cycle(2, {
					verify: "skipped",
					verifyNote: { kind: "check_failed", command: "bun test" },
					change: { files: 1, added: 4, removed: 0, commits: 1, docOnly: true },
				}),
			],
		});
		await mount(<AutopilotPanel />);
		// Before the agent picks, the live row says so instead of showing the rotation's guess.
		expect($("[data-autopilot-cycle-live]")?.textContent).toContain(translate("autopilot.picking"));
		expect($("[data-autopilot-pick]")).toBeNull();
		expect($('[data-autopilot-cycle="1"] [data-autopilot-change]')?.textContent).toBe(
			translate("autopilot.change", { files: 3, added: 13, removed: 1 }),
		);
		expect($('[data-autopilot-cycle="2"]')?.textContent).toContain(translate("autopilot.docOnly"));
		expect($("[data-autopilot-verify-note]")?.getAttribute("data-autopilot-verify-note")).toBe("check_failed");
		expect($("[data-autopilot-verify-note]")?.textContent).toBe(
			translate("autopilot.verifyNote.check_failed", { command: "bun test" }),
		);
		expect($('[data-autopilot-cycle="1"] [data-autopilot-verify-note]')).toBeNull();

		await act(async () =>
			useAutopilotStore
				.getState()
				.apply({ ...status, now: { n: 3, area: "bugs", title: "chunk loops on size 0", startedAt: Date.now() } }),
		);
		expect($("[data-autopilot-pick]")?.textContent).toBe("chunk loops on size 0");
		expect($("[data-autopilot-cycle-live]")?.textContent).toContain("chunk loops on size 0");
	});

	it("sends one action per control", async () => {
		installMockOmp();
		useAutopilotStore.getState().apply(status);
		await mount(<AutopilotPanel />);

		await act(async () => $('[data-focus-area="tests"]')?.click());
		expect(setAutopilot).toHaveBeenLastCalledWith({ action: "configure", focus: ["design", "tests"] });

		await act(async () => $("[data-ship-button='push']")?.click());
		expect(setAutopilot).toHaveBeenLastCalledWith({ action: "ship", kind: "push" });
		await act(async () => $("[data-ship-button='pr']")?.click());
		expect(setAutopilot).toHaveBeenLastCalledWith({ action: "ship", kind: "pr" });

		await act(async () => $("[data-ship-auto='push'] , button[data-ship-auto='push']")?.click());
		expect(setAutopilot).toHaveBeenLastCalledWith({ action: "ship", kind: "auto_push", enabled: true });

		await act(async () => $("[data-autopilot-pause]")?.click());
		expect(setAutopilot).toHaveBeenLastCalledWith({ action: "pause" });
		await act(async () => $("[data-autopilot-stop]")?.click());
		expect(setAutopilot).toHaveBeenLastCalledWith({ action: "stop" });
		await act(async () => $("[data-autopilot-abort]")?.click());
		expect(setAutopilot).toHaveBeenLastCalledWith({ action: "abort" });
		await act(async () => $("[data-ship-item] button")?.click());
		expect(setAutopilot).toHaveBeenLastCalledWith({ action: "cancel_ship", id: "q1" });
	});

	it("asks before stopping a push or release that is under way", async () => {
		installMockOmp();
		useAutopilotStore.getState().apply({
			...status,
			ship: {
				...(status.ship as NonNullable<AutopilotStatus["ship"]>),
				inFlight: { kind: "release", startedAt: 1 },
			},
		});
		await mount(<AutopilotPanel />);
		await act(async () => $("[data-autopilot-abort]")?.click());
		expect(setAutopilot).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain(translate("autopilot.abortConfirm.release"));
	});

	it("offers Resume for a paused run and no controls for an ended one", async () => {
		installMockOmp();
		useAutopilotStore.getState().apply({ ...status, state: "paused", reason: "tests_failing", now: undefined });
		await mount(<AutopilotPanel />);
		expect($("[data-autopilot-reason]")?.getAttribute("data-autopilot-reason")).toBe("tests_failing");
		await act(async () => $("[data-autopilot-resume]")?.click());
		expect(setAutopilot).toHaveBeenLastCalledWith({ action: "resume" });

		await act(async () =>
			useAutopilotStore.getState().apply({ ...status, state: "ended", reason: "user", now: undefined }),
		);
		expect($("[data-autopilot-pause]")).toBeNull();
		expect($("[data-autopilot-note]")).toBeNull();
	});

	it("adds a backlog item and a note for the next cycle", async () => {
		installMockOmp();
		useAutopilotStore.getState().apply(status);
		await mount(<AutopilotPanel />);
		expect($("button[data-autopilot-backlog-add]")?.disabled).toBe(true);

		await typeInto("[data-autopilot-backlog-input]", "Fix the tab close race");
		await submit("[data-autopilot-backlog-input]");
		expect(setAutopilot).toHaveBeenLastCalledWith({ action: "backlog_add", text: "Fix the tab close race" });

		await typeInto("[data-autopilot-note]", "Prefer small diffs");
		await submit("[data-autopilot-note]");
		expect(setAutopilot).toHaveBeenLastCalledWith({ action: "note", text: "Prefer small diffs" });
	});

	it("opens a commit from its sha in the Changes commits view", async () => {
		installMockOmp();
		useAutopilotStore.getState().apply(status);
		await mount(<AutopilotPanel />);
		await act(async () => $('[data-autopilot-sha="1a9f1c2deadbeef"]')?.click());
		const ui = useUiStore.getState();
		expect(ui.changesMode).toBe("commits");
		expect(ui.changesFocusCommit).toBe("1a9f1c2deadbeef");
		expect(ui.panelTab).toBe("diff");
	});

	it("asks before stopping now while a push is under way, and stops once confirmed", async () => {
		installMockOmp();
		useAutopilotStore.getState().apply({
			...status,
			ship: { ...(status.ship as NonNullable<AutopilotStatus["ship"]>), inFlight: { kind: "push", startedAt: 1 } },
		});
		await mount(<AutopilotPanel />);
		await act(async () => $("[data-autopilot-abort]")?.click());
		expect(setAutopilot).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain(translate("autopilot.abortConfirm.push"));
		const confirm = Array.from(document.querySelectorAll("button")).findLast(
			button => button.textContent === translate("autopilot.abortConfirm.action"),
		) as unknown as TestElement;
		await act(async () => confirm.click());
		expect(setAutopilot).toHaveBeenLastCalledWith({ action: "abort" });
	});
});

describe("Autopilot shipping confirmations", () => {
	function button(text: string): TestElement {
		const found = Array.from(document.querySelectorAll("button")).findLast(
			candidate => candidate.textContent === text,
		);
		if (!found) throw new Error(`no button ${text}`);
		return found as unknown as TestElement;
	}

	it("merge asks first, then sends a fast-forward; the merge-commit box sends that mode instead", async () => {
		installMockOmp();
		useAutopilotStore.getState().apply(status);
		await mount(<AutopilotPanel />);
		await act(async () => $("[data-ship-button='merge']")?.click());
		expect(setAutopilot).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain(
			translate("autopilot.ship.mergeConfirm.body", { count: 12, base: "main" }),
		);
		await act(async () => button(translate("autopilot.ship.mergeConfirm.action")).click());
		expect(setAutopilot).toHaveBeenLastCalledWith({ action: "ship", kind: "merge", mode: "ff" });

		await act(async () => $("[data-ship-button='merge']")?.click());
		const box = $("[data-ship-merge-commit]") as unknown as { checked: boolean; onchange?: unknown };
		const props = Object.entries(box as unknown as Record<string, unknown>).find(([key]) =>
			key.startsWith("__reactProps$"),
		)?.[1] as { onChange?: (event: object) => void };
		await act(async () => props.onChange?.({ target: { checked: true } }));
		await act(async () => button(translate("autopilot.ship.mergeConfirm.action")).click());
		expect(setAutopilot).toHaveBeenLastCalledWith({ action: "ship", kind: "merge", mode: "merge_commit" });
	});

	it("cancelling the merge confirmation sends nothing", async () => {
		installMockOmp();
		useAutopilotStore.getState().apply(status);
		await mount(<AutopilotPanel />);
		await act(async () => $("[data-ship-button='merge']")?.click());
		await act(async () => button(translate("common.cancel")).click());
		expect(setAutopilot).not.toHaveBeenCalled();
	});

	it("release asks first, then sends the release request as the user's own chat message", async () => {
		installMockOmp();
		useAutopilotStore.getState().apply(status);
		await mount(<AutopilotPanel />);
		await act(async () => $("[data-ship-button='release']")?.click());
		expect(prompt).not.toHaveBeenCalled();
		await act(async () => button(translate("autopilot.ship.release")).click());
		expect(prompt).toHaveBeenCalledWith(translate("autopilot.ship.releaseMessage"));
		expect(setAutopilot).not.toHaveBeenCalled();
	});

	it("without a detected release procedure the release button and the auto switch are off, with the reason", async () => {
		installMockOmp();
		const ship = status.ship as NonNullable<AutopilotStatus["ship"]>;
		useAutopilotStore.getState().apply({ ...status, ship: { ...ship, releaseProcedure: undefined } });
		await mount(<AutopilotPanel />);
		expect($("[data-ship-button='release']")?.disabled).toBe(true);
		expect($("[data-ship-auto='release']")?.disabled).toBe(true);
		expect(document.body.textContent).toContain(translate("autopilot.ship.noProcedure"));
	});
});
