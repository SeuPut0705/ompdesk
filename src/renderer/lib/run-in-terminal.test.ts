/** "Run in terminal": the first live session (or a new one) gets the lines as typed, then the panel opens. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalOperation, TerminalSnapshot } from "../../shared/terminal-types";
import { useUiStore } from "../stores/ui";
import { runInTerminal } from "./run-in-terminal";

const snapshot = (id: string, exited: boolean): TerminalSnapshot => ({ id, output: "", offset: 0, exited });

function install(sessions: TerminalSnapshot[]) {
	const request = vi.fn(async (_tabId: string, operation: TerminalOperation) =>
		operation.action === "create" ? [...sessions, snapshot("new", false)] : sessions,
	);
	Reflect.set(globalThis, "window", { omp: { terminal: { request } } });
	return request;
}

afterEach(() => {
	Reflect.deleteProperty(globalThis, "window");
	useUiStore.setState({ panelTab: "diff" });
});

describe("runInTerminal", () => {
	it("types the block into the first live session and opens the Terminal panel", async () => {
		const request = install([snapshot("old", true), snapshot("live", false)]);
		await runInTerminal("t1", "cd app\nbun test\n");
		expect(request).toHaveBeenLastCalledWith("t1", { action: "write", id: "live", data: "cd app\rbun test\r" });
		expect(useUiStore.getState().panelTab).toBe("terminal");
	});

	it("starts a session when none is live", async () => {
		const request = install([snapshot("old", true)]);
		await runInTerminal("t1", "ls");
		expect(request).toHaveBeenCalledWith("t1", { action: "create", cols: 80, rows: 24 });
		expect(request).toHaveBeenLastCalledWith("t1", { action: "write", id: "new", data: "ls\r" });
	});
});
