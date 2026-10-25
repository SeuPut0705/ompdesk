import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcAsyncJobItem, RpcJobRow, SubagentSnapshot } from "../../../../shared/rpc-types";
import { I18nProvider, translate } from "../../../lib/i18n";
import { useExtensionUiStore } from "../../../stores/extension-ui";
import { useSessionStore } from "../../../stores/session";
import { useSidebarSubagentsStore } from "../../../stores/sidebar-subagents";
import { useSubagentsStore } from "../../../stores/subagents";
import { useTabsStore } from "../../../stores/tabs";
import { useUiStore } from "../../../stores/ui";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

let rows: RpcJobRow[] = [];
const getJobs = vi.fn(async () => ({ type: "response", command: "get_jobs", success: true, data: { rows } }));
Reflect.set(window, "omp", { rpc: { getJobs } });

// Loaded after the linkedom globals exist: react-dom reads `window`/`document` at import.
const { createRoot } = await import("react-dom/client");
const { WorkspaceIsland } = await import("./WorkspaceIsland");

let container: HTMLElement;
let root: Root;

function agent(id: string, status: string): SubagentSnapshot {
	return { id, index: 0, agent: "task", status, lastUpdate: 0 };
}

function job(id: string, type: RpcAsyncJobItem["type"], status: RpcAsyncJobItem["status"], depth = 0): RpcJobRow {
	return { kind: "job", depth, cancellable: depth === 0, job: { id, type, status, label: id, startTime: 0 } };
}

async function mount(): Promise<void> {
	useTabsStore.setState({
		tabs: [{ id: "t1", cwd: "/w", status: "ready", kind: "agent", unreadDone: false }],
		activeTabId: "t1",
		bundles: new Map(),
	});
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<WorkspaceIsland />
			</I18nProvider>,
		);
	});
	// The first jobs read lands.
	await act(async () => {});
}

function segment(name: string): HTMLButtonElement | null {
	return container.querySelector(`[data-island-segment="${name}"]`) as unknown as HTMLButtonElement | null;
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	rows = [];
	getJobs.mockClear();
	useSubagentsStore.getState().reset();
	useExtensionUiStore.getState().clearAll();
	useTabsStore.getState().reset();
	useSidebarSubagentsStore.setState({ reveal: null });
	useUiStore.setState({ sidebarVisible: true });
	useSessionStore.setState({ isStreaming: false });
});

describe("WorkspaceIsland", () => {
	it("stays out of the way with no agents and no running shells", async () => {
		rows = [job("j1", "bash", "completed"), job("j2", "task", "running"), job("j3", "bash", "completed", 1)];
		useSubagentsStore.getState().setSnapshots([agent("a1", "completed")]);
		await mount();
		expect(getJobs).toHaveBeenCalled();
		expect(container.querySelector("[data-workspace-island]")).toBeNull();
	});

	it("hides while a turn runs on the tab (the live work card says the same lanes), and shows again after", async () => {
		useSubagentsStore.getState().setSnapshots([agent("a1", "running")]);
		useSessionStore.setState({ isStreaming: true });
		await mount();
		expect(container.querySelector("[data-workspace-island]")).toBeNull();
		await act(async () => useSessionStore.setState({ isStreaming: false }));
		expect(segment("agents")).not.toBeNull();
	});

	it("counts working and waiting agents and reveals them, leaving the session's own question to its card", async () => {
		useSubagentsStore
			.getState()
			.setSnapshots([agent("a1", "running"), agent("a2", "pending"), agent("a3", "parked"), agent("a4", "failed")]);
		useExtensionUiStore
			.getState()
			.pushRequest({ type: "extension_ui_request", id: "q1", method: "ask", title: "?" } as never);
		useUiStore.setState({ sidebarVisible: false });
		await mount();

		const agents = segment("agents");
		expect(agents?.textContent).toContain("Agents");
		expect(agents?.textContent).toContain("2 working");
		expect(agents?.textContent).toContain("1 waiting");
		expect(agents?.textContent).not.toContain(translate("attention.question"));
		expect(segment("shells")).toBeNull();

		await act(async () => agents?.click());
		expect(useUiStore.getState().sidebarVisible).toBe(true);
		expect(useSidebarSubagentsStore.getState().reveal?.tabId).toBe("t1");
	});

	it("counts running background shells, a subagent's nested ones too, and opens Background tasks", async () => {
		rows = [
			job("j1", "bash", "running"),
			job("j2", "eval", "running"),
			job("j3", "task", "running"),
			job("j4", "bash", "running", 1),
			job("j5", "bash", "completed", 1),
		];
		await mount();
		const shells = segment("shells");
		expect(shells?.textContent).toBe("Shells 3 running");
		expect(segment("agents")).toBeNull();
		await act(async () => shells?.click());
		expect(useUiStore.getState().viewSheet?.view).toBe("jobs");
	});
});
