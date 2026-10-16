import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent, RpcCommand, RpcResponse } from "../../shared/rpc-types";
import { createTabRuntime } from "../stores/tab-runtime";
import { useTabsStore } from "../stores/tabs";
import { useUiStore } from "../stores/ui";
import { devServerUrl, handleAutoOpenEvents, PANEL_IDLE_MS, panelYields, resetPanelAutoOpen } from "./panel-auto-open";

const prefs = new Map<string, unknown>();
(globalThis as Record<string, unknown>).window = {
	omp: { prefs: { get: async (key: string) => prefs.get(key), set: async () => {} } },
};

const TAB = "t1";
const commands: RpcCommand[] = [];

function ok(data: unknown): RpcResponse {
	return { type: "response", command: "x", success: true, data } as RpcResponse;
}

function mountTab(id: string): void {
	const runtime = createTabRuntime(id);
	runtime.command = async command => {
		commands.push(command);
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

async function settle(): Promise<void> {
	for (let index = 0; index < 10; index++) await Promise.resolve();
}

beforeEach(() => {
	prefs.clear();
	commands.length = 0;
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
