/**
 * The bot's routines on its work board: a row per routine (name, what starts it, when it next starts or what it waits
 * for, the last run's tone), opened in place for the prompt, the trigger, Test / Pause / Resume / Edit / Delete and the
 * run history with what fired each run and why one failed. A paired host's routines are changed on that host.
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type BotDeskState, type BotRoutine, EMPTY_BOT_DESK } from "../../../shared/bot-desk";
import type { ScheduleFrequency, ScheduleRun, SchedulesRequest } from "../../../shared/schedules";
import { formatClock } from "../../lib/format";
import { I18nProvider, translate } from "../../lib/i18n";
import { useBotDeskStore } from "../../stores/bot-desk";
import { useMobileWebStore } from "../../stores/mobile-web";
import { useToastStore } from "../../stores/toast";
import { BotBoardSections } from "./BotDesk";
import { BotTabContext } from "./bot-tab";

const { document, window, Event, HTMLElement, Element, Node, CustomEvent } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.CustomEvent = CustomEvent;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const command = vi.fn(async (_request: SchedulesRequest, _device?: string) => ({}));

function installApi(): void {
	(window as unknown as { omp: unknown }).omp = { schedules: { command } };
}

let container: Element;
let root: Root;

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as Element;
	document.body.appendChild(container as never);
	root = createRoot(container);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
}

function props<T>(element: Element | null): T {
	if (!element) throw new Error("props: element is null");
	const record = element as unknown as Record<string, unknown>;
	const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
	if (!key) throw new Error("props: React props missing");
	return record[key] as T;
}

async function click(element: Element | null): Promise<void> {
	await act(async () => props<{ onClick: (event: unknown) => void }>(element).onClick({ preventDefault() {} }));
}

const query = (selector: string) => container.querySelector(selector);
const queryAll = (selector: string) => [...container.querySelectorAll(selector)];
const text = (selector: string) => query(selector)?.textContent ?? "";

function routine(id: string, frequency: ScheduleFrequency, overrides: Partial<BotRoutine> = {}): BotRoutine {
	return {
		id,
		name: `Routine ${id}`,
		prompt: `Prompt of ${id}`,
		frequency,
		enabled: true,
		next: null,
		runs: [],
		...overrides,
	};
}

function run(id: string, overrides: Partial<ScheduleRun> = {}): ScheduleRun {
	return {
		id,
		scheduleId: "r1",
		trigger: "schedule",
		startedAt: "2026-11-01T06:00:00.000Z",
		endedAt: "2026-11-01T06:01:00.000Z",
		status: "succeeded",
		exitCode: null,
		error: null,
		...overrides,
	};
}

/** The board's routines section as the bot's pane draws it; `device` is a paired host's id. */
async function mountRoutines(routines: BotRoutine[], device?: string): Promise<void> {
	installApi();
	const state: BotDeskState = { ...EMPTY_BOT_DESK, routines };
	useBotDeskStore.getState().apply(state, device);
	await mount(
		<BotTabContext.Provider value={{ tabId: "tbot", device }}>
			<BotBoardSections device={device} tabId="tbot" />
		</BotTabContext.Provider>,
	);
}

const row = (id: string) => query(`[data-bot-routine="${id}"]`);
const open = (id: string) => click(row(id));

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container.remove();
	useBotDeskStore.getState().reset();
	useMobileWebStore.getState().reset();
	useToastStore.setState({ toasts: [] } as never);
	command.mockClear();
	vi.unstubAllGlobals();
	delete (window as unknown as { omp?: unknown }).omp;
});

describe("the bot's routines", () => {
	it("say what starts each one and when, or what it waits for", async () => {
		const next = "2026-11-02T09:30:00.000Z";
		await mountRoutines([
			routine("a", { kind: "interval", minutes: 30 }, { next }),
			routine("b", { kind: "daily", time: "09:30", days: [] }, { next }),
			routine("c", { kind: "once", at: next }, { next }),
			routine("d", { kind: "once", at: "2026-10-31T09:30:00.000Z" }, { enabled: false, runs: [run("x")] }),
			routine("e", { kind: "interval", minutes: 120 }, { enabled: false }),
		]);

		expect(text('[data-bot-routine="a"]')).toContain("Every 30 min");
		expect(text('[data-bot-routine="a"]')).toContain(formatClock(next));
		expect(text('[data-bot-routine="b"]')).toContain("Every day at 09:30");
		expect(text('[data-bot-routine="c"]')).toContain(`Once at ${formatClock(next)}`);
		// A once routine that ran is spent; a paused repeating one is off.
		expect(text('[data-bot-routine="d"]')).toContain(translate("botHome.routines.done"));
		expect(text('[data-bot-routine="e"]')).toContain("Every 2 h");
		expect(text('[data-bot-routine="e"]')).toContain(translate("botHome.routines.off"));
	});

	it("say the event that starts an event routine, which waits on it", async () => {
		await mountRoutines([
			routine("w", { kind: "event", event: { source: "webhook", key: "k".repeat(24) } }),
			routine("g", {
				kind: "event",
				event: { source: "github", repo: "octo/app", events: ["pull_request", "ci_failure"] },
			}),
			routine("f", { kind: "event", event: { source: "files", path: "/work/app/src" } }),
			routine("b", { kind: "event", event: { source: "git", repo: "/work/app", branch: "main" } }),
			routine("s", { kind: "event", event: { source: "session", events: ["done", "failed"] } }),
		]);

		expect(text('[data-bot-routine="w"]')).toContain("On a webhook call");
		expect(text('[data-bot-routine="w"]')).toContain(translate("botHome.routines.onEvent"));
		expect(text('[data-bot-routine="g"]')).toContain("GitHub pull requests and CI failures in octo/app");
		expect(text('[data-bot-routine="f"]')).toContain("When files change under src");
		expect(text('[data-bot-routine="b"]')).toContain("New commits on main");
		expect(text('[data-bot-routine="s"]')).toContain("When a session finishes a turn or fails a turn");
	});

	it("tint the lead mark by the last run", async () => {
		const every = { kind: "interval", minutes: 30 } as const;
		await mountRoutines([
			routine("a", every, { runs: [run("1", { status: "running", endedAt: null })] }),
			routine("b", every, { runs: [run("2", { status: "failed", error: "boom" })] }),
			routine("c", every, { runs: [run("3")] }),
			routine("d", every),
		]);

		const tone = (id: string) => query(`[data-bot-routine="${id}"] .omp-work-board-kind`)?.getAttribute("data-tone");
		expect([tone("a"), tone("b"), tone("c"), tone("d")]).toEqual(["info", "danger", "success", "muted"]);
		expect(text('[data-bot-routine="a"]')).toContain(translate("schedules.status.running"));
	});

	it("open in place to the prompt and the trigger in full", async () => {
		await mountRoutines([
			routine(
				"f",
				{ kind: "event", event: { source: "files", path: "/work/app/src" } },
				{ prompt: "Summarise the change" },
			),
		]);

		expect(query("[data-bot-routine-detail]")).toBeNull();
		await open("f");
		expect(row("f")?.getAttribute("aria-expanded")).toBe("true");
		expect(text("[data-bot-routine-prompt]")).toBe("Summarise the change");
		expect(text("[data-bot-routine-trigger]")).toBe("When files change under src");
		expect(text("[data-bot-routine-detail]")).toContain("/work/app/src");
		await open("f");
		expect(query("[data-bot-routine-detail]")).toBeNull();
	});

	it("keep the history of every run, newest first, with what fired it and why one failed", async () => {
		await mountRoutines([
			routine(
				"r1",
				{ kind: "interval", minutes: 30 },
				{
					runs: [
						run("a", { trigger: "event", detail: "PR #12 opened\nby octocat", status: "running", endedAt: null }),
						run("b", { trigger: "manual", status: "failed", error: "The session could not be opened" }),
						run("c", { status: "succeeded" }),
						run("d", { status: "skipped", error: "The previous run was still going" }),
						run("e", { status: "stopped" }),
					],
				},
			),
		]);
		await open("r1");

		expect(queryAll("[data-bot-routine-run]").map(item => item.getAttribute("data-status"))).toEqual([
			"running",
			"failed",
			"succeeded",
			"skipped",
			"stopped",
		]);
		const first = text('[data-bot-routine-run="a"]');
		expect(first).toContain("Running");
		expect(first).toContain(translate("botHome.routines.trigger.event"));
		expect(queryAll('[data-bot-routine-run="a"] [data-bot-run-detail]').map(line => line.textContent)).toEqual([
			"PR #12 opened",
			"by octocat",
		]);
		// The reason is words on the row, not only a tooltip.
		expect(text('[data-bot-routine-run="b"] [data-bot-run-error]')).toBe("The session could not be opened");
		expect(text('[data-bot-routine-run="b"]')).toContain(translate("botHome.routines.trigger.manual"));
		expect(text('[data-bot-routine-run="b"]')).toContain("Failed");
		expect(text('[data-bot-routine-run="c"]')).toContain(translate("botHome.routines.trigger.schedule"));
		expect(text('[data-bot-routine-run="c"]')).toContain("Succeeded");
		expect(text('[data-bot-routine-run="d"]')).toContain("Skipped");
		expect(text('[data-bot-routine-run="e"]')).toContain("Stopped");
	});

	it("say a routine has not run yet", async () => {
		await mountRoutines([routine("r1", { kind: "interval", minutes: 30 })]);
		await open("r1");
		expect(query("[data-bot-routine-no-runs]")).not.toBeNull();
	});

	it("test, pause and resume with the exact request, and Test waits while a run is going", async () => {
		await mountRoutines([
			routine("r1", { kind: "interval", minutes: 30 }, { next: "2026-11-02T09:30:00.000Z" }),
			routine("r2", { kind: "interval", minutes: 30 }, { enabled: false }),
			routine("r3", { kind: "interval", minutes: 30 }, { runs: [run("x", { status: "running", endedAt: null })] }),
		]);

		await open("r1");
		await click(query("[data-bot-routine-test]"));
		await click(query("[data-bot-routine-toggle]"));
		expect(command.mock.calls).toEqual([
			[{ action: "runNow", id: "r1" }, undefined],
			[{ action: "setEnabled", id: "r1", enabled: false }, undefined],
		]);

		await open("r1");
		await open("r2");
		expect(text("[data-bot-routine-toggle]")).toBe(translate("botHome.routines.resume"));
		await click(query("[data-bot-routine-toggle]"));
		expect(command).toHaveBeenLastCalledWith({ action: "setEnabled", id: "r2", enabled: true }, undefined);

		await open("r2");
		await open("r3");
		expect(props<{ disabled?: boolean }>(query("[data-bot-routine-test]")).disabled).toBe(true);
	});

	it("delete only after the owner confirms, and a refusal is a toast", async () => {
		await mountRoutines([routine("r1", { kind: "interval", minutes: 30 }, { name: "Nightly build" })]);
		await open("r1");
		await click(query("[data-bot-routine-delete]"));
		expect(command).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain(translate("botHome.routines.deleteTitle"));

		command.mockRejectedValueOnce(new Error("schedule is gone"));
		const confirm = [...document.body.querySelectorAll('[role="dialog"] button')].find(
			item => (item.textContent ?? "").trim() === translate("botHome.routines.delete"),
		);
		await click((confirm ?? null) as Element | null);
		expect(command).toHaveBeenCalledWith({ action: "delete", id: "r1" }, undefined);
		expect(
			useToastStore.getState().toasts.some(entry => entry.title === translate("botHome.routines.actionFailed")),
		).toBe(true);
	});

	it("act on the paired host that holds the routine", async () => {
		await mountRoutines([routine("r1", { kind: "interval", minutes: 30 })], "mini");
		await open("r1");
		await click(query("[data-bot-routine-test]"));
		await click(query("[data-bot-routine-toggle]"));
		await click(query("[data-bot-routine-delete]"));
		const confirm = [...document.body.querySelectorAll('[role="dialog"] button')].find(
			item => (item.textContent ?? "").trim() === translate("botHome.routines.delete"),
		);
		await click((confirm ?? null) as Element | null);

		expect(command.mock.calls).toEqual([
			[{ action: "runNow", id: "r1" }, "mini"],
			[{ action: "setEnabled", id: "r1", enabled: false }, "mini"],
			[{ action: "delete", id: "r1" }, "mini"],
		]);
	});

	it("edit by putting the request in the bot tab's composer, ahead of any draft", async () => {
		const filled: unknown[] = [];
		window.addEventListener("omp:fill-composer", event => {
			if (event instanceof CustomEvent) filled.push(event.detail);
		});
		await mountRoutines([routine("r1", { kind: "interval", minutes: 30 }, { name: "Nightly build" })]);
		await open("r1");
		await click(query("[data-bot-routine-edit]"));

		expect(filled).toEqual([{ text: "Edit your routine “Nightly build” (id r1): ", tabId: "tbot", prepend: true }]);
		expect(command).not.toHaveBeenCalled();
	});

	it("copy a ready curl command for a webhook when this computer's Mobile web address is known", async () => {
		const writeText = vi.fn(async () => {});
		vi.stubGlobal("navigator", { clipboard: { writeText } });
		useMobileWebStore.setState({ state: { phase: "ready", url: "https://mac.tail.ts.net:47831" } as never });
		const key = "k".repeat(24);
		await mountRoutines([routine("w1", { kind: "event", event: { source: "webhook", key } })]);
		await open("w1");

		expect(query("[data-bot-routine-webhook-hint]")).toBeNull();
		await click(query('[data-bot-routine-copy="command"]'));
		expect(writeText).toHaveBeenCalledWith(
			`curl -X POST https://mac.tail.ts.net:47831/hooks/w1 -H "Authorization: Bearer ${key}"`,
		);
	});

	it("copy the key with the path and a hint when no address is known, and for a paired host's webhook", async () => {
		const writeText = vi.fn(async () => {});
		vi.stubGlobal("navigator", { clipboard: { writeText } });
		// This computer's Mobile web is ready, but the routine runs on the host: its address is not this one.
		useMobileWebStore.setState({ state: { phase: "ready", url: "https://mac.tail.ts.net:47831" } as never });
		const key = "k".repeat(24);
		await mountRoutines([routine("w1", { kind: "event", event: { source: "webhook", key } })], "mini");
		await open("w1");

		expect(text("[data-bot-routine-webhook-hint]")).toContain("/hooks/w1");
		await click(query('[data-bot-routine-copy="key"]'));
		expect(writeText).toHaveBeenCalledWith(key);
	});
});
