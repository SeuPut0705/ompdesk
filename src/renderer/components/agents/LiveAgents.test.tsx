/**
 * Agents › Live: rows lead with the task label (task ?? assignment ??
 * description, truncated 60) so two same-type agents are distinguishable,
 * carry status/elapsed/model/kind, and expose view messages (transcript
 * Sheet), stop (inline-confirmed abort_subagent) and revive
 * (revive_subagent) actions.
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { AgentProgress, SubagentSnapshot } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { useSubagentsStore } from "../../stores/subagents";
import { routeCommands } from "../../test-support/route-commands";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);
(window as unknown as Record<string, unknown>).setTimeout = setTimeout;
(window as unknown as Record<string, unknown>).clearTimeout = clearTimeout;

// Deferred until after the globals above: react-dom computes DOM support
// flags at evaluation time.
const { createRoot } = await import("react-dom/client");
const { LiveAgents } = await import("./LiveAgents");

type RpcResult = { type: "response"; command: string; success: boolean; data?: unknown; error?: string };

function ok(data: unknown): RpcResult {
	return { type: "response", command: "x", success: true, data };
}

interface OmpMock {
	getSubagents: Mock;
	getSubagentMessages: Mock;
	abortSubagent: Mock;
	setAgentsPaused: Mock;
	reviveSubagent: Mock;
	abortAndRestoreQueue: Mock;
}

function installOmpMock(overrides: Partial<OmpMock> = {}): OmpMock {
	const mock: OmpMock = {
		getSubagents: vi.fn(async () => ok({ subagents: [] })),
		getSubagentMessages: vi.fn(async () => ok({ messages: [], nextByte: 0 })),
		abortSubagent: vi.fn(async () => ok({ ok: true })),
		reviveSubagent: vi.fn(async () => ok({ ok: true })),
		setAgentsPaused: vi.fn(async (enabled: boolean) => ok({ paused: enabled, pausedAt: enabled ? 123 : undefined })),
		abortAndRestoreQueue: vi.fn(async () => ok({ steering: [], followUp: [] })),
		...overrides,
	};
	(window as unknown as { omp: { rpc: OmpMock } }).omp = { rpc: routeCommands(mock) };
	return mock;
}

function snap(overrides: Partial<SubagentSnapshot>): SubagentSnapshot {
	return { id: "a1", index: 1, agent: "scout", status: "running", lastUpdate: Date.now(), ...overrides };
}

function progress(overrides: Partial<AgentProgress>): AgentProgress {
	return {
		index: 1,
		id: "a1",
		agent: "scout",
		agentSource: "bundled",
		status: "running",
		task: "t",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 1,
		tokens: 10,
		cost: 0,
		durationMs: 61_000,
		...overrides,
	};
}

function seedHub(): void {
	useSubagentsStore.getState().setSnapshots([
		snap({
			id: "a1",
			index: 1,
			task: "x".repeat(70),
			kind: "sub",
			progress: progress({ id: "a1", resolvedModel: "openai/gpt-5.2-codex", description: "editing files" }),
		}),
		snap({ id: "a2", index: 2, status: "parked", task: "short second task", kind: "sub" }),
		snap({ id: "a3", index: 3, task: "advisor review", kind: "advisor" }),
	]);
}

let container: HTMLElement;
let root: Root;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
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
	useSubagentsStore.getState().reset();
	useSessionStore.getState().reset();
});

interface TestElement {
	dispatchEvent: (event: object) => boolean;
	textContent: string | null;
}

function queryAll(selector: string): TestElement[] {
	return Array.from(document.querySelectorAll(selector)) as unknown as TestElement[];
}

/** Dispatch inside act(); linkedom's Event has a getter-only eventPhase React writes to. */
async function dispatch(target: TestElement, event: InstanceType<typeof Event>): Promise<void> {
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	await act(async () => {
		target.dispatchEvent(event);
	});
}

async function click(element: TestElement): Promise<void> {
	await dispatch(element, new Event("click", { bubbles: true, cancelable: true }));
}

function bodyText(): string {
	return document.body.textContent ?? "";
}

describe("LiveAgents", () => {
	it("hides pause-all while there are no agents to pause", async () => {
		installOmpMock();
		useSessionStore.getState().setStatus("ready", "/repo");
		await mount(<LiveAgents />);

		expect(queryAll('button[title="Freeze all agents until resumed"]')).toHaveLength(0);
	});
	it("pauses and resumes all agents from the hub header", async () => {
		const omp = installOmpMock();
		useSessionStore.getState().setStatus("ready", "/repo");
		seedHub();
		await mount(<LiveAgents />);

		const pause = queryAll('button[title="Freeze all agents until resumed"]')[0];
		if (!pause) throw new Error("pause button not found");
		await click(pause);
		expect(omp.setAgentsPaused).toHaveBeenCalledWith(true);
		expect(useSessionStore.getState().agentsPaused).toBe(true);

		const resume = queryAll('button[title="Resume all agents"]')[0];
		if (!resume) throw new Error("resume button not found");
		await click(resume);
		expect(omp.setAgentsPaused).toHaveBeenCalledWith(false);
		expect(useSessionStore.getState().agentsPaused).toBe(false);
	});
	it("distinguishes same-type agents by task label and shows model/kind/status", async () => {
		installOmpMock();
		seedHub();
		await mount(<LiveAgents />);

		// Primary label: task truncated to 60 chars (59 + …); both scout agents
		// are told apart by their labels, not their type name.
		expect(bodyText()).toContain(`${"x".repeat(59)}…`);
		expect(bodyText()).toContain("short second task");
		// Secondary line: agent type, kind badges, resolved model, progress note.
		expect(bodyText()).toContain("openai/gpt-5.2-codex");
		expect(bodyText()).toContain("editing files");
		expect(bodyText()).toContain("Read-only");
		expect(bodyText()).toContain("Subagent");
		// Status badges for the seeded statuses.
		expect(bodyText()).toContain("running");
		expect(bodyText()).toContain("parked");
	});

	it("ranks assignment above the rendered task template, description above task", async () => {
		installOmpMock();
		useSubagentsStore.getState().setSnapshots([
			snap({
				id: "a1",
				index: 1,
				task: "<rendered prompt template with instructions>",
				assignment: "raw scout task",
			}),
			snap({ id: "a2", index: 2, task: "<another rendered template>", description: "identity label" }),
		]);
		await mount(<LiveAgents />);

		// task-tool spawns wire task=renderSubagentUserPrompt(assignment): the raw
		// assignment/description must win over the template or cards are boilerplate.
		expect(bodyText()).toContain("raw scout task");
		expect(bodyText()).toContain("identity label");
		expect(bodyText()).not.toContain("rendered prompt template");
		expect(bodyText()).not.toContain("another rendered template");
	});

	it("says the roster failed to load instead of claiming nothing was spawned", async () => {
		installOmpMock({
			getSubagents: vi.fn(async () => ({
				type: "response",
				command: "get_subagents",
				success: false,
				error: "sidecar went away",
			})),
		});
		// Hydration's roster pull, which is the only read the hub tab gets until a
		// turn streams again.
		await act(async () => {
			await useSubagentsStore.getState().refresh();
		});
		await mount(<LiveAgents />);

		const text = document.body.textContent ?? "";
		expect(text).toContain(translate("subagent.loadFailed"));
		expect(text).toContain("sidecar went away");
		expect(text).not.toContain(translate("subagent.empty"));
	});

	it("view messages opens the transcript in a sheet and close dismisses it", async () => {
		const omp = installOmpMock();
		seedHub();
		await mount(<LiveAgents />);
		expect(omp.getSubagentMessages).not.toHaveBeenCalled();

		// Rows sort live-first by descending index: a3, a2, a1 — the last row is a1.
		const viewButtons = queryAll('button[aria-label="View messages"]');
		expect(viewButtons.length).toBe(3);
		await click(viewButtons[2]!);

		expect(omp.getSubagentMessages).toHaveBeenCalledWith("a1", undefined, 0);
		const sheet = queryAll('[role="dialog"]');
		expect(sheet.length).toBe(1);
		expect(sheet[0]!.textContent).toContain(`${"x".repeat(59)}…`);

		await click(queryAll('[role="dialog"] button[aria-label="Close"]')[0]!);
		// The sheet plays its exit before unmounting.
		await act(async () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 400);
			await promise;
		});
		expect(queryAll('[role="dialog"]').length).toBe(0);
	});

	it("abort runs through inline confirm; revive calls revive_subagent directly", async () => {
		// Post-action refetch keeps the parked row (a1 is released on abort).
		const omp = installOmpMock({
			getSubagents: vi.fn(async () =>
				ok({ subagents: [snap({ id: "a2", index: 2, status: "parked", task: "short second task", kind: "sub" })] }),
			),
		});
		seedHub();
		useSessionStore.getState().setStatus("ready", "/repo");
		await mount(<LiveAgents />);

		// Live non-advisor rows (parked a2 + running a1) get stop; advisor a3 doesn't.
		const abortButtons = queryAll('button[aria-label="Stop this agent"]');
		expect(abortButtons.length).toBe(2);
		await click(abortButtons[1]!); // a1

		expect(omp.abortSubagent).not.toHaveBeenCalled();
		await click(queryAll('button[aria-label="Confirm stop"]')[0]!);
		expect(omp.abortSubagent).toHaveBeenCalledWith("a1");
		expect(omp.getSubagents).toHaveBeenCalled();

		// Only the parked row offers revive.
		const reviveButtons = queryAll('button[aria-label="Revive this agent"]');
		expect(reviveButtons.length).toBe(1);
		await click(reviveButtons[0]!);
		expect(omp.reviveSubagent).toHaveBeenCalledWith("a2");
	});
});
