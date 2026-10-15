import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BrowserWindow } from "electron";
import { describe, expect, it } from "vitest";
import { IPC_EVENTS, type IpcTabStatusPayload } from "../shared/ipc-types";
import type { RpcCommand, RpcResponse, SessionInfoUpdateFrame, SidecarStatus } from "../shared/rpc-types";
import type { SidecarSessionIdentity, SidecarStartGate } from "./sidecar";
import { type SidecarLike, SidecarPool } from "./sidecar-pool";
import type { PersistedTabLayout } from "./tab-layout";

/** Minimal SidecarManager stand-in: an EventEmitter with lifecycle recording. */
class FakeSidecar extends EventEmitter {
	started = false;
	disposed = false;
	restartArgs: Array<{ cwd: string | undefined; sessionPath: string | undefined }> = [];
	/** Side-channel frames written via sendSideChannel (F-UI-ORIGIN assertions). */
	sentFrames: object[] = [];
	rpcCommands: RpcCommand[] = [];
	constructor(public cwd: string) {
		super();
	}
	adoptCwd(cwd: string): boolean {
		if (cwd === this.cwd) return false;
		this.cwd = cwd;
		return true;
	}
	get status(): SidecarStatus {
		return this.currentStatus;
	}
	/**
	 * A manager exists before any process does: `start()` is what reports
	 * `starting`, exactly like SidecarManager.
	 */
	currentStatus: SidecarStatus = "asleep";
	/** Whether a child process is running (a failed health check reports `error` over a live one). */
	processAlive = false;
	readonly rpcClient = {
		command: async (command: RpcCommand): Promise<RpcResponse> => {
			this.rpcCommands.push(command);
			return { type: "response", command: command.type, success: true, data: { cancelled: false } };
		},
	};
	start(): void {
		this.started = true;
		if (this.currentStatus === "asleep") this.emitStatus("starting");
	}
	restart(cwd?: string, sessionPath?: string): void {
		this.restartArgs.push({ cwd, sessionPath });
		if (this.currentStatus === "asleep") this.emitStatus("starting");
	}
	kill(): void {}
	dispose(): void {
		this.disposed = true;
		this.removeAllListeners();
	}
	sendSideChannel(frame: object): void {
		this.sentFrames.push(frame);
	}
	emitStatus(status: SidecarStatus): void {
		this.currentStatus = status;
		this.emit("status", { status, cwd: this.cwd });
	}
	emitSessionInfo(frame: Omit<SessionInfoUpdateFrame, "type">): void {
		this.emit("sessionInfoUpdate", { type: "session_info_update", ...frame });
	}
	emitAgentEvents(types: string[]): void {
		this.emit(
			"events",
			types.map(type => ({ type })),
		);
	}
	emitExtensionUi(id: string): void {
		this.emit("extensionUi", {
			type: "extension_ui_request",
			id,
			method: "confirm",
			title: "Proceed?",
			message: "ok?",
		});
	}
	emitEditorText(id: string): void {
		this.emit("extensionUi", {
			type: "extension_ui_request",
			id,
			method: "set_editor_text",
			text: "restore me",
			prepend: true,
		});
	}
	emitHostToolCall(id: string): void {
		this.emit("hostToolCall", { type: "host_tool_call", id, name: "gui_tool", args: {} });
	}
	emitHostUriRequest(id: string): void {
		this.emit("hostUriRequest", { type: "host_uri_request", id, operation: "read", url: "https://example.com" });
	}
	emitUiRequest(request: Record<string, unknown>): void {
		this.emit("extensionUi", { type: "extension_ui_request", ...request });
	}
	emitSessionIdentity(identity: SidecarSessionIdentity): void {
		this.emit("session", identity);
	}
	emitEvents(events: Array<Record<string, unknown>>): void {
		this.emit("events", events);
	}
	/** Gates installed with setStartGate, and whether start() had run by then. */
	gates: Array<{ gate: SidecarStartGate; afterStart: boolean }> = [];
	setStartGate(gate: SidecarStartGate): void {
		this.gates.push({ gate, afterStart: this.started });
	}
	readonly exited = Promise.withResolvers<void>();
	whenExited(): Promise<void> {
		return this.exited.promise;
	}
}

interface FakeWindow {
	win: BrowserWindow;
	sent: Array<{ channel: string; data: unknown }>;
	close(): void;
	sentTo(channel: string): Array<{ channel: string; data: unknown }>;
}

/** Minimal BrowserWindow stand-in: captured sends + a triggerable "closed". */
function fakeWindow(id: number): FakeWindow {
	const emitter = new EventEmitter();
	const sent: Array<{ channel: string; data: unknown }> = [];
	let destroyed = false;
	const win = {
		webContents: {
			id,
			send: (channel: string, data: unknown) => {
				sent.push({ channel, data });
			},
		},
		isDestroyed: () => destroyed,
		once: (event: string, listener: () => void) => emitter.once(event, listener),
		removeListener: (event: string, listener: () => void) => emitter.removeListener(event, listener),
		listenerCount: (event: string) => emitter.listenerCount(event),
	} as unknown as BrowserWindow;
	return {
		win,
		sent,
		close: () => {
			destroyed = true;
			emitter.emit("closed");
		},
		sentTo: channel => sent.filter(entry => entry.channel === channel),
	};
}

function fakePool(): { pool: SidecarPool; sidecars: FakeSidecar[] } {
	const sidecars: FakeSidecar[] = [];
	const pool = new SidecarPool(cwd => {
		const sidecar = new FakeSidecar(cwd);
		sidecars.push(sidecar);
		return sidecar as unknown as SidecarLike;
	});
	return { pool, sidecars };
}

describe("SidecarPool session kind", () => {
	it("threads the spawn kind through the factory into TAB_STATUS payloads", () => {
		const kinds: Array<"agent" | "chat" | undefined> = [];
		const sidecars: FakeSidecar[] = [];
		const pool = new SidecarPool((cwd, kind) => {
			kinds.push(kind);
			const sidecar = new FakeSidecar(cwd);
			sidecars.push(sidecar);
			return sidecar as unknown as SidecarLike;
		});
		const fw = fakeWindow(1);

		pool.acquire("/a", fw.win, "tab-agent");
		pool.acquire("/b", fw.win, "tab-chat", undefined, "chat");
		// acquire defaults the kind to "agent" — the factory always sees a defined value.
		expect(kinds).toEqual(["agent", "chat"]);

		const [, chatSidecar] = sidecars;
		fw.sent.length = 0;
		chatSidecar?.emitStatus("ready");
		expect(fw.sentTo(IPC_EVENTS.TAB_STATUS).map(s => s.data)).toEqual([
			{ kind: "chat", tabId: "tab-chat", cwd: "/b", status: "ready", placeholder: false, sessionPath: null },
		]);

		// GET_TABS exposes the immutable kind for every tab.
		expect(pool.tabsForWindow(fw.win).map(tab => tab.kind)).toEqual(["agent", "chat"]);
	});
});

describe.skipIf(process.platform === "win32")("SidecarPool cwd spelling", () => {
	it("spawns every tab on the resolved path, so a symlinked spelling can't split a project", () => {
		const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ompdesk-cwd-")));
		try {
			const real = path.join(root, "project");
			const link = path.join(root, "link");
			fs.mkdirSync(real);
			fs.symlinkSync(real, link);
			const { pool } = fakePool();
			const fw = fakeWindow(1);

			pool.acquire(link, fw.win, "tab-link");
			pool.acquire(real, fw.win, "tab-real");
			pool.acquire("/no/such/dir", fw.win, "tab-missing");

			expect(pool.tabsForWindow(fw.win).map(tab => tab.cwd)).toEqual([real, real, "/no/such/dir"]);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("SidecarPool tabs", () => {
	it("binds two tabs to one window; the first is active", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		const a = pool.acquire("/a", fw.win, "tab-a");
		const b = pool.acquire("/b", fw.win, "tab-b");

		expect(a).not.toBeNull();
		expect(b).not.toBeNull();
		expect(pool.size).toBe(2);
		expect(sidecars.map(s => s.started)).toEqual([true, true]);
		expect(pool.sidecarForWindow(fw.win)).toBe(a);
		expect(pool.sidecarForTab(fw.win, "tab-b")).toBe(b);
		expect(pool.sidecarForTab(fw.win, "nope")).toBeNull();
		expect(pool.activeTabForWindow(fw.win)).toBe("tab-a");
		expect(pool.tabsForWindow(fw.win)).toEqual([
			{
				kind: "agent",
				tabId: "tab-a",
				cwd: "/a",
				status: "starting",
				active: true,
				visible: true,
				placeholder: false,
				sessionPath: null,
			},
			{ kind: "agent", tabId: "tab-b", cwd: "/b", status: "starting", placeholder: false, sessionPath: null },
		]);
	});

	it("mints a snowflake tabId when none is given", () => {
		const { pool } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win);
		const tabs = pool.tabsForWindow(fw.win);
		expect(tabs[0]?.tabId).toMatch(/^[0-9a-f]{16}$/);
	});

	it("resumes a session on first start when sessionPath is given", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		const sidecar = pool.acquire("/a", fw.win, "tab-a", "/sessions/s.jsonl");
		expect(sidecar).not.toBeNull();
		expect(sidecars[0]?.started).toBe(false);
		expect(sidecars[0]?.restartArgs).toEqual([{ cwd: undefined, sessionPath: "/sessions/s.jsonl" }]);
		expect(pool.tabsForWindow(fw.win)[0]?.sessionPath).toBe("/sessions/s.jsonl");
	});

	it("forwards full channels only from the active tab, TAB_STATUS from every tab", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		pool.acquire("/b", fw.win, "tab-b");
		const [a, b] = sidecars;
		fw.sent.length = 0;

		a?.emitAgentEvents(["agent_start"]);
		b?.emitAgentEvents(["agent_start"]);
		// Only the active tab's batch reaches the full channel…
		expect(fw.sentTo(IPC_EVENTS.EVENTS_BATCH).map(entry => entry.data)).toEqual([
			{ tabId: "tab-a", payload: [{ type: "agent_start" }] },
		]);
		// …but both tabs pushed TAB_STATUS for their running transition.
		const statuses = fw.sentTo(IPC_EVENTS.TAB_STATUS).map(s => s.data as IpcTabStatusPayload);
		expect(statuses).toEqual([
			{ kind: "agent", tabId: "tab-a", cwd: "/a", status: "starting", placeholder: false, sessionPath: null },
			{ kind: "agent", tabId: "tab-b", cwd: "/b", status: "starting", placeholder: false, sessionPath: null },
		]);

		// Connection status is forwarded on the full channel for the active tab only.
		a?.emitStatus("ready");
		b?.emitStatus("ready");
		expect(fw.sentTo(IPC_EVENTS.SIDECAR_STATUS)).toHaveLength(1);
		expect(fw.sentTo(IPC_EVENTS.TAB_STATUS)).toHaveLength(4);

		// Background sidecar emits nothing on the remaining full channels.
		b?.emit("subagentFrame", { type: "subagent_progress" });
		b?.emit("promptResult", { type: "prompt_result" });
		expect(fw.sentTo(IPC_EVENTS.SUBAGENT_FRAMES)).toHaveLength(0);
		expect(fw.sentTo(IPC_EVENTS.PROMPT_RESULT)).toHaveLength(0);
		a?.emit("promptResult", { type: "prompt_result" });
		expect(fw.sentTo(IPC_EVENTS.PROMPT_RESULT).map(entry => entry.data)).toEqual([
			{ tabId: "tab-a", payload: { type: "prompt_result" } },
		]);
	});

	it("routes a hidden tab's plan proposals and subagent lifecycle to its own runtime, once", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		pool.acquire("/b", fw.win, "tab-b");
		const [a, b] = sidecars;
		fw.sent.length = 0;

		// Hidden B: what its sidebar row reads still arrives, tagged with B's id;
		// the rest of its event stream and its progress frames stay home.
		const proposal = { type: "plan_proposal", planFilePath: "/plans/b.md" };
		const started = { type: "subagent_lifecycle", payload: { id: "sa-1", status: "started" } };
		b?.emitEvents([{ type: "message_update" }, proposal, { type: "agent_end" }]);
		b?.emit("subagentFrame", started);
		b?.emit("subagentFrame", { type: "subagent_progress", payload: { progress: { id: "sa-1" } } });
		expect(fw.sentTo(IPC_EVENTS.EVENTS_BATCH).map(entry => entry.data)).toEqual([
			{ tabId: "tab-b", payload: [proposal] },
		]);
		expect(fw.sentTo(IPC_EVENTS.SUBAGENT_FRAMES).map(entry => entry.data)).toEqual([
			{ tabId: "tab-b", payload: [started] },
		]);

		// Shown, B's full channel carries them: no second copy from the light one.
		expect(pool.setActiveTab(fw.win, "tab-b")).toBe(true);
		fw.sent.length = 0;
		b?.emit("subagentFrame", started);
		b?.emitEvents([proposal]);
		// Batched per frame; an agent-event batch sends the frames that came before it first.
		expect(fw.sent.map(entry => entry.channel)).toEqual([IPC_EVENTS.SUBAGENT_FRAMES, IPC_EVENTS.EVENTS_BATCH]);
		expect(fw.sentTo(IPC_EVENTS.EVENTS_BATCH).map(entry => entry.data)).toEqual([
			{ tabId: "tab-b", payload: [proposal] },
		]);
		expect(fw.sentTo(IPC_EVENTS.SUBAGENT_FRAMES).map(entry => entry.data)).toEqual([
			{ tabId: "tab-b", payload: [started] },
		]);
		// A response leaves after the frames batched before it, agent events or not.
		fw.sent.length = 0;
		b?.emit("subagentFrame", started);
		expect(fw.sentTo(IPC_EVENTS.SUBAGENT_FRAMES)).toHaveLength(0);
		b?.emit("beforeResponse");
		expect(fw.sentTo(IPC_EVENTS.SUBAGENT_FRAMES).map(entry => entry.data)).toEqual([
			{ tabId: "tab-b", payload: [started] },
		]);
		// And A, now hidden, gets the light routing instead.
		fw.sent.length = 0;
		a?.emitEvents([proposal]);
		expect(fw.sentTo(IPC_EVENTS.EVENTS_BATCH).map(entry => entry.data)).toEqual([
			{ tabId: "tab-a", payload: [proposal] },
		]);
	});

	it("synthesizes running/ready per tab from the agent event stream", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		pool.acquire("/b", fw.win, "tab-b");
		const [a, b] = sidecars;
		a?.emitStatus("ready");
		b?.emitStatus("ready");
		fw.sent.length = 0;

		// Background tab starts a run: TAB_STATUS reports running without any
		// full-channel leak.
		b?.emitAgentEvents(["agent_start"]);
		expect(fw.sentTo(IPC_EVENTS.EVENTS_BATCH)).toHaveLength(0);
		expect(fw.sentTo(IPC_EVENTS.TAB_STATUS).map(s => s.data)).toEqual([
			{ kind: "agent", tabId: "tab-b", cwd: "/b", status: "running", placeholder: false, sessionPath: null },
		]);
		expect(pool.tabsForWindow(fw.win)).toEqual([
			{
				kind: "agent",
				tabId: "tab-a",
				cwd: "/a",
				status: "ready",
				active: true,
				visible: true,
				placeholder: false,
				sessionPath: null,
			},
			{ kind: "agent", tabId: "tab-b", cwd: "/b", status: "running", placeholder: false, sessionPath: null },
		]);

		// Run settles → ready (the renderer's unreadDone signal for background tabs).
		fw.sent.length = 0;
		b?.emitAgentEvents(["agent_end"]);
		expect(fw.sentTo(IPC_EVENTS.TAB_STATUS).map(s => s.data)).toEqual([
			{
				kind: "agent",
				tabId: "tab-b",
				cwd: "/b",
				status: "ready",
				placeholder: false,
				sessionPath: null,
				lastRun: { stopReason: "stop" },
			},
		]);

		// A restart mid-run clears the flag: no stale "running" after recovery.
		fw.sent.length = 0;
		b?.emitAgentEvents(["agent_start"]);
		b?.emitStatus("restarting");
		b?.emitStatus("ready");
		expect(fw.sentTo(IPC_EVENTS.TAB_STATUS).map(s => (s.data as IpcTabStatusPayload).status)).toEqual([
			"running",
			"restarting",
			"ready",
		]);
		expect(pool.tabsForWindow(fw.win)[1]?.status).toBe("ready");
	});

	it("keeps a tab running until upstream background work settles", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		const sidecar = sidecars[0];
		sidecar?.emitStatus("ready");
		fw.sent.length = 0;

		sidecar?.emit("promptResult", {
			type: "prompt_result",
			agentInvoked: true,
			status: "completed",
			sessionSettled: false,
		});
		// EventBatcher can deliver agent_end after prompt_result; it must not
		// clear the running state while the session still awaits settlement.
		sidecar?.emitAgentEvents(["agent_start", "agent_end"]);
		expect((pool.tabsForWindow(fw.win)[0] as IpcTabStatusPayload).status).toBe("running");

		sidecar?.emit("sessionSettled", { type: "session_settled" });
		expect((pool.tabsForWindow(fw.win)[0] as IpcTabStatusPayload).status).toBe("ready");
	});

	it("re-wires forwarding on switch without duplicating listeners", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		pool.acquire("/b", fw.win, "tab-b");
		const [a, b] = sidecars;
		// Light wiring ("events" run-tracking) is always on; full wiring adds one more.
		expect(a?.listenerCount("events")).toBe(2);
		expect(b?.listenerCount("events")).toBe(1);

		expect(pool.setActiveTab(fw.win, "tab-b")).toBe(true);
		expect(a?.listenerCount("events")).toBe(1);
		expect(b?.listenerCount("events")).toBe(2);

		fw.sent.length = 0;
		a?.emitAgentEvents(["agent_start"]);
		b?.emitAgentEvents(["agent_start"]);
		expect(fw.sentTo(IPC_EVENTS.EVENTS_BATCH)).toHaveLength(1);
		expect(fw.sentTo(IPC_EVENTS.TAB_STATUS)).toHaveLength(2);

		// Switching back re-arms A exactly once (one batch per emit, not two).
		expect(pool.setActiveTab(fw.win, "tab-a")).toBe(true);
		expect(a?.listenerCount("events")).toBe(2);
		expect(b?.listenerCount("events")).toBe(1);
		fw.sent.length = 0;
		a?.emitAgentEvents(["agent_end"]);
		expect(fw.sentTo(IPC_EVENTS.EVENTS_BATCH)).toHaveLength(1);

		// Re-setting the already-active tab is a no-op.
		expect(pool.setActiveTab(fw.win, "tab-a")).toBe(true);
		expect(a?.listenerCount("events")).toBe(2);
		// Foreign/unknown tabs are refused.
		expect(pool.setActiveTab(fakeWindow(2).win, "tab-a")).toBe(false);
		expect(pool.setActiveTab(fw.win, "nope")).toBe(false);
	});

	it("forwards exactly two visible sessions and persists their split geometry", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		pool.acquire("/b", fw.win, "tab-b");
		pool.acquire("/c", fw.win, "tab-c");
		const [a, b, c] = sidecars;

		expect(
			pool.setTabView(fw.win, "tab-b", ["tab-a", "tab-b"], {
				axis: "columns",
				first: { tabId: "tab-a" },
				second: { tabId: "tab-b" },
				ratio: 0.65,
			}),
		).toBe(true);
		expect([a?.listenerCount("events"), b?.listenerCount("events"), c?.listenerCount("events")]).toEqual([2, 2, 1]);
		fw.sent.length = 0;
		a?.emitAgentEvents(["agent_start"]);
		b?.emitAgentEvents(["agent_start"]);
		c?.emitAgentEvents(["agent_start"]);
		expect(fw.sentTo(IPC_EVENTS.EVENTS_BATCH).map(entry => entry.data)).toEqual([
			{ tabId: "tab-a", payload: [{ type: "agent_start" }] },
			{ tabId: "tab-b", payload: [{ type: "agent_start" }] },
		]);
		expect(
			pool
				.tabsForWindow(fw.win)
				.filter(tab => tab.visible)
				.map(tab => tab.split),
		).toEqual([
			{ axis: "columns", first: { tabId: "tab-a" }, second: { tabId: "tab-b" }, ratio: 0.65 },
			{ axis: "columns", first: { tabId: "tab-a" }, second: { tabId: "tab-b" }, ratio: 0.65 },
		]);
		expect(pool.tabLayoutForWindow(fw.win)?.split).toEqual({
			axis: "columns",
			first: { tabId: "0" },
			second: { tabId: "1" },
			ratio: 0.65,
		});
		expect(pool.setTabView(fw.win, "tab-b", ["tab-a", "tab-b", "tab-c", "tab-d", "tab-e"])).toBe(false);

		expect(pool.releaseTab("tab-b")).toBe(true);
		expect(pool.activeTabForWindow(fw.win)).toBe("tab-a");
		expect(pool.tabLayoutForWindow(fw.win)?.split).toBeUndefined();
		expect(a?.listenerCount("events")).toBe(2);
		expect(c?.listenerCount("events")).toBe(1);
	});

	it("routes four visible streams and roundtrips a two-by-two layout", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		for (const id of ["a", "b", "c", "d", "e"]) pool.acquire(`/${id}`, fw.win, id);
		const split = {
			axis: "columns" as const,
			ratio: 0.5,
			first: { axis: "rows" as const, ratio: 0.6, first: { tabId: "a" }, second: { tabId: "b" } },
			second: { axis: "rows" as const, ratio: 0.4, first: { tabId: "c" }, second: { tabId: "d" } },
		};
		expect(pool.setTabView(fw.win, "c", ["a", "b", "c", "d"], split)).toBe(true);
		expect(sidecars.map(sidecar => sidecar.listenerCount("events"))).toEqual([2, 2, 2, 2, 1]);
		const layout = pool.tabLayoutForWindow(fw.win);
		expect(layout?.split).toEqual({
			axis: "columns",
			ratio: 0.5,
			first: { axis: "rows", ratio: 0.6, first: { tabId: "0" }, second: { tabId: "1" } },
			second: { axis: "rows", ratio: 0.4, first: { tabId: "2" }, second: { tabId: "3" } },
		});
		const restored = fakePool();
		if (!layout) throw new Error("expected layout");
		expect(restored.pool.restoreLayout(fakeWindow(2).win, layout)).toBe(5);
		expect(restored.sidecars.filter(sidecar => sidecar.started)).toHaveLength(4);
	});

	it("remembers off-screen splits per window, persists them and drops released tabs", () => {
		const { pool } = fakePool();
		const fw = fakeWindow(1);
		for (const id of ["a", "b", "c", "d", "e"]) pool.acquire(`/${id}`, fw.win, id);
		const ab = { axis: "columns" as const, ratio: 0.3, first: { tabId: "a" }, second: { tabId: "b" } };
		const cd = { axis: "rows" as const, ratio: 0.6, first: { tabId: "c" }, second: { tabId: "d" } };
		expect(pool.setTabView(fw.win, "e", ["e"], undefined, [ab, cd])).toBe(true);
		expect(pool.tabsForWindow(fw.win).flatMap(tab => (tab.rememberedSplit ? [tab.tabId] : []))).toEqual(["a", "c"]);
		const layout = pool.tabLayoutForWindow(fw.win);
		expect(layout?.splits).toEqual([
			{ axis: "columns", ratio: 0.3, first: { tabId: "0" }, second: { tabId: "1" } },
			{ axis: "rows", ratio: 0.6, first: { tabId: "2" }, second: { tabId: "3" } },
		]);

		// A relaunch restores them under the new tab ids.
		const restored = fakePool();
		const restoredWindow = fakeWindow(2);
		if (!layout) throw new Error("expected layout");
		restored.pool.restoreLayout(restoredWindow.win, layout);
		expect(restored.pool.tabLayoutForWindow(restoredWindow.win)?.splits).toEqual(layout.splits);
		expect(restored.pool.tabLayoutForWindow(restoredWindow.win)?.split).toBeUndefined();

		// Another window knows nothing of them; a plain focus switch keeps them but never overlaps the screen.
		expect(fakePool().pool.tabsForWindow(fakeWindow(3).win)).toEqual([]);
		expect(pool.setActiveTab(fw.win, "c")).toBe(true);
		expect(pool.tabLayoutForWindow(fw.win)?.splits).toEqual([layout?.splits?.[0]]);
		// Releasing a member dissolves its split; a list sent with the view replaces the stored one.
		expect(pool.setTabView(fw.win, "e", ["e"], undefined, [cd])).toBe(true);
		expect(pool.releaseTab("d")).toBe(true);
		expect(pool.tabLayoutForWindow(fw.win)?.splits).toBeUndefined();
		expect(pool.setTabView(fw.win, "e", ["e"], undefined, [ab])).toBe(true);
		expect(pool.tabLayoutForWindow(fw.win)?.splits).toHaveLength(1);
		expect(pool.setTabView(fw.win, "e", ["e"], undefined, [])).toBe(true);
		expect(pool.tabLayoutForWindow(fw.win)?.splits).toBeUndefined();
	});

	it("caches session meta per tab and includes it in TAB_STATUS and GET_TABS", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		pool.acquire("/b", fw.win, "tab-b");
		const [, b] = sidecars;
		fw.sent.length = 0;

		b?.emitSessionInfo({ title: "Fix flaky test", sessionId: "sess-1" });
		// Background session-info pushes a light snapshot and caches for later.
		expect(fw.sentTo(IPC_EVENTS.TAB_STATUS).map(s => s.data)).toEqual([
			{
				kind: "agent",
				tabId: "tab-b",
				cwd: "/b",
				status: "starting",
				placeholder: false,
				sessionPath: null,
				sessionId: "sess-1",
				title: "Fix flaky test",
			},
		]);
		// No full-channel forward from a background tab.
		expect(fw.sentTo(IPC_EVENTS.SESSION_INFO_UPDATE)).toHaveLength(0);
		expect(pool.tabsForWindow(fw.win)[1]).toEqual({
			kind: "agent",
			tabId: "tab-b",
			cwd: "/b",
			status: "starting",
			placeholder: false,
			sessionPath: null,
			sessionId: "sess-1",
			title: "Fix flaky test",
		});

		// Subsequent status pushes keep carrying the cached meta.
		fw.sent.length = 0;
		b?.emitStatus("ready");
		expect(fw.sentTo(IPC_EVENTS.TAB_STATUS).map(s => s.data)).toEqual([
			{
				kind: "agent",
				tabId: "tab-b",
				cwd: "/b",
				status: "ready",
				placeholder: false,
				sessionPath: null,
				sessionId: "sess-1",
				title: "Fix flaky test",
			},
		]);
	});

	it("spawns only the tabs a restored layout shows, then wakes a sleeping tab on demand", () => {
		const sidecars: FakeSidecar[] = [];
		const pool = new SidecarPool(cwd => {
			const sidecar = new FakeSidecar(cwd);
			sidecars.push(sidecar);
			return sidecar as unknown as SidecarLike;
		});
		const fw = fakeWindow(1);
		pool.restoreLayout(fw.win, {
			version: 1,
			activeIndex: 2,
			tabs: [
				{ cwd: "/a", kind: "agent", sessionPath: "/sessions/a.jsonl" },
				{ cwd: "/b", kind: "agent" },
				{ cwd: "/c", kind: "agent" },
			],
		});

		// A sidecar holds ~200 MB of private memory, so a restored background tab
		// is an entry — not a process — until it is rendered.
		expect(sidecars.map(sidecar => sidecar.started)).toEqual([false, false, true]);
		expect(sidecars[0]?.restartArgs).toEqual([]);
		const tabs = pool.tabsForWindow(fw.win);
		expect(tabs.map(tab => tab.status)).toEqual(["asleep", "asleep", "starting"]);

		// Showing it spawns it, resuming the session its layout saved.
		const [sleeping] = tabs;
		fw.sent.length = 0;
		expect(pool.setActiveTab(fw.win, sleeping!.tabId)).toBe(true);
		expect(sidecars[0]?.restartArgs).toEqual([{ cwd: undefined, sessionPath: "/sessions/a.jsonl" }]);
		expect(fw.sentTo(IPC_EVENTS.TAB_STATUS).map(entry => (entry.data as IpcTabStatusPayload).status)).toEqual([
			"starting",
		]);

		// Hiding and re-showing it does not spawn a second process.
		pool.setActiveTab(fw.win, tabs[1]!.tabId);
		pool.setActiveTab(fw.win, sleeping!.tabId);
		expect(sidecars[0]?.restartArgs).toHaveLength(1);
	});

	it("labels a sleeping tab with the title its session last had", () => {
		const pool = new SidecarPool(cwd => new FakeSidecar(cwd) as unknown as SidecarLike);
		const fw = fakeWindow(1);
		pool.restoreLayout(fw.win, {
			version: 1,
			activeIndex: 1,
			tabs: [
				{ cwd: "/a", kind: "agent", sessionPath: "/sessions/a.jsonl", title: "Fix races" },
				{ cwd: "/b", kind: "agent", title: "Audit report" },
			],
		});

		// With the process deferred, the saved title is the only thing the chip
		// can say besides the folder name — so it must survive the round trip.
		expect(pool.tabsForWindow(fw.win).map(tab => tab.title)).toEqual(["Fix races", "Audit report"]);
		expect(pool.tabLayoutForWindow(fw.win)?.tabs[0]).toEqual({
			cwd: "/a",
			kind: "agent",
			sessionPath: "/sessions/a.jsonl",
			title: "Fix races",
		});
	});

	it("restores tab order, sessions, kinds, and the persisted active tab", () => {
		const factoryCalls: Array<{ cwd: string; kind: "agent" | "chat"; fresh: boolean }> = [];
		const sidecars: FakeSidecar[] = [];
		const pool = new SidecarPool((cwd, kind, fresh) => {
			factoryCalls.push({ cwd, kind, fresh });
			const sidecar = new FakeSidecar(cwd);
			sidecars.push(sidecar);
			return sidecar as unknown as SidecarLike;
		});
		const fw = fakeWindow(1);

		const restored = pool.restoreLayout(fw.win, {
			version: 1,
			activeIndex: 1,
			tabs: [
				{ cwd: "/agent", kind: "agent", sessionPath: "/sessions/a.jsonl" },
				{ cwd: "/chat", kind: "chat" },
			],
			split: { axis: "rows", first: { tabId: "0" }, second: { tabId: "1" }, ratio: 0.6 },
		});

		expect(restored).toBe(2);
		expect(factoryCalls).toEqual([
			{ cwd: "/agent", kind: "agent", fresh: false },
			{ cwd: "/chat", kind: "chat", fresh: true },
		]);
		expect(sidecars[0]?.restartArgs).toEqual([{ cwd: undefined, sessionPath: "/sessions/a.jsonl" }]);
		expect(sidecars[1]?.started).toBe(true);
		expect(pool.tabsForWindow(fw.win).map(tab => tab.active ?? false)).toEqual([false, true]);
		const restoredIds = pool.tabsForWindow(fw.win).map(tab => tab.tabId);
		expect(pool.tabsForWindow(fw.win).map(tab => tab.split)).toEqual(
			restoredIds.map(() => ({
				axis: "rows",
				first: { tabId: restoredIds[0] },
				second: { tabId: restoredIds[1] },
				ratio: 0.6,
			})),
		);
		expect(pool.tabLayoutForWindow(fw.win)).toEqual({
			version: 1,
			activeIndex: 1,
			tabs: [
				{ cwd: "/agent", kind: "agent", sessionPath: "/sessions/a.jsonl" },
				{ cwd: "/chat", kind: "chat" },
			],
			split: { axis: "rows", first: { tabId: "0" }, second: { tabId: "1" }, ratio: 0.6 },
		});
	});

	it("publishes durable layout changes after tab, session, cwd, and active mutations", () => {
		const { pool } = fakePool();
		const fw = fakeWindow(1);
		const snapshots: Array<PersistedTabLayout | null> = [];
		pool.onWindowTabsChanged = (_win, layout) => snapshots.push(layout);

		pool.acquire("/a", fw.win, "tab-a", "/sessions/a.jsonl");
		pool.acquire("/b", fw.win, "tab-b", undefined, "chat");
		pool.setActiveTab(fw.win, "tab-b");
		pool.noteSessionFile("tab-b", "/sessions/b.jsonl");
		pool.adoptSessionCwd("tab-b", "/moved");

		expect(snapshots.at(-1)).toEqual({
			version: 1,
			activeIndex: 1,
			tabs: [
				{ cwd: "/a", kind: "agent", sessionPath: "/sessions/a.jsonl" },
				{ cwd: "/moved", kind: "chat", sessionPath: "/sessions/b.jsonl" },
			],
		});

		pool.releaseTab("tab-b");
		expect(snapshots.at(-1)).toEqual({
			version: 1,
			activeIndex: 0,
			tabs: [{ cwd: "/a", kind: "agent", sessionPath: "/sessions/a.jsonl" }],
		});
	});

	it("marks only the untargeted startup tab as disposable and clears it on first run", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		const snapshots: Array<PersistedTabLayout | null> = [];
		pool.onWindowTabsChanged = (_win, layout) => snapshots.push(layout);

		pool.acquire("/neutral", fw.win, "tab-idle", undefined, "chat", undefined, true, true);
		expect(pool.tabsForWindow(fw.win)[0]).toMatchObject({ tabId: "tab-idle", placeholder: true });
		expect(pool.tabLayoutForWindow(fw.win)?.tabs[0]).toMatchObject({ placeholder: true });

		sidecars[0]?.emitAgentEvents(["agent_start"]);

		expect(pool.tabsForWindow(fw.win)[0]).toMatchObject({ tabId: "tab-idle", placeholder: false });
		expect(pool.tabLayoutForWindow(fw.win)?.tabs[0]).not.toHaveProperty("placeholder");
		expect(snapshots.at(-1)?.tabs[0]).not.toHaveProperty("placeholder");
	});

	it("releases a tab: disposed, pool shrinks, active falls back to a sibling", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		pool.acquire("/b", fw.win, "tab-b");
		const [a, b] = sidecars;

		// Closing the ACTIVE tab releases it and activates the remaining one.
		expect(pool.releaseTab("tab-a")).toBe(true);
		expect(a?.disposed).toBe(true);
		expect(pool.size).toBe(1);
		expect(pool.sidecarForWindow(fw.win)).toBe(b);
		expect(pool.activeTabForWindow(fw.win)).toBe("tab-b");
		expect(b?.listenerCount("events")).toBe(2);

		// Unknown tab is a no-op; closing the last tab leaves the window tab-less.
		expect(pool.releaseTab("tab-a")).toBe(false);
		expect(pool.releaseTab("tab-b")).toBe(true);
		expect(b?.disposed).toBe(true);
		expect(pool.size).toBe(0);
		expect(pool.sidecarForWindow(fw.win)).toBeNull();
		expect(pool.activeTabForWindow(fw.win)).toBeNull();
		expect(pool.tabsForWindow(fw.win)).toEqual([]);
	});

	it("has no limit on tabs: an 11th, 12th… tab still acquires, and a restore keeps them all", () => {
		const { pool } = fakePool();
		const fw1 = fakeWindow(1);
		const fw2 = fakeWindow(2);
		for (let index = 0; index < 12; index++) {
			expect(pool.acquire(`/w-${index}`, index % 2 ? fw2.win : fw1.win, `tab-${index}`)).not.toBeNull();
		}
		expect(pool.size).toBe(12);

		const fw3 = fakeWindow(3);
		const tabs = Array.from({ length: 12 }, (_, index) => ({ cwd: `/r-${index}`, kind: "agent" as const }));
		expect(pool.restoreLayout(fw3.win, { version: 1, activeIndex: 11, tabs })).toBe(12);
		expect(pool.tabsForWindow(fw3.win)).toHaveLength(12);
		expect(pool.size).toBe(24);
	});

	it("releases every tab of a closed window", () => {
		const { pool, sidecars } = fakePool();
		const fw1 = fakeWindow(1);
		const fw2 = fakeWindow(2);
		pool.acquire("/a", fw1.win, "tab-a");
		pool.acquire("/b", fw1.win, "tab-b");
		pool.acquire("/c", fw2.win, "tab-c");

		fw1.close();
		expect(sidecars[0]?.disposed).toBe(true);
		expect(sidecars[1]?.disposed).toBe(true);
		expect(sidecars[2]?.disposed).toBe(false);
		expect(pool.size).toBe(1);
		expect(pool.activeTabForWindow(fw2.win)).toBe("tab-c");
		expect(pool.sidecarForWindow(fw2.win)).toBe(sidecars[2]);

		// Late events from the surviving window still forward normally.
		sidecars[2]?.emitStatus("ready");
		expect(fw2.sentTo(IPC_EVENTS.SIDECAR_STATUS)).toHaveLength(1);
	});
});

describe("SidecarPool restartOnNewOmp (omp updated on this computer)", () => {
	const tick = () => new Promise<void>(resolve => setImmediate(resolve));

	function tabs() {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		pool.acquire("/b", fw.win, "tab-b");
		pool.acquire("/c", fw.win, "tab-c", undefined, "agent", undefined, false, false, true);
		pool.acquire("/d", fw.win, "tab-d", undefined, "agent", undefined, false, false, false, undefined, "host-1");
		const [a, b, c, d] = sidecars;
		for (const sidecar of [a, b, d]) sidecar?.emitStatus("ready");
		pool.noteSessionFile("tab-a", "/sessions/a.jsonl");
		pool.noteSessionFile("tab-b", "/sessions/b.jsonl");
		return { pool, a: a!, b: b!, c: c!, d: d! };
	}

	it("restarts idle tabs now on their own session, leaves a never-started tab and a paired host's tab alone, and counts the busy ones", () => {
		const { pool, a, b, c, d } = tabs();
		b.emitAgentEvents(["agent_start"]);
		const before = {
			a: a.restartArgs.length,
			b: b.restartArgs.length,
			c: c.restartArgs.length,
			d: d.restartArgs.length,
		};
		expect(pool.restartOnNewOmp()).toBe(1);
		expect(a.restartArgs.slice(before.a)).toEqual([{ cwd: undefined, sessionPath: "/sessions/a.jsonl" }]);
		expect(b.restartArgs).toHaveLength(before.b);
		expect(c.restartArgs).toHaveLength(before.c);
		expect(d.restartArgs).toHaveLength(before.d);
	});

	it("restarts a busy tab only once its turn ends, one tick after the last events, and then never again", async () => {
		const { pool, b } = tabs();
		b.emitAgentEvents(["agent_start"]);
		const before = b.restartArgs.length;
		pool.restartOnNewOmp();
		await tick();
		expect(b.restartArgs).toHaveLength(before);
		// The turn ends: the restart is not inside the event dispatch (the window's forwarder runs first) but right after.
		b.emitAgentEvents(["agent_end"]);
		expect(b.restartArgs).toHaveLength(before);
		await tick();
		expect(b.restartArgs.slice(before)).toEqual([{ cwd: undefined, sessionPath: "/sessions/b.jsonl" }]);
		// A later turn does not restart it again.
		b.emitAgentEvents(["agent_start"]);
		b.emitAgentEvents(["agent_end"]);
		await tick();
		expect(b.restartArgs).toHaveLength(before + 1);
	});

	it("waits through background work that keeps the session busy after agent_end", async () => {
		const { pool, b } = tabs();
		b.emitAgentEvents(["agent_start"]);
		b.emit("promptResult", { type: "prompt_result", sessionSettled: false });
		pool.restartOnNewOmp();
		const before = b.restartArgs.length;
		b.emitAgentEvents(["agent_end"]);
		await tick();
		expect(b.restartArgs).toHaveLength(before);
		b.emit("sessionSettled", { type: "session_settled" });
		await tick();
		expect(b.restartArgs).toHaveLength(before + 1);
	});

	it("forgets a waiting tab that was closed", async () => {
		const { pool, b } = tabs();
		b.emitAgentEvents(["agent_start"]);
		pool.restartOnNewOmp();
		const before = b.restartArgs.length;
		pool.releaseTab("tab-b");
		b.emitAgentEvents(["agent_end"]);
		await tick();
		expect(b.restartArgs).toHaveLength(before);
	});
});

describe("SidecarPool session ownership (F-OWN)", () => {
	it("routes deletes only to an idle attached tab, renames even mid-run", async () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a", "/sessions/s.jsonl");
		const [sidecar] = sidecars;
		const rename = { type: "set_session_name", name: "Renamed", sessionPath: "/sessions/s.jsonl" } as const;

		// A spawn in flight has nobody to answer yet.
		expect(await pool.commandForSession("/sessions/s.jsonl", rename)).toBeNull();
		sidecar?.emitStatus("ready");

		sidecar?.emitAgentEvents(["agent_start"]);
		expect(await pool.commandForIdleSession("/sessions/s.jsonl", { type: "drop_session" })).toBeNull();
		expect((await pool.commandForSession("/sessions/s.jsonl", rename))?.success).toBe(true);
		expect(sidecar?.rpcCommands).toEqual([rename]);

		sidecar?.emitAgentEvents(["agent_end"]);
		expect(await pool.commandForIdleSession("/sessions/s.jsonl", { type: "drop_session" })).toMatchObject({
			success: true,
		});
		expect(await pool.commandForSession("/sessions/other.jsonl", rename)).toBeNull();
	});

	it("blocks deletes, not renames, while automatic compaction is in flight", async () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a", "/sessions/s.jsonl");
		const [sidecar] = sidecars;
		sidecar?.emitStatus("ready");
		sidecar?.emitAgentEvents(["auto_compaction_start"]);

		expect(pool.tabsForWindow(fw.win)[0]?.compacting).toBe(true);
		expect(await pool.commandForIdleSession("/sessions/s.jsonl", { type: "drop_session" })).toBeNull();
		expect(
			(
				await pool.commandForSession("/sessions/s.jsonl", {
					type: "set_session_name",
					name: "Renamed",
					sessionPath: "/sessions/s.jsonl",
				})
			)?.success,
		).toBe(true);

		sidecar?.emitAgentEvents(["auto_compaction_end"]);
		expect(pool.tabsForWindow(fw.win)[0]?.compacting).toBe(false);
		expect(await pool.commandForIdleSession("/sessions/s.jsonl", { type: "drop_session" })).toMatchObject({
			success: true,
		});
	});

	it("reports a session as live only while some process holds it", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.restoreLayout(fw.win, {
			version: 1,
			activeIndex: 1,
			tabs: [
				{ cwd: "/a", kind: "agent", sessionPath: "/sessions/s.jsonl" },
				{ cwd: "/b", kind: "agent" },
			],
		});
		const owner = pool.sessionOwner("/sessions/s.jsonl");
		if (!owner) throw new Error("expected the restored tab to own the session");
		const sidecar = sidecars[0];

		// Unowned paths are never live, and neither is an asleep owner — ipc.ts
		// deletes or renames those straight on disk instead of asking a
		// drop_session that has nobody to answer, rather than refusing it.
		expect(pool.sessionOwnerIsLive("/sessions/other.jsonl")).toBe(false);
		expect(pool.sessionOwnerIsLive("/sessions/s.jsonl")).toBe(false);

		// Showing the tab spawns it, and a spawn in flight counts as live: it is
		// about to read the file.
		expect(pool.setActiveTab(fw.win, owner.tabId)).toBe(true);
		expect(sidecar?.status).toBe("starting");
		expect(pool.sessionOwnerIsLive("/sessions/s.jsonl")).toBe(true);

		sidecar?.emitStatus("ready");
		expect(pool.sessionOwnerIsLive("/sessions/s.jsonl")).toBe(true);
		sidecar?.emitStatus("restarting");
		expect(pool.sessionOwnerIsLive("/sessions/s.jsonl")).toBe(true);

		// A dead process holds nothing.
		sidecar?.emitStatus("exited");
		expect(pool.sessionOwnerIsLive("/sessions/s.jsonl")).toBe(false);
		sidecar?.emitStatus("error");
		expect(pool.sessionOwnerIsLive("/sessions/s.jsonl")).toBe(false);

		// …but a failed health check reports `error` over a process that still
		// holds the file: a delete must go through it, never straight to disk.
		if (sidecar) sidecar.processAlive = true;
		expect(pool.sessionOwnerIsLive("/sessions/s.jsonl")).toBe(true);
	});

	it("registers the owner at acquire-with-sessionPath and unregisters on release", () => {
		const { pool } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a", "/sessions/s.jsonl");

		// A duplicate attach consults this: SPAWN_TAB maps it to
		// { tabId: null, ownerTabId, ownerWinId } instead of acquiring.
		expect(pool.sessionOwner("/sessions/s.jsonl")).toEqual({ tabId: "tab-a", winId: 1 });
		expect(pool.sessionOwner("/sessions/other.jsonl")).toBeNull();

		expect(pool.releaseTab("tab-a")).toBe(true);
		expect(pool.sessionOwner("/sessions/s.jsonl")).toBeNull();
	});

	it("learns the file from noteSessionFile (get_state / switch_session reports)", () => {
		const { pool } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		expect(pool.sessionOwner("/sessions/s.jsonl")).toBeNull();

		pool.noteSessionFile("tab-a", "/sessions/s.jsonl");
		expect(pool.sessionOwner("/sessions/s.jsonl")).toEqual({ tabId: "tab-a", winId: 1 });
		expect(fw.sentTo(IPC_EVENTS.TAB_STATUS).at(-1)?.data).toMatchObject({
			tabId: "tab-a",
			sessionPath: "/sessions/s.jsonl",
		});

		// A switch moves the entry: the old file is freed, the new one owned.
		pool.noteSessionFile("tab-a", "/sessions/s2.jsonl");
		expect(pool.sessionOwner("/sessions/s.jsonl")).toBeNull();
		expect(pool.sessionOwner("/sessions/s2.jsonl")).toEqual({ tabId: "tab-a", winId: 1 });

		// get_state with sessionFile null (fresh unsaved session) unregisters.
		pool.noteSessionFile("tab-a", null);
		expect(pool.sessionOwner("/sessions/s2.jsonl")).toBeNull();
		expect(fw.sentTo(IPC_EVENTS.TAB_STATUS).at(-1)?.data).toMatchObject({ tabId: "tab-a", sessionPath: null });

		// Unknown tabs are a no-op.
		pool.noteSessionFile("nope", "/sessions/x.jsonl");
		expect(pool.sessionOwner("/sessions/x.jsonl")).toBeNull();
	});

	it("keeps the acquire-time registration through first attach but drops it on a sessionId change", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a", "/sessions/s.jsonl");
		const [a] = sidecars;

		// First attach: the resumed session reports its id — registration kept
		// (this is what lets a background --session tab stay guarded).
		a?.emitSessionInfo({ sessionId: "sess-1", title: "Resumed" });
		expect(pool.sessionOwner("/sessions/s.jsonl")).toEqual({ tabId: "tab-a", winId: 1 });

		// Title-only updates don't touch ownership either.
		a?.emitSessionInfo({ title: "Renamed" });
		expect(pool.sessionOwner("/sessions/s.jsonl")).not.toBeNull();

		// The session under the tab changed (crash-restart into a fresh
		// session, an unobserved switch): the cached file mapping is stale.
		a?.emitSessionInfo({ sessionId: "sess-2" });
		expect(pool.sessionOwner("/sessions/s.jsonl")).toBeNull();
		// …and the renderer's hydrate re-registers the file now attached.
		pool.noteSessionFile("tab-a", "/sessions/s.jsonl");
		expect(pool.sessionOwner("/sessions/s.jsonl")).toEqual({ tabId: "tab-a", winId: 1 });
	});

	it("only the current owner clears a mapping", () => {
		const { pool } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a", "/sessions/s.jsonl");
		pool.acquire("/b", fw.win, "tab-b");

		// Last writer wins if two tabs ever report the same file…
		pool.noteSessionFile("tab-b", "/sessions/s.jsonl");
		expect(pool.sessionOwner("/sessions/s.jsonl")).toEqual({ tabId: "tab-b", winId: 1 });

		// …so releasing the FORMER owner must not drop the new registration.
		expect(pool.releaseTab("tab-a")).toBe(true);
		expect(pool.sessionOwner("/sessions/s.jsonl")).toEqual({ tabId: "tab-b", winId: 1 });
	});

	it("foreignSessionOwner blocks only foreign attaches", () => {
		const { pool } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a", "/sessions/s.jsonl");
		pool.acquire("/b", fw.win, "tab-b");

		// A different tab's switch_session is blocked — with the owner info the
		// refusal carries for routing.
		expect(pool.foreignSessionOwner("tab-b", "/sessions/s.jsonl")).toEqual({ tabId: "tab-a", winId: 1 });
		// The owner itself re-attaches freely (switch_session onto its own file).
		expect(pool.foreignSessionOwner("tab-a", "/sessions/s.jsonl")).toBeNull();
		// Unowned files are free (first attach).
		expect(pool.foreignSessionOwner("tab-b", "/sessions/other.jsonl")).toBeNull();
		// An untracked issuer is blocked by any owner — the safe direction.
		expect(pool.foreignSessionOwner(null, "/sessions/s.jsonl")).toEqual({ tabId: "tab-a", winId: 1 });
		// Re-attach after release: the mapping is gone, the path is free.
		expect(pool.releaseTab("tab-a")).toBe(true);
		expect(pool.foreignSessionOwner("tab-b", "/sessions/s.jsonl")).toBeNull();
	});

	it("unregisters owners when a window closes", () => {
		const { pool } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a", "/sessions/s.jsonl");
		expect(pool.sessionOwner("/sessions/s.jsonl")).not.toBeNull();
		fw.close();
		expect(pool.sessionOwner("/sessions/s.jsonl")).toBeNull();
	});

	it("keys ownership by device + path: the same path on a paired host is another file", async () => {
		const factoryCalls: Array<{ cwd: string; device: string | undefined; tabId: string }> = [];
		const sidecars: FakeSidecar[] = [];
		const pool = new SidecarPool((cwd, _kind, _fresh, device, tabId) => {
			factoryCalls.push({ cwd, device, tabId });
			const sidecar = new FakeSidecar(cwd);
			sidecars.push(sidecar);
			return sidecar as unknown as SidecarLike;
		});
		const fw = fakeWindow(1);
		const path = "/Users/me/.omp/agent/sessions/p/s.jsonl";
		pool.acquire("/a", fw.win, "tab-local", path);
		pool.acquire("/b", fw.win, "tab-remote", path, "agent", undefined, false, false, false, undefined, "host-b");

		// The host's cwd is passed through untouched (it canonicalizes), with the tab id as rtab.
		expect(factoryCalls[1]).toEqual({ cwd: "/b", device: "host-b", tabId: "tab-remote" });
		expect(pool.sessionOwner(path)).toEqual({ tabId: "tab-local", winId: 1 });
		expect(pool.sessionOwner(path, "host-b")).toEqual({ tabId: "tab-remote", winId: 1 });
		expect(pool.sessionOwner(path, "host-c")).toBeNull();
		// Each tab re-attaches its own file freely; neither blocks the other.
		expect(pool.foreignSessionOwner("tab-local", path)).toBeNull();
		expect(pool.foreignSessionOwner("tab-remote", path)).toBeNull();

		// Commands for a device's session go to that device's tab only.
		sidecars[1]?.emitStatus("ready");
		await pool.commandForSession(path, { type: "set_session_name", name: "x", sessionPath: path }, "host-b");
		expect(sidecars[1]?.rpcCommands.map(command => command.type)).toEqual(["set_session_name"]);
		expect(sidecars[0]?.rpcCommands).toEqual([]);

		// A session report on the remote tab registers under its device.
		sidecars[1]?.emitSessionIdentity({ sessionId: "r2", sessionFile: "/Users/me/.omp/agent/sessions/p/t.jsonl" });
		expect(pool.sessionOwner("/Users/me/.omp/agent/sessions/p/t.jsonl")).toBeNull();
		expect(pool.sessionOwner("/Users/me/.omp/agent/sessions/p/t.jsonl", "host-b")).toEqual({
			tabId: "tab-remote",
			winId: 1,
		});

		expect(pool.releaseTab("tab-remote")).toBe(true);
		expect(pool.sessionOwner("/Users/me/.omp/agent/sessions/p/t.jsonl", "host-b")).toBeNull();
		expect(pool.sessionOwner(path)).toEqual({ tabId: "tab-local", winId: 1 });
	});

	it("reports and persists a remote tab's device, and restores it onto that device", () => {
		const devices: Array<string | undefined> = [];
		const pool = new SidecarPool((cwd, _kind, _fresh, device) => {
			devices.push(device);
			return new FakeSidecar(cwd) as unknown as SidecarLike;
		});
		const fw = fakeWindow(1);
		pool.acquire(
			"/host/p",
			fw.win,
			"tab-r",
			"/host/s.jsonl",
			"agent",
			undefined,
			false,
			false,
			false,
			undefined,
			"host-b",
		);
		expect(pool.tabsForWindow(fw.win)[0]).toMatchObject({ tabId: "tab-r", device: "host-b" });
		expect(pool.tabTarget(fw.win, "tab-r")?.device).toBe("host-b");
		const layout = pool.tabLayoutForWindow(fw.win);
		expect(layout?.tabs[0]).toMatchObject({ cwd: "/host/p", sessionPath: "/host/s.jsonl", device: "host-b" });

		const restoredWindow = fakeWindow(2);
		if (!layout) throw new Error("expected a layout");
		pool.restoreLayout(restoredWindow.win, layout);
		expect(devices).toEqual(["host-b", "host-b"]);
		expect(pool.sessionOwner("/host/s.jsonl", "host-b")).not.toBeNull();
	});
});

describe("SidecarPool session cwd tracking", () => {
	it("adoptSessionCwd re-roots the tab and pushes the live cwd over TAB_STATUS", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/spawn-a", fw.win, "tab-a");
		fw.sent.length = 0;

		// switch_session re-roots the agent silently; the get_state report moves
		// the tab off its spawn cwd…
		expect(pool.adoptSessionCwd("tab-a", "/live-b")).toBe(true);
		expect(sidecars[0]?.cwd).toBe("/live-b");

		// …and the pushed TAB_STATUS carries the NEW cwd so the renderer's chip
		// stops showing the spawn workspace.
		const pushes = fw.sentTo(IPC_EVENTS.TAB_STATUS);
		expect(pushes).toHaveLength(1);
		expect((pushes[0]!.data as IpcTabStatusPayload).cwd).toBe("/live-b");

		// Same cwd / unknown tab / empty cwd are no-ops (no push, no mutation).
		expect(pool.adoptSessionCwd("tab-a", "/live-b")).toBe(false);
		expect(pool.adoptSessionCwd("nope", "/elsewhere")).toBe(false);
		expect(pool.adoptSessionCwd("tab-a", "")).toBe(false);
		expect(sidecars[0]?.cwd).toBe("/live-b");
		expect(fw.sentTo(IPC_EVENTS.TAB_STATUS)).toHaveLength(1);
	});
});

describe("SidecarPool request-origin routing (F-UI-ORIGIN)", () => {
	it("does not retain fire-and-forget extension UI updates", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");

		sidecars[0]?.emitEditorText("update-1");
		expect(fw.sentTo(IPC_EVENTS.EXTENSION_UI)).toHaveLength(1);
		expect(pool.routeSideChannel("update-1", { type: "extension_ui_response", id: "update-1" })).toBe(false);
	});

	it("routes an extension-ui response to the raising sidecar even after a tab switch", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		pool.acquire("/b", fw.win, "tab-b");
		const [a, b] = sidecars;

		// Tab A raises the request while active; the dialog is forwarded…
		a?.emitExtensionUi("req-1");
		expect(fw.sentTo(IPC_EVENTS.EXTENSION_UI).map(item => item.data)).toEqual([
			{
				tabId: "tab-a",
				request: {
					type: "extension_ui_request",
					id: "req-1",
					method: "confirm",
					title: "Proceed?",
					message: "ok?",
				},
			},
		]);

		// …the user switches to tab B, THEN the response arrives. It must go to
		// A's sidecar — B never saw the request and would drop/misroute it.
		expect(pool.setActiveTab(fw.win, "tab-b")).toBe(true);
		const response = { type: "extension_ui_response", id: "req-1", confirmed: true };
		expect(pool.routeSideChannel("req-1", response)).toBe(true);
		expect(a?.sentFrames).toEqual([response]);
		expect(b?.sentFrames).toEqual([]);

		// Final responses consume the route — a repeat id falls back to the caller.
		expect(pool.routeSideChannel("req-1", response)).toBe(false);
	});

	it("routes identical request ids independently when panes provide their tab owner", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		pool.acquire("/b", fw.win, "tab-b");
		const [a, b] = sidecars;
		a?.emitExtensionUi("same-id");
		b?.emitExtensionUi("same-id");
		const yes = { type: "extension_ui_response", id: "same-id", confirmed: true };
		const no = { type: "extension_ui_response", id: "same-id", confirmed: false };
		expect(pool.routeSideChannel("same-id", yes, "tab-a")).toBe(true);
		expect(pool.routeSideChannel("same-id", no, "tab-b")).toBe(true);
		expect(a?.sentFrames).toEqual([yes]);
		expect(b?.sentFrames).toEqual([no]);
	});

	it("fails host-uri requests on the raising sidecar instead of forwarding them", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		pool.acquire("/b", fw.win, "tab-b");
		const [a, b] = sidecars;

		a?.emitHostUriRequest("uri-1");
		expect(a?.sentFrames).toEqual([
			{
				type: "host_uri_result",
				id: "uri-1",
				isError: true,
				error: "OMPdesk serves no host URI for https://example.com",
			},
		]);
		expect(b?.sentFrames).toEqual([]);
		expect(pool.routeSideChannel("uri-1", { type: "host_uri_result", id: "uri-1" })).toBe(false);
	});

	it("answers host tools through the executor without tracking a route", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		const [a] = sidecars;
		pool.hostToolExecutor = (sidecar, request) => {
			sidecar.sendSideChannel({ type: "host_tool_result", id: request.id, result: "inline" });
		};

		a?.emitHostToolCall("tool-inline");
		expect(a?.sentFrames).toEqual([{ type: "host_tool_result", id: "tool-inline", result: "inline" }]);
		expect(pool.routeSideChannel("tool-inline", { type: "host_tool_result", id: "tool-inline" })).toBe(false);
	});

	it("answers every tab's host tools, shown or hidden, naming the calling tab", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		pool.acquire("/b", fw.win, "tab-b");
		const [a, b] = sidecars;
		const calls: string[] = [];
		pool.hostToolExecutor = (_sidecar, request, tab) => calls.push(`${tab.tabId}:${request.id}`);
		a?.emitHostToolCall("one");
		b?.emitHostToolCall("two");
		expect(calls).toEqual(["tab-a:one", "tab-b:two"]);
	});

	it("drops pending routes when the owning tab is released", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		pool.acquire("/b", fw.win, "tab-b");
		const [a, b] = sidecars;

		a?.emitExtensionUi("req-doomed");
		expect(pool.releaseTab("tab-a")).toBe(true);
		// A late response falls back instead of writing to a disposed sidecar.
		expect(pool.routeSideChannel("req-doomed", { type: "extension_ui_response", id: "req-doomed" })).toBe(false);
		expect(a?.sentFrames).toEqual([]);
		expect(b?.sentFrames).toEqual([]);
	});
});

describe("SidecarPool quit inventory", () => {
	it("reports every live tab's in-flight run across windows and drops released tabs", () => {
		const { pool, sidecars } = fakePool();
		const first = fakeWindow(1);
		const second = fakeWindow(2);
		pool.acquire("/a", first.win, "tab-a");
		pool.acquire("/b", second.win, "tab-b");
		pool.acquire("/c", second.win, "tab-c");
		const [a, b, c] = sidecars;

		// Nothing running yet: ⌘Q must not ask.
		expect(pool.tabInventory()).toEqual([
			{ windowId: 1, tabId: "tab-a", inFlight: false },
			{ windowId: 2, tabId: "tab-b", inFlight: false },
			{ windowId: 2, tabId: "tab-c", inFlight: false },
		]);

		// A background window's run counts the same as the active one's, and an
		// automatic compaction is work too.
		a?.emitAgentEvents(["agent_start"]);
		c?.emitAgentEvents(["auto_compaction_start"]);
		expect(pool.tabInventory().filter(entry => entry.inFlight)).toEqual([
			{ windowId: 1, tabId: "tab-a", inFlight: true },
			{ windowId: 2, tabId: "tab-c", inFlight: true },
		]);

		// A closed tab leaves the inventory; the guard must not ask about work
		// that no longer exists.
		b?.emitAgentEvents(["agent_end"]);
		expect(pool.releaseTab("tab-b")).toBe(true);
		expect(pool.tabInventory().map(entry => entry.tabId)).toEqual(["tab-a", "tab-c"]);
	});
});

describe("SidecarPool background tabs", () => {
	it("forwards a background tab's extension UI to its tab and routes the answer back", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		pool.acquire("/b", fw.win, "tab-b");
		const [a, b] = sidecars;

		// tab-b was never shown, yet its agent blocks on an ask and publishes a widget.
		b?.emitUiRequest({ id: "ask-b", method: "ask", title: "Which one?", questions: [] });
		b?.emitUiRequest({ id: "widget-b", method: "setWidget", widgetKey: "next-prompt", widgetLines: ["hi"] });
		expect(fw.sentTo(IPC_EVENTS.EXTENSION_UI).map(item => item.data)).toMatchObject([
			{ tabId: "tab-b", request: { id: "ask-b", method: "ask" } },
			{ tabId: "tab-b", request: { id: "widget-b", method: "setWidget" } },
		]);

		const response = { type: "extension_ui_response", id: "ask-b", cancelled: true };
		expect(pool.routeSideChannel("ask-b", response)).toBe(true);
		expect(b?.sentFrames).toEqual([response]);
		expect(a?.sentFrames).toEqual([]);
	});

	it("forgets a request omp cancelled and forwards the cancel to the tab", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		pool.acquire("/b", fw.win, "tab-b");
		const b = sidecars[1];

		b?.emitUiRequest({ id: "confirm-b", method: "confirm", title: "Go?", message: "?" });
		b?.emitUiRequest({ id: "cancel-1", method: "cancel", targetId: "confirm-b" });
		expect(fw.sentTo(IPC_EVENTS.EXTENSION_UI).at(-1)?.data).toMatchObject({
			tabId: "tab-b",
			request: { method: "cancel", targetId: "confirm-b" },
		});
		// A late answer no longer has a live request to reach.
		expect(pool.routeSideChannel("confirm-b", { type: "extension_ui_response", id: "confirm-b" })).toBe(false);
		expect(b?.sentFrames).toEqual([]);
	});

	it("reports how a background run ended so the renderer can tell failure from success", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		pool.acquire("/b", fw.win, "tab-b");
		const b = sidecars[1];
		b?.emitStatus("ready");
		const lastFor = () => fw.sentTo(IPC_EVENTS.TAB_STATUS).at(-1)?.data as IpcTabStatusPayload;

		b?.emitEvents([{ type: "agent_start" }]);
		expect(lastFor()).toMatchObject({ tabId: "tab-b", status: "running" });
		expect(lastFor().lastRun).toBeUndefined();
		b?.emitEvents([
			{
				type: "agent_end",
				messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "rate limited" }],
			},
		]);
		expect(lastFor()).toMatchObject({
			tabId: "tab-b",
			status: "ready",
			lastRun: { stopReason: "error", errorMessage: "rate limited" },
		});

		// A new run clears the previous outcome; a clean finish reports "stop".
		b?.emitEvents([{ type: "agent_start" }]);
		expect(lastFor().lastRun).toBeUndefined();
		b?.emitEvents([{ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "stop" }] }]);
		expect(lastFor()).toMatchObject({ status: "ready", lastRun: { stopReason: "stop" } });

		// A reply's text rides along for the completion banner, capped.
		b?.emitEvents([{ type: "agent_start" }]);
		b?.emitEvents([
			{
				type: "agent_end",
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "plan" },
							{ type: "text", text: "## Done\n\nFixed the parser." },
							{ type: "text", text: "x".repeat(5000) },
						],
						stopReason: "stop",
					},
				],
			},
		]);
		const reply = lastFor().lastRun?.reply ?? "";
		expect(reply.startsWith("## Done\n\nFixed the parser.\nxxx")).toBe(true);
		expect(reply).toHaveLength(4000);
	});

	it("keeps a retry saga running until its auto_retry_end decides the outcome", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		const a = sidecars[0];
		a?.emitStatus("ready");
		const lastFor = () => fw.sentTo(IPC_EVENTS.TAB_STATUS).at(-1)?.data as IpcTabStatusPayload;

		a?.emitEvents([{ type: "agent_start" }]);
		a?.emitEvents([{ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "529" }]);
		// The saga's coalesced agent_end is not the end of the run yet.
		a?.emitEvents([{ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "error" }] }]);
		expect(lastFor().status).toBe("running");

		a?.emitEvents([{ type: "auto_retry_end", success: false, attempt: 3, finalError: "overloaded" }]);
		expect(lastFor()).toMatchObject({
			status: "ready",
			lastRun: { stopReason: "error", errorMessage: "overloaded" },
		});
	});

	it("tracks the session a get_state reports in one push, so a later session_info_update is no change", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a", "/sessions/one.jsonl");
		const a = sidecars[0];
		a?.emitSessionInfo({ sessionId: "one" });
		const pushes = fw.sentTo(IPC_EVENTS.TAB_STATUS).length;

		// An in-tab switch_session: the hydrate's get_state reports the new session.
		a?.emitSessionIdentity({ sessionId: "two", sessionFile: "/sessions/two.jsonl" });
		expect(fw.sentTo(IPC_EVENTS.TAB_STATUS)).toHaveLength(pushes + 1);
		expect(fw.sentTo(IPC_EVENTS.TAB_STATUS).at(-1)?.data).toMatchObject({
			tabId: "tab-a",
			sessionId: "two",
			sessionPath: "/sessions/two.jsonl",
		});
		expect(pool.sessionOwner("/sessions/one.jsonl")).toBeNull();

		// omp's own session_info_update for that session arrives much later: the
		// file stays owned, and the id it carries is the one already reported.
		a?.emitSessionInfo({ sessionId: "two", title: "Second" });
		expect(pool.sessionOwner("/sessions/two.jsonl")).toEqual({ tabId: "tab-a", winId: 1 });
		expect(fw.sentTo(IPC_EVENTS.TAB_STATUS).at(-1)?.data).toMatchObject({ sessionId: "two", title: "Second" });
	});

	it("drops the old session's title when another session takes the tab, and keeps a same-session one", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a", "/sessions/one.jsonl");
		const a = sidecars[0];
		a?.emitSessionInfo({ sessionId: "one", title: "Refactor auth flow" });
		// The same session re-reported (heartbeat get_state) keeps its title.
		a?.emitSessionIdentity({ sessionId: "one", sessionFile: "/sessions/one.jsonl" });
		expect(fw.sentTo(IPC_EVENTS.TAB_STATUS).at(-1)?.data).toMatchObject({ title: "Refactor auth flow" });

		// A new session (or a project switch) is unnamed: stock sends no
		// session_info_update for it, so the old name must not stick to the tab.
		a?.emitSessionIdentity({ sessionId: "two" });
		expect(fw.sentTo(IPC_EVENTS.TAB_STATUS).at(-1)?.data).not.toHaveProperty("title");
		// A switch to a named session shows that name at once.
		a?.emitSessionIdentity({ sessionId: "three", sessionFile: "/sessions/three.jsonl", sessionName: "Docs search" });
		expect(fw.sentTo(IPC_EVENTS.TAB_STATUS).at(-1)?.data).toMatchObject({ sessionId: "three", title: "Docs search" });
	});

	it("removes the window-closed listener when a tab is released", () => {
		const { pool } = fakePool();
		const fw = fakeWindow(1);
		const before = fw.win.listenerCount("closed");
		pool.acquire("/a", fw.win, "tab-a");
		pool.acquire("/b", fw.win, "tab-b");
		expect(fw.win.listenerCount("closed")).toBe(before + 2);

		expect(pool.releaseTab("tab-b")).toBe(true);
		expect(fw.win.listenerCount("closed")).toBe(before + 1);
	});
});

describe("SidecarPool worktree.onStart hooks", () => {
	it("hands a new tab's facts to the start-gate hook and installs the gate before the sidecar starts", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(7);
		const seen: Array<{ tabId: string; winId: number; facts: unknown }> = [];
		const gate: SidecarStartGate = async () => null;
		pool.worktreeStartGate = (tabId, winId, facts) => {
			seen.push({ tabId, winId, facts });
			return facts.fresh ? gate : null;
		};

		pool.acquire("/repo", fw.win, "tab-new", undefined, "agent", undefined, true);
		pool.acquire("/repo", fw.win, "tab-resume", "/s/one.jsonl", "agent", undefined, false);

		expect(seen).toEqual([
			{
				tabId: "tab-new",
				winId: 7,
				facts: {
					kind: "agent",
					sessionPath: undefined,
					device: undefined,
					worktree: undefined,
					fresh: true,
					placeholder: false,
					deferStart: false,
				},
			},
			expect.objectContaining({
				tabId: "tab-resume",
				facts: expect.objectContaining({ sessionPath: "/s/one.jsonl" }),
			}),
		]);
		expect(sidecars[0]?.gates).toEqual([{ gate, afterStart: false }]);
		expect(sidecars[0]?.started).toBe(true);
		expect(sidecars[1]?.gates).toEqual([]);
	});

	it("binds a lifecycle worktree, shows it on TAB_STATUS, and never persists the ownership", () => {
		const { pool } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/repo", fw.win, "tab-a", undefined, "agent", undefined, true);
		const binding = {
			name: "wt/20261009-120000",
			branch: "wt/20261009-120000",
			baseCwd: "/repo",
			path: "/wt/wt-20261009-120000-1234567",
			lifecycle: true as const,
		};
		fw.sent.length = 0;

		expect(pool.bindWorktree("tab-a", binding)).toBe(true);
		expect(pool.bindWorktree("gone", binding)).toBe(false);
		const pushed = fw.sentTo(IPC_EVENTS.TAB_STATUS).map(entry => entry.data as IpcTabStatusPayload);
		expect(pushed.at(-1)?.worktree).toEqual(binding);
		expect(pool.tabLayoutForWindow(fw.win)?.tabs[0]?.worktree).toEqual({
			name: binding.name,
			branch: binding.branch,
			baseCwd: binding.baseCwd,
			path: binding.path,
		});
	});

	it("reports every release with the tab's process exit, closed tab or closed window alike", async () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		const released: string[] = [];
		pool.onTabReleased = (tabId, exited) => {
			released.push(tabId);
			void exited.then(() => released.push(`${tabId}:exited`));
		};
		pool.acquire("/a", fw.win, "tab-a");
		pool.acquire("/b", fw.win, "tab-b");
		pool.acquire("/c", fw.win, "tab-c");

		expect(pool.releaseTab("tab-a")).toBe(true);
		const waited = pool.releaseTabWhenExited("tab-b");
		expect(released).toEqual(["tab-a", "tab-b"]);
		sidecars[1]?.exited.resolve();
		await waited;
		fw.close();
		expect(released).toContain("tab-c");
		expect(released).toContain("tab-b:exited");
	});
});
