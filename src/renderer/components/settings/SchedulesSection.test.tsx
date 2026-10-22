/**
 * Settings › Schedules: the list main keeps (src/main/schedules.ts) with its
 * master switch, per-schedule switch, Run now / Stop, edit and delete, the
 * editor dialog, and recent runs with their logs.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Schedule, SchedulesRequest, SchedulesState } from "../../../shared/schedules";
import { I18nProvider } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { setFocusedSessionRuntime } from "../../stores/session-runtime-context";
import { useTabsStore } from "../../stores/tabs";
import { SchedulesSection } from "./SchedulesSection";

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

const SCHEDULE: Schedule = {
	id: "s1",
	name: "Nightly tidy",
	prompt: "Tidy the README",
	cwd: "/work/app",
	frequency: { kind: "daily", time: "09:30", days: [] },
	model: null,
	autoApprove: false,
	enabled: true,
	createdAt: "2026-10-01T00:00:00.000Z",
};

function emptyState(): SchedulesState {
	return { paused: false, schedules: [], runs: [], nextRuns: {} };
}

let state: SchedulesState = emptyState();
let failGet = false;
const command = vi.fn(async (request: SchedulesRequest, _device?: string): Promise<SchedulesState> => {
	if (request.action === "get" && failGet) throw new Error("disk unreadable");
	if (request.action === "save") {
		const schedule: Schedule = { ...request.draft, id: request.id ?? "new", createdAt: SCHEDULE.createdAt };
		state = { ...state, schedules: [...state.schedules.filter(item => item.id !== schedule.id), schedule] };
	}
	if (request.action === "setPaused") state = { ...state, paused: request.paused };
	if (request.action === "delete")
		state = { ...state, schedules: state.schedules.filter(item => item.id !== request.id) };
	return state;
});
const readLog = vi.fn(async (_runId: string) => "$ omp -p\n\nAll tidy.");
const showOpenDialog = vi.fn(async () => ["/work/app"]);
let hostListener: ((device: string, next: SchedulesState) => void) | null = null;
const onHostState = vi.fn((callback: (device: string, next: SchedulesState) => void) => {
	hostListener = callback;
	return () => {
		hostListener = null;
	};
});
Object.assign(window as unknown as Record<string, unknown>, {
	omp: { schedules: { command, readLog, onState: () => () => {}, onHostState }, system: { showOpenDialog } },
});

const roots: Root[] = [];
async function mount(): Promise<void> {
	const root = createRoot(document.body as unknown as globalThis.Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<SchedulesSection />
			</I18nProvider>,
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
	roots.push(root);
}

afterEach(async () => {
	for (const root of roots.splice(0)) await act(async () => root.unmount());
	document.body.innerHTML = "";
	state = emptyState();
	failGet = false;
	command.mockClear();
	readLog.mockClear();
	useSessionStore.getState().reset();
	useTabsStore.getState().reset();
});

function reactProps(element: object): Record<string, (event: object) => void> {
	const record = element as Record<string, unknown>;
	const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
	if (!key) throw new Error("react props not found");
	return record[key] as Record<string, (event: object) => void>;
}

async function click(element: object | null): Promise<void> {
	if (!element) throw new Error("click: element missing");
	await act(async () => reactProps(element).onClick?.({ preventDefault() {}, stopPropagation() {} }));
	await act(async () => {
		await Promise.resolve();
	});
}

function button(label: string): object | null {
	return (
		[...document.body.querySelectorAll("button")].find(
			item => item.getAttribute("aria-label") === label || (item.textContent ?? "").trim() === label,
		) ?? null
	);
}

async function type(label: string, value: string): Promise<void> {
	const field = [...document.body.querySelectorAll("label")].find(item => (item.textContent ?? "").trim() === label);
	const id = field?.getAttribute("for");
	const control = id ? document.body.querySelector(`[id="${id}"]`) : null;
	if (!control) throw new Error(`field "${label}" missing`);
	await act(async () => reactProps(control).onChange({ target: { value }, currentTarget: { value } }));
}

describe("SchedulesSection", () => {
	it("says when schedules run and creates one from the empty state", async () => {
		useSessionStore.setState({ cwd: "/work/app" });
		await mount();
		// A local tab: this computer's own service (no device).
		expect(command).toHaveBeenCalledWith({ action: "get" }, undefined);
		expect(document.body.textContent).toContain("Schedules run only while OMPdesk is open");
		expect(document.body.textContent).toContain("No schedules yet");

		await click(document.body.querySelector("[data-schedule-new]"));
		expect(document.body.querySelector("[data-schedule-cwd]")?.textContent).toBe("/work/app");
		// Nothing typed yet: the form says what is missing instead of saving.
		await act(async () =>
			reactProps(document.body.querySelector("[data-schedule-form]") as object).onSubmit({ preventDefault() {} }),
		);
		expect(document.body.textContent).toContain("Give the schedule a name.");
		expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ action: "save" }), undefined);

		await type("Name", "Nightly tidy");
		await type("Prompt", "Tidy the README");
		await click(document.body.querySelector('[data-schedule-day="1"]'));
		await act(async () =>
			reactProps(document.body.querySelector("[data-schedule-form]") as object).onSubmit({ preventDefault() {} }),
		);
		expect(command).toHaveBeenCalledWith(
			{
				action: "save",
				draft: {
					name: "Nightly tidy",
					prompt: "Tidy the README",
					cwd: "/work/app",
					frequency: { kind: "daily", time: "09:00", days: [1] },
					model: null,
					autoApprove: false,
					enabled: true,
				},
			},
			undefined,
		);
		const row = document.body.querySelector('[data-schedule="new"]');
		expect(row?.textContent).toContain("Nightly tidy");
		expect(row?.textContent).toContain("at 09:00 · app");
	});

	it("runs, stops, pauses, toggles and deletes from the list", async () => {
		state = {
			paused: false,
			schedules: [SCHEDULE],
			runs: [
				{
					id: "r1",
					scheduleId: "s1",
					trigger: "manual",
					startedAt: new Date().toISOString(),
					endedAt: null,
					status: "running",
					exitCode: null,
					error: null,
				},
			],
			nextRuns: { s1: new Date().toISOString() },
		};
		await mount();
		const row = document.body.querySelector('[data-schedule="s1"]');
		expect(row?.textContent).toContain("Every day at 09:30 · app");
		expect(row?.textContent).toContain("Running");

		await click(row?.querySelector('[aria-label="Stop Nightly tidy"]') ?? null);
		expect(command).toHaveBeenCalledWith({ action: "stop", runId: "r1" }, undefined);

		state = { ...state, runs: [] };
		await click(document.body.querySelector('[data-schedule-run-row="r1"] [aria-label="Stop Nightly tidy"]'));
		await act(async () =>
			reactProps(
				document.body.querySelector('[role="switch"][aria-label="Run Nightly tidy on schedule"]') as object,
			).onClick({}),
		);
		expect(command).toHaveBeenCalledWith({ action: "setEnabled", id: "s1", enabled: false }, undefined);

		const master = document.body.querySelector("[data-schedules-master]");
		await act(async () => reactProps(master as object).onClick({}));
		expect(command).toHaveBeenCalledWith({ action: "setPaused", paused: true }, undefined);
		expect(document.body.querySelector("[data-schedule-next]")?.textContent).toBe("Paused");

		await act(async () => (button("Actions for Nightly tidy") as HTMLButtonElement).click());
		const deleteItem = [...document.body.querySelectorAll('[role="menuitem"]')].find(item =>
			(item.textContent ?? "").includes("Delete"),
		) as HTMLElement | undefined;
		await act(async () => deleteItem?.click());
		expect(document.body.textContent).toContain("Delete this schedule?");
		const confirm = [...document.body.querySelectorAll('[role="dialog"] button')].find(
			item => (item.textContent ?? "").trim() === "Delete",
		);
		await click(confirm ?? null);
		expect(command).toHaveBeenCalledWith({ action: "delete", id: "s1" }, undefined);
		expect(document.body.textContent).toContain("No schedules yet");
	});

	it("lists recent runs with their outcome and opens a run's log", async () => {
		state = {
			paused: false,
			schedules: [SCHEDULE],
			runs: [
				{
					id: "r2",
					scheduleId: "s1",
					trigger: "schedule",
					startedAt: "2026-10-15T09:30:00.000Z",
					endedAt: "2026-10-15T09:31:05.000Z",
					status: "failed",
					exitCode: 2,
					error: null,
				},
				{
					id: "r1",
					scheduleId: "gone",
					trigger: "schedule",
					startedAt: "2026-10-14T09:30:00.000Z",
					endedAt: "2026-10-14T09:30:00.000Z",
					status: "skipped",
					exitCode: null,
					error: "The previous run was still going",
				},
			],
			nextRuns: { s1: null },
		};
		await mount();
		const failed = document.body.querySelector('[data-schedule-run-row="r2"]');
		expect(failed?.textContent).toContain("Failed");
		expect(failed?.textContent).toContain("omp exited with code 2");
		const skipped = document.body.querySelector('[data-schedule-run-row="r1"]');
		expect(skipped?.textContent).toContain("Skipped");
		expect(skipped?.textContent).toContain("Deleted schedule");
		expect(skipped?.querySelector("[aria-expanded]")).toBeNull();

		await click(failed?.querySelector("[aria-expanded]") ?? null);
		expect(readLog).toHaveBeenCalledWith("r2", undefined);
		expect(failed?.querySelector("[data-schedule-log]")?.textContent).toContain("All tidy.");
	});

	it("offers a retry when the schedules cannot load", async () => {
		failGet = true;
		await mount();
		expect(document.body.textContent).toContain("Couldn't load schedules");
		expect(document.body.textContent).toContain("disk unreadable");
		failGet = false;
		await click(button("Retry"));
		expect(document.body.textContent).toContain("No schedules yet");
	});

	it("shows and changes a paired host's schedules while the focused tab runs there", async () => {
		useTabsStore.setState({
			tabs: [
				{ id: "t1", cwd: "C:\\work", status: "ready", kind: "agent", unreadDone: false, device: "host-studio" },
			],
			activeTabId: "t1",
		});
		setFocusedSessionRuntime("t1");
		state = { ...emptyState(), schedules: [{ ...SCHEDULE, cwd: "C:\\work" }] };
		await mount();
		expect(command).toHaveBeenCalledWith({ action: "get" }, "host-studio");
		expect(onHostState).toHaveBeenCalledTimes(1);
		expect(document.body.querySelector('[data-schedule="s1"]')?.textContent).toContain("Nightly tidy");

		await click(document.body.querySelector('[data-schedule="s1"] [data-schedule-run]'));
		expect(command).toHaveBeenLastCalledWith({ action: "runNow", id: "s1" }, "host-studio");

		// The host pushes its own change; it replaces what the section shows. Another host's push does not.
		await act(async () => hostListener?.("host-other", { ...state, schedules: [] }));
		expect(document.body.querySelector('[data-schedule="s1"]')).not.toBeNull();
		await act(async () => hostListener?.("host-studio", { ...state, paused: true }));
		expect(document.body.querySelector("[data-schedule-next]")?.textContent).toBe("Paused");
		expect(command.mock.calls.every(([, device]) => device === "host-studio")).toBe(true);
	});
});
