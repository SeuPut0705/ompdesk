/**
 * An Autopilot run's work board pieces (head and sections): they draw only what `AutopilotStatus` and the tool/todo
 * stores hold, and every control sends one `set_autopilot` action. How the board places them (first, in every layout)
 * is `WorkBoard.autopilot.test.tsx`.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type {
	AutopilotAction,
	AutopilotCycleRecord,
	AutopilotStatus,
} from "../../../../resources/gui-bridge/modes/autopilot-contracts";
import type { RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { useAutopilotStore } from "../../stores/autopilot";
import { useSessionStore } from "../../stores/session";
import { useUiStore } from "../../stores/ui";
import { AutopilotBoardHead, AutopilotBoardSections } from "./AutopilotBoard";

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

async function mount(): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<AutopilotBoardHead />
				<AutopilotBoardSections />
			</I18nProvider>,
		);
	});
	await flush();
}

/** A cycle's details open in place under its row. */
async function expand(n: number): Promise<void> {
	await act(async () => $(`[data-autopilot-cycle="${n}"] button[data-board-expands]`)?.click());
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
	},
	cycles: [cycle(1, { area: "design" }), cycle(2, { verify: "red", commit: undefined })],
	totals: { tokens: 1_840_000, usd: 6.2 },
	ship: {
		policy: { autoPush: false, autoRelease: { on: false, cadence: { kind: "every", n: 5 } }, remote: "origin" },
		queue: [{ id: "q1", kind: "push", state: "queued", at: 1 }],
		releaseProcedure: { file: "AGENTS.md", anchors: ["Change workflow", "Release"] },
	},
	children: [{ tabId: "c1", area: "performance", status: "running" }],
};

describe("an Autopilot run on the work board", () => {
	it("draws the head, the cycle in progress, the focus areas, the cycles and shipping from the status", async () => {
		installMockOmp();
		useAutopilotStore.getState().apply(status);
		await mount();
		expect($("[data-autopilot-state]")?.getAttribute("data-autopilot-state")).toBe("running");
		expect($("[data-autopilot-totals]")?.textContent).toContain("1.8M");
		expect($("[data-autopilot-state]")?.getAttribute("title")).toContain("↑12");
		expect($('[data-board-section="autopilot"]')?.textContent).toContain(translate("autopilot.cycleN", { n: 3 }));
		expect($("[data-autopilot-cycle-live]")?.textContent).toContain(translate("autopilot.area.performance"));
		expect($("[data-autopilot-child]")).not.toBeNull();
		await act(async () => $("[data-autopilot-focus-row]")?.click());
		expect($('[data-focus-area="design"]')?.getAttribute("aria-pressed")).toBe("true");
		expect(all("[data-autopilot-cycle]").map(row => row.getAttribute("data-autopilot-cycle"))).toEqual(["2", "1"]);
		expect($('[data-autopilot-cycle="2"]')?.getAttribute("data-verify")).toBe("red");
		expect($("[data-ship-queue] [data-ship-state]")?.getAttribute("data-ship-state")).toBe("queued");
		expect($("[data-ship-procedure]")?.textContent).toContain("AGENTS.md › Change workflow › Release");
	});

	it("keeps a fresh run to one-line rows: no empty-state sentences, no cycles section before the first cycle", async () => {
		installMockOmp();
		useAutopilotStore.getState().apply({ ...status, cycles: [], now: { n: 1, startedAt: Date.now() } });
		await mount();
		expect($('[data-board-section="cycles"]')).toBeNull();
		expect(all('[data-board-section="autopilot"] p')).toHaveLength(0);
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
		await mount();
		await expand(1);
		await expand(2);
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
		await mount();
		await act(async () => $("[data-autopilot-focus-row]")?.click());
		await act(async () => $('[data-focus-area="tests"]')?.click());
		expect(setAutopilot).toHaveBeenLastCalledWith({ action: "configure", focus: ["design", "tests"] });

		await act(async () => $("[data-ship-button='push']")?.click());
		expect(setAutopilot).toHaveBeenLastCalledWith({ action: "ship", kind: "push" });
		await act(async () => $("[data-ship-button='pr']")?.click());
		expect(setAutopilot).toHaveBeenLastCalledWith({ action: "ship", kind: "pr" });

		expect($("[data-ship-auto='push']")).toBeNull();
		await act(async () => $("[data-autopilot-pause]")?.click());
		expect(setAutopilot).toHaveBeenLastCalledWith({ action: "pause" });
		await act(async () => $("[data-autopilot-stop]")?.click());
		expect(setAutopilot).toHaveBeenLastCalledWith({ action: "stop" });
		await act(async () => $("[data-autopilot-abort]")?.click());
		expect(setAutopilot).toHaveBeenLastCalledWith({ action: "abort" });
		await act(async () => $("[data-ship-item] button")?.click());
		expect(setAutopilot).toHaveBeenLastCalledWith({ action: "cancel_ship", id: "q1" });
	});

	it("says how many red cycles ran in a row from two on, muted, and nothing below that", async () => {
		installMockOmp();
		useAutopilotStore.getState().apply({ ...status, redStreak: 1 });
		await mount();
		expect($("[data-autopilot-red-streak]")).toBeNull();
		await act(async () => useAutopilotStore.getState().apply({ ...status, redStreak: 3 }));
		expect($("[data-autopilot-red-streak]")?.textContent).toBe(translate("autopilot.redStreak", { n: 3 }));
		await act(async () => useAutopilotStore.getState().apply({ ...status }));
		expect($("[data-autopilot-red-streak]")).toBeNull();
	});

	it("lists what the cycles left for later, one line each, the first three and a row for the rest", async () => {
		installMockOmp();
		useAutopilotStore.getState().apply(status);
		await mount();
		expect($('[data-board-section="followups"]')).toBeNull();
		const followups = ["Fix the flaky resize test", "Lazy-load the drag library", "Trim the log", "Name the port"];
		await act(async () => useAutopilotStore.getState().apply({ ...status, followups }));
		const rows = all("[data-autopilot-followup]");
		expect(rows.map(row => row.getAttribute("title"))).toEqual(followups.slice(0, 3));
		expect($('[data-board-section="followups"] [data-board-more]')?.getAttribute("data-board-more")).toBe("1");
		expect($('[data-board-section="followups"] .omp-work-board-count')?.textContent).toBe("4");
	});

	it("dismisses a follow-up, and offers nothing on an ended run", async () => {
		installMockOmp();
		const followups = ["Fix the flaky resize test", "Trim the log"];
		useAutopilotStore.getState().apply({ ...status, followups });
		await mount();
		expect(all("[data-autopilot-followup-dismiss]")).toHaveLength(2);
		await act(async () => $("[data-autopilot-followup-dismiss]")?.click());
		expect(setAutopilot).toHaveBeenLastCalledWith({ action: "followup_dismiss", text: "Fix the flaky resize test" });

		await act(async () =>
			useAutopilotStore.getState().apply({ ...status, followups, state: "ended", now: undefined }),
		);
		expect(all("[data-autopilot-followup]")).toHaveLength(2);
		expect(all("[data-autopilot-followup-dismiss]")).toHaveLength(0);
	});

	it("disables Create PR with the reason when the push target is the base branch, and keeps it for a feature target", async () => {
		installMockOmp();
		useAutopilotStore.getState().apply({ ...status, target: "main" });
		await mount();
		expect($("[data-ship-button='pr']")?.disabled).toBe(true);
		expect($("[data-ship-button='pr']")?.getAttribute("title")).toBe(
			translate("autopilot.ship.prOnBase", { base: "main" }),
		);
		await act(async () => useAutopilotStore.getState().apply({ ...status, target: "feature/x" }));
		expect($("[data-ship-button='pr']")?.disabled).toBeFalsy();
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
		await mount();
		await act(async () => $("[data-autopilot-abort]")?.click());
		expect(setAutopilot).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain(translate("autopilot.abortConfirm.release"));
	});

	it("offers Resume for a paused run and no controls for an ended one", async () => {
		installMockOmp();
		useAutopilotStore.getState().apply({ ...status, state: "paused", reason: "cycles", now: undefined });
		await mount();
		expect($("[data-autopilot-reason]")?.getAttribute("data-autopilot-reason")).toBe("cycles");
		await act(async () => $("[data-autopilot-resume]")?.click());
		expect(setAutopilot).toHaveBeenLastCalledWith({ action: "resume" });

		await act(async () =>
			useAutopilotStore.getState().apply({ ...status, state: "ended", reason: "user", now: undefined }),
		);
		expect($("[data-autopilot-pause]")).toBeNull();
		expect($("[data-autopilot-controls]")).toBeNull();
	});

	it("has no backlog and no field for the next cycle (the composer says it)", async () => {
		installMockOmp();
		useAutopilotStore.getState().apply({ ...status, followups: ["Trim the log"] });
		await mount();
		expect($('[data-board-section="backlog"]')).toBeNull();
		expect(all("[data-work-board] input, [data-board-section] input")).toHaveLength(0);
		expect(all("[data-autopilot-followup-pin]")).toHaveLength(0);
	});

	it("has no shipping section for a run that lands, and keeps its release under the run's rows", async () => {
		installMockOmp();
		const ship = status.ship as NonNullable<AutopilotStatus["ship"]>;
		useAutopilotStore.getState().apply({
			...status,
			ship: {
				...ship,
				policy: { ...ship.policy, land: true, autoRelease: { on: true, cadence: { kind: "agent" } } },
				release: { version: "0.51.0", state: "success", runUrl: "https://github.com/o/r/actions/runs/9" },
			},
		});
		await mount();
		expect($('[data-board-section="ship"]')).toBeNull();
		expect($("[data-ship-button]")).toBeNull();
		// Landing on the default branch is the run's plain course: no line says it.
		expect($("[data-ship-land]")).toBeNull();
		expect($('[data-board-section="autopilot"]')?.textContent).not.toContain("lands on the default branch");
		expect($('[data-board-section="autopilot"] [data-ship-release]')?.getAttribute("data-ship-release")).toBe(
			"success",
		);
	});

	it("has no shipping section for an Automatic run that cannot land (no remote, or no known main branch)", async () => {
		installMockOmp();
		const ship = status.ship as NonNullable<AutopilotStatus["ship"]>;
		for (const autoPush of [false, true]) {
			await act(async () =>
				useAutopilotStore.getState().apply({
					...status,
					ship: { ...ship, policy: { ...ship.policy, automatic: true, autoPush } },
				}),
			);
			if (!autoPush) await mount();
			expect($('[data-board-section="ship"]')).toBeNull();
			expect($('[data-board-section="autopilot"]')?.textContent).toContain(
				translate(autoPush ? "autopilot.board.shipPush" : "autopilot.board.shipLocal"),
			);
		}
	});

	it("opens a commit from its sha in the Changes commits view", async () => {
		installMockOmp();
		useAutopilotStore.getState().apply(status);
		await mount();
		await expand(1);
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
		await mount();
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
		await mount();
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
		await mount();
		await act(async () => $("[data-ship-button='merge']")?.click());
		await act(async () => button(translate("common.cancel")).click());
		expect(setAutopilot).not.toHaveBeenCalled();
	});

	it("release asks first, then sends the release request as the user's own chat message", async () => {
		installMockOmp();
		useAutopilotStore.getState().apply(status);
		await mount();
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
		await mount();
		expect($("[data-ship-button='release']")?.disabled).toBe(true);
		expect($("[data-ship-auto='release']")?.disabled).toBe(true);
		expect(document.body.textContent).toContain(translate("autopilot.ship.noProcedure"));
	});
});
