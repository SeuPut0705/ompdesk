import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent, RpcCommand, RpcResponse } from "../../shared/rpc-types";
import { resetShellModeForTests } from "../hooks/use-shell-mode";
import { createTabRuntime } from "../stores/tab-runtime";
import { useTabsStore } from "../stores/tabs";
import { useUiStore } from "../stores/ui";
import {
	devServerUrl,
	EDIT_TOOLS,
	handleAutoOpenEvents,
	PANEL_IDLE_MS,
	panelYields,
	resetPanelAutoOpen,
} from "./panel-auto-open";

const prefs = new Map<string, unknown>();
const fakeWindow: Record<string, unknown> = {
	omp: { prefs: { get: async (key: string) => prefs.get(key), set: async () => {} } },
	location: { search: "" },
};
(globalThis as Record<string, unknown>).window = fakeWindow;

const TAB = "t1";
let fingerprints: Array<string | null> = [];
let repoChanges = 0;
const commands: RpcCommand[] = [];

function ok(data: unknown): RpcResponse {
	return { type: "response", command: "x", success: true, data } as RpcResponse;
}

function mountTab(id: string): void {
	const runtime = createTabRuntime(id);
	runtime.command = async command => {
		commands.push(command);
		if (command.type === "get_git_fingerprint") {
			const next = fingerprints.length > 1 ? fingerprints.shift() : fingerprints[0];
			return next === null || next === undefined
				? ({ type: "response", command: "x", success: false, error: "no git" } as RpcResponse)
				: ok({ fingerprint: next });
		}
		if (command.type === "get_git_status") {
			return ok({
				isRepo: repoChanges >= 0,
				branch: "main",
				staged: 0,
				unstaged: Math.max(0, repoChanges),
				untracked: 0,
			});
		}
		return ok(null);
	};
}

function focusTab(id: string): void {
	useTabsStore.setState({
		tabs: [{ id, cwd: "/p", status: "ready", compacting: false, kind: "agent", unreadDone: false }],
		activeTabId: id,
	});
}

function bashUpdate(text: string, command = "npm run dev", callId = "c1"): AgentSessionEvent {
	return {
		type: "tool_execution_update",
		toolCallId: callId,
		toolName: "bash",
		args: { command },
		partialResult: { content: [{ type: "text", text }] },
	};
}

const AGENT_START: AgentSessionEvent = { type: "agent_start" };
const AGENT_END: AgentSessionEvent = { type: "agent_end", messages: [] };
function editEnd(toolName = "edit", isError = false): AgentSessionEvent {
	return { type: "tool_execution_end", toolCallId: "e1", toolName, result: null, isError };
}

async function settle(): Promise<void> {
	for (let index = 0; index < 10; index++) await Promise.resolve();
}

beforeEach(() => {
	prefs.clear();
	prefs.set("autoPreviewDevServer", true);
	prefs.set("autoOpenChanges", true);
	commands.length = 0;
	fingerprints = ["a"];
	repoChanges = 1;
	resetPanelAutoOpen();
	useUiStore.setState({
		panelVisible: false,
		panelTab: "diff",
		previewUrl: null,
		destination: "session",
		fileEditDirty: false,
		pendingFileSwitch: null,
	});
	mountTab(TAB);
	focusTab(TAB);
});

afterEach(() => {
	vi.useRealTimers();
	useTabsStore.getState().reset();
});

describe("devServerUrl", () => {
	it("takes a server's own banner and a server-looking command", () => {
		expect(devServerUrl({ toolName: "bash", command: "npm run dev", text: "  Local: http://localhost:5173/" })).toBe(
			"http://localhost:5173/",
		);
		expect(
			devServerUrl({
				toolName: "bash",
				command: "python -m http.server 8000",
				text: "Serving HTTP on :: port 8000 (http://[::]:8000/)",
			}),
		).toBe("http://localhost:8000/");
		expect(
			devServerUrl({ toolName: "bash", command: "node app.js", text: "Server listening on http://127.0.0.1:3000" }),
		).toBe("http://127.0.0.1:3000/");
	});
	it("ignores clients, other tools, portless and remote addresses", () => {
		expect(
			devServerUrl({
				toolName: "bash",
				command: "curl -s http://localhost:3000/health",
				text: "http://localhost:3000",
			}),
		).toBeNull();
		expect(devServerUrl({ toolName: "read", command: undefined, text: "Local: http://localhost:5173/" })).toBeNull();
		expect(devServerUrl({ toolName: "bash", command: "npm run dev", text: "docs at http://localhost/" })).toBeNull();
		expect(devServerUrl({ toolName: "bash", command: "npm run dev", text: "see https://vite.dev/guide" })).toBeNull();
		expect(
			devServerUrl({ toolName: "bash", command: "git log", text: "fixed http://localhost:3000 typo" }),
		).toBeNull();
	});
});

describe("panelYields", () => {
	const base = { visible: false, tab: "diff" as const, dirty: false, pendingSwitch: false, idleMs: 0 };
	it("yields when closed, never over unsaved edits", () => {
		expect(panelYields(base)).toBe(true);
		expect(panelYields({ ...base, dirty: true })).toBe(false);
		expect(panelYields({ ...base, pendingSwitch: true })).toBe(false);
	});
	it("yields an open view only when it is a passive one left alone", () => {
		expect(panelYields({ ...base, visible: true, idleMs: PANEL_IDLE_MS - 1 })).toBe(false);
		expect(panelYields({ ...base, visible: true, idleMs: PANEL_IDLE_MS })).toBe(true);
		for (const tab of ["terminal", "files", "preview", "subagent"] as const)
			expect(panelYields({ ...base, visible: true, tab, idleMs: PANEL_IDLE_MS * 10 })).toBe(false);
	});
});

describe("dev server → Preview", () => {
	it("opens the Preview with the detected URL for the focused tab", async () => {
		handleAutoOpenEvents(TAB, [bashUpdate("Local: http://localhost:5173/")]);
		await settle();
		const ui = useUiStore.getState();
		expect([ui.panelVisible, ui.panelTab, ui.previewUrl]).toEqual([true, "preview", "http://localhost:5173/"]);
	});
	it("does nothing for an unfocused tab or a paired host's tab", async () => {
		mountTab("t2");
		handleAutoOpenEvents("t2", [bashUpdate("Local: http://localhost:5173/")]);
		await settle();
		expect(useUiStore.getState().panelVisible).toBe(false);
		useTabsStore.setState({
			tabs: [
				{ id: TAB, cwd: "/p", status: "ready", compacting: false, kind: "agent", unreadDone: false, device: "d1" },
			],
		});
		handleAutoOpenEvents(TAB, [bashUpdate("Local: http://localhost:5173/")]);
		await settle();
		expect(useUiStore.getState().panelVisible).toBe(false);
	});
	it("opens once per URL: a re-detection or a closed preview stays closed", async () => {
		handleAutoOpenEvents(TAB, [bashUpdate("Local: http://localhost:5173/")]);
		await settle();
		useUiStore.setState({ panelVisible: false });
		handleAutoOpenEvents(TAB, [bashUpdate("Local: http://localhost:5173/\nhmr update")]);
		await settle();
		expect(useUiStore.getState().panelVisible).toBe(false);
		handleAutoOpenEvents(TAB, [bashUpdate("Local: http://localhost:5174/")]);
		await settle();
		expect(useUiStore.getState().previewUrl).toBe("http://localhost:5174/");
	});
	it("leaves a busy panel, unsaved edits and the off switch alone", async () => {
		useUiStore.setState({ panelVisible: true, panelTab: "terminal" });
		handleAutoOpenEvents(TAB, [bashUpdate("Local: http://localhost:5001/")]);
		useUiStore.setState({ panelVisible: false, fileEditDirty: true });
		handleAutoOpenEvents(TAB, [bashUpdate("Local: http://localhost:5002/")]);
		useUiStore.setState({ fileEditDirty: false });
		prefs.set("autoPreviewDevServer", false);
		handleAutoOpenEvents(TAB, [bashUpdate("Local: http://localhost:5003/")]);
		await settle();
		const ui = useUiStore.getState();
		expect([ui.panelVisible, ui.panelTab, ui.previewUrl, ui.pendingFileSwitch]).toEqual([
			false,
			"terminal",
			null,
			null,
		]);
	});
	it("opens nothing while the switches were never turned on", async () => {
		prefs.clear();
		handleAutoOpenEvents(TAB, [bashUpdate("Local: http://localhost:5009/")]);
		handleAutoOpenEvents(TAB, [AGENT_START, editEnd(), AGENT_END]);
		await settle();
		expect(useUiStore.getState()).toMatchObject({ panelVisible: false, previewUrl: null });
	});
	it("takes a passive view only after it sat idle", async () => {
		vi.useFakeTimers();
		useUiStore.setState({ panelVisible: true, panelTab: "jobs" });
		handleAutoOpenEvents(TAB, [bashUpdate("Local: http://localhost:5001/")]);
		await settle();
		expect(useUiStore.getState().panelTab).toBe("jobs");
		vi.advanceTimersByTime(PANEL_IDLE_MS + 1);
		handleAutoOpenEvents(TAB, [bashUpdate("Local: http://localhost:5002/")]);
		await settle();
		expect(useUiStore.getState().panelTab).toBe("preview");
	});
});

describe("Changes after edits", () => {
	it("opens at the turn's end, not mid-stream, once", async () => {
		handleAutoOpenEvents(TAB, [AGENT_START]);
		await settle();
		handleAutoOpenEvents(TAB, [editEnd("write")]);
		await settle();
		expect(useUiStore.getState().panelVisible).toBe(false);
		handleAutoOpenEvents(TAB, [AGENT_END]);
		await settle();
		expect([useUiStore.getState().panelVisible, useUiStore.getState().panelTab]).toEqual([true, "diff"]);
		// The next turn with no edits and the panel closed again: nothing.
		useUiStore.setState({ panelVisible: false });
		handleAutoOpenEvents(TAB, [AGENT_START]);
		await settle();
		handleAutoOpenEvents(TAB, [AGENT_END]);
		await settle();
		expect(useUiStore.getState().panelVisible).toBe(false);
	});
	it("opens when only the git fingerprint moved (a bash edit)", async () => {
		fingerprints = ["a", "b"];
		handleAutoOpenEvents(TAB, [AGENT_START]);
		await settle();
		handleAutoOpenEvents(TAB, [AGENT_END]);
		await settle();
		expect(useUiStore.getState().panelVisible).toBe(true);
	});
	it("stays closed when nothing changed, a failed edit, or an edit that left no change", async () => {
		handleAutoOpenEvents(TAB, [AGENT_START, editEnd("edit", true), AGENT_END]);
		await settle();
		expect(useUiStore.getState().panelVisible).toBe(false);
		repoChanges = 0;
		handleAutoOpenEvents(TAB, [AGENT_START, editEnd("edit"), AGENT_END]);
		await settle();
		expect(useUiStore.getState().panelVisible).toBe(false);
	});
	it("never when the panel is open on another view, in an unfocused pane or over unsaved edits", async () => {
		useUiStore.setState({ panelVisible: true, panelTab: "terminal" });
		handleAutoOpenEvents(TAB, [AGENT_START, editEnd(), AGENT_END]);
		await settle();
		expect(useUiStore.getState().panelTab).toBe("terminal");
		useUiStore.setState({ panelVisible: false });
		mountTab("t2");
		handleAutoOpenEvents("t2", [AGENT_START, editEnd(), AGENT_END]);
		await settle();
		expect(useUiStore.getState().panelVisible).toBe(false);
		useUiStore.setState({ fileEditDirty: true });
		handleAutoOpenEvents(TAB, [AGENT_START, editEnd(), AGENT_END]);
		await settle();
		expect(useUiStore.getState()).toMatchObject({ panelVisible: false, pendingFileSwitch: null });
	});
	it("a deferred settle is not the turn's end; the off switch stops it", async () => {
		handleAutoOpenEvents(TAB, [AGENT_START, editEnd(), { type: "agent_end", messages: [], isTerminal: false }]);
		await settle();
		expect(useUiStore.getState().panelVisible).toBe(false);
		prefs.set("autoOpenChanges", false);
		handleAutoOpenEvents(TAB, [AGENT_END]);
		await settle();
		expect(useUiStore.getState().panelVisible).toBe(false);
	});
	it("does not reopen after the user closed it, until they reopen the panel themselves", async () => {
		handleAutoOpenEvents(TAB, [AGENT_START, editEnd(), AGENT_END]);
		await settle();
		expect(useUiStore.getState().panelVisible).toBe(true);
		useUiStore.getState().togglePanel(); // the user closes it
		handleAutoOpenEvents(TAB, [AGENT_START, editEnd(), AGENT_END]);
		await settle();
		expect(useUiStore.getState().panelVisible).toBe(false);
		useUiStore.getState().togglePanel(); // the user reopens
		useUiStore.getState().togglePanel(); // and closes it again
		handleAutoOpenEvents(TAB, [AGENT_START, editEnd(), AGENT_END]);
		await settle();
		expect(useUiStore.getState().panelVisible).toBe(true);
	});
	it("a view the user moved on to is not a close", async () => {
		handleAutoOpenEvents(TAB, [AGENT_START, editEnd(), AGENT_END]);
		await settle();
		useUiStore.getState().setPanelTab("files");
		useUiStore.getState().togglePanel();
		handleAutoOpenEvents(TAB, [AGENT_START, editEnd(), AGENT_END]);
		await settle();
		expect(useUiStore.getState().panelVisible).toBe(true);
	});
	it("lists the file-changing tools", () => {
		expect(Object.keys(EDIT_TOOLS).sort()).toEqual(["apply_patch", "ast_edit", "edit", "write"]);
	});
});

describe("Autopilot start", () => {
	it("opens no panel: the run's home is the work board", async () => {
		handleAutoOpenEvents(TAB, [
			{ type: "autopilot_update", status: { active: true, state: "running", run: "2026-10-17", cycle: 1 } },
		]);
		await settle();
		expect(useUiStore.getState()).toMatchObject({ panelVisible: false, panelTab: "diff" });
	});
});

describe("on a phone", () => {
	afterEach(() => {
		delete (globalThis as Record<string, unknown>).document;
		fakeWindow.location = { search: "" };
		resetShellModeForTests();
	});

	it("opens nothing by itself, whatever the switches say", async () => {
		(globalThis as Record<string, unknown>).document = { documentElement: { dataset: { platform: "web" } } };
		fakeWindow.location = { search: "?shell=phone" };
		resetShellModeForTests();
		handleAutoOpenEvents(TAB, [{ type: "autopilot_update", status: { active: true, state: "running", run: "p1" } }]);
		handleAutoOpenEvents(TAB, [bashUpdate("Local: http://localhost:5010/")]);
		handleAutoOpenEvents(TAB, [AGENT_START, editEnd(), AGENT_END]);
		await settle();
		expect(useUiStore.getState()).toMatchObject({ panelVisible: false, previewUrl: null });
	});
});
