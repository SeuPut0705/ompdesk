import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { codedError } from "../shared/ipc-error-codes";
import { IPC_EVENTS, type IpcExtensionUiPayload, type IpcTabStatusPayload } from "../shared/ipc-types";
import type { RpcCommand, RpcResponse, SessionInfoUpdateFrame, SidecarStatus } from "../shared/rpc-types";
import { deletedSessions, initDeletedSessions } from "./deleted-sessions";
import type { SidecarSessionIdentity, SidecarStartGate } from "./sidecar";
import { SidecarPool, type TabActivity } from "./sidecar-pool";
import { type SidecarLike, VIEW_ENDED_EVENT } from "./sidecar-types";
import type { PersistedTabLayout } from "./tab-layout";
import type { ClientWindow } from "./web/client-window";

/** Minimal SidecarManager stand-in: an EventEmitter with lifecycle recording. */
class FakeSidecar extends EventEmitter {
	started = false;
	disposed = false;
	restartArgs: Array<{ cwd: string | undefined; sessionPath: string | undefined }> = [];
	reloads: Array<{ reload: boolean; reconnect: string[] }> = [];
	/** Side-channel frames written via sendSideChannel (F-UI-ORIGIN assertions). */
	sentFrames: object[] = [];
	/** What the next sendSideChannel throws (a paired host's tab with its link down). */
	sideChannelError: Error | undefined;
	/** What the next sendSideChannel's promise rejects with (the link dropped while the answer was on its way). */
	sideChannelRejection: Error | undefined;
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
	async reloadExtensions(plan: { reload: boolean; reconnect: string[] }): Promise<void> {
		this.reloads.push(plan);
	}
	kill(): void {}
	dispose(): void {
		this.disposed = true;
		this.removeAllListeners();
	}
	sendSideChannel(frame: object): Promise<void> | undefined {
		if (this.sideChannelError) throw this.sideChannelError;
		if (this.sideChannelRejection) return Promise.reject(this.sideChannelRejection);
		this.sentFrames.push(frame);
	}
	emitStatus(status: SidecarStatus): void {
		this.currentStatus = status;
		this.emit("status", { status, cwd: this.cwd });
	}
	/** True while a paired host's tab reports its link (see RemoteSidecar), not its omp. */
	statusFromLink = false;
	emitLinkStatus(status: SidecarStatus): void {
		this.statusFromLink = true;
		this.emitStatus(status);
		this.statusFromLink = false;
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
	win: ClientWindow & { listenerCount(event: "closed"): number };
	sent: Array<{ channel: string; data: unknown }>;
	close(): void;
	sentTo(channel: string): Array<{ channel: string; data: unknown }>;
}

/** Minimal window: captured sends + a triggerable "closed". Like Electron's, a destroyed one's webContents throws. */
function fakeWindow(id: number): FakeWindow {
	const emitter = new EventEmitter();
	const sent: Array<{ channel: string; data: unknown }> = [];
	let destroyed = false;
	const contents = {
		id,
		send: (channel: string, data: unknown) => {
			sent.push({ channel, data });
		},
	};
	const win = {
		get webContents() {
			if (destroyed) throw new TypeError("Object has been destroyed");
			return contents;
		},
		isDestroyed: () => destroyed,
		once: (event: "closed", listener: () => void) => emitter.once(event, listener),
		removeListener: (event: "closed", listener: () => void) => emitter.removeListener(event, listener),
		listenerCount: (event: "closed") => emitter.listenerCount(event),
	};
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

	it("releases a closed window's tabs when a background tab goes first, never reading the destroyed window", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		pool.acquire("/b", fw.win, "tab-b");
		expect(pool.setActiveTab(fw.win, "tab-b")).toBe(true);
		// tab-a (registered first) is released first, while tab-b is still the window's active tab.
		fw.close();
		expect(sidecars.map(sidecar => sidecar.disposed)).toEqual([true, true]);
		expect(pool.size).toBe(0);
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

describe("SidecarPool applyExtensionUpdate (extensions updated on this computer)", () => {
	const tick = () => new Promise<void>(resolve => setImmediate(resolve));
	const reloadPlan = { reload: true, restart: false, reconnect: [] as string[] };

	function tabs() {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		pool.acquire("/b", fw.win, "tab-b");
		pool.acquire("/a", fw.win, "tab-c", undefined, "agent", undefined, false, false, true);
		pool.acquire("/d", fw.win, "tab-d", undefined, "agent", undefined, false, false, false, undefined, "host-1");
		const [a, b, c, d] = sidecars;
		for (const sidecar of [a, b, d]) sidecar?.emitStatus("ready");
		pool.noteSessionFile("tab-a", "/sessions/a.jsonl");
		pool.noteSessionFile("tab-b", "/sessions/b.jsonl");
		return { pool, a: a!, b: b!, c: c!, d: d! };
	}

	it("reloads idle ready tabs now; skips asleep tabs and a paired host's tab; counts busy ones", () => {
		const { pool, a, b, c, d } = tabs();
		b.emitAgentEvents(["agent_start"]);
		expect(pool.applyExtensionUpdate(reloadPlan)).toBe(1);
		expect(a.reloads).toEqual([reloadPlan]);
		expect(b.reloads).toEqual([]);
		expect(c.reloads).toEqual([]);
		expect(d.reloads).toEqual([]);
		expect(a.restartArgs).toEqual([]);
	});

	it("skips a starting tab", () => {
		const { pool, c } = tabs();
		c.emitStatus("starting");
		expect(pool.applyExtensionUpdate(reloadPlan)).toBe(0);
		expect(c.reloads).toEqual([]);
	});

	it("restarts an idle tab on its session file for a restart plan", () => {
		const { pool, a } = tabs();
		pool.applyExtensionUpdate({ reload: false, restart: true, reconnect: [] });
		expect(a.restartArgs).toEqual([{ cwd: undefined, sessionPath: "/sessions/a.jsonl" }]);
		expect(a.reloads).toEqual([]);
	});

	it("applies to a busy tab one tick after its turn ends, merged, restart winning over reload, and only once", async () => {
		const { pool, b } = tabs();
		b.emitAgentEvents(["agent_start"]);
		pool.applyExtensionUpdate({ reload: true, restart: false, reconnect: ["x"] });
		pool.applyExtensionUpdate({ reload: false, restart: true, reconnect: ["y"] });
		await tick();
		expect(b.restartArgs).toEqual([]);
		b.emitAgentEvents(["agent_end"]);
		expect(b.restartArgs).toEqual([]);
		await tick();
		expect(b.restartArgs).toEqual([{ cwd: undefined, sessionPath: "/sessions/b.jsonl" }]);
		expect(b.reloads).toEqual([]);
		b.emitAgentEvents(["agent_start"]);
		b.emitAgentEvents(["agent_end"]);
		await tick();
		expect(b.restartArgs).toHaveLength(1);
	});

	it("merges reload and reconnect names of a busy tab into one reload after the turn", async () => {
		const { pool, b } = tabs();
		b.emitAgentEvents(["agent_start"]);
		pool.applyExtensionUpdate({ reload: false, restart: false, reconnect: ["x"] });
		pool.applyExtensionUpdate({ reload: true, restart: false, reconnect: ["x", "y"] });
		b.emitAgentEvents(["agent_end"]);
		await tick();
		expect(b.reloads).toEqual([{ reload: true, restart: false, reconnect: ["x", "y"] }]);
	});

	it("forgets a waiting tab that was closed", async () => {
		const { pool, b } = tabs();
		b.emitAgentEvents(["agent_start"]);
		pool.applyExtensionUpdate(reloadPlan);
		pool.releaseTab("tab-b");
		b.emitAgentEvents(["agent_end"]);
		await tick();
		expect(b.reloads).toEqual([]);
	});

	it("lists the distinct working directories of local tabs, asleep ones included, not a paired host's", () => {
		const { pool } = tabs();
		expect(pool.workspaceDirs()).toEqual(["/a", "/b"]);
	});
});

describe("SidecarPool session ownership (F-OWN)", () => {
	const tick = () => new Promise<void>(resolve => setImmediate(resolve));

	it("renames reach the attached tab even mid-run; a delete closes it only while idle", async () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a", "/sessions/s.jsonl");
		const [sidecar] = sidecars;
		const rename = { type: "set_session_name", name: "Renamed", sessionPath: "/sessions/s.jsonl" } as const;

		// A spawn in flight has nobody to answer yet.
		expect(await pool.commandForSession("/sessions/s.jsonl", rename)).toBeNull();
		sidecar?.emitStatus("ready");

		sidecar?.emitAgentEvents(["agent_start"]);
		expect(await pool.closeSessionTab("/sessions/s.jsonl")).toBe(false);
		expect(sidecar?.disposed).toBe(false);
		expect((await pool.commandForSession("/sessions/s.jsonl", rename))?.success).toBe(true);
		expect(sidecar?.rpcCommands).toEqual([rename]);
		expect(await pool.commandForSession("/sessions/other.jsonl", rename)).toBeNull();

		sidecar?.emitAgentEvents(["agent_end"]);
		const closing = pool.closeSessionTab("/sessions/s.jsonl");
		expect(sidecar?.disposed).toBe(true);
		sidecar?.exited.resolve();
		expect(await closing).toBe(true);
	});

	it("blocks deletes, not renames, while automatic compaction is in flight", async () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a", "/sessions/s.jsonl");
		const [sidecar] = sidecars;
		sidecar?.emitStatus("ready");
		sidecar?.emitAgentEvents(["auto_compaction_start"]);

		expect(pool.tabsForWindow(fw.win)[0]?.compacting).toBe(true);
		expect(await pool.closeSessionTab("/sessions/s.jsonl")).toBe(false);
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
		const closing = pool.closeSessionTab("/sessions/s.jsonl");
		sidecar?.exited.resolve();
		expect(await closing).toBe(true);
	});

	it("closeSessionTab closes the owner like a tab close, tells its window and waits for its omp to exit", async () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a", "/sessions/a.jsonl");
		pool.acquire("/b", fw.win, "tab-b", "/sessions/b.jsonl");
		let settled = false;
		const closing = pool.closeSessionTab("/sessions/a.jsonl").then(closed => {
			settled = true;
			return closed;
		});
		expect(sidecars[0]?.disposed).toBe(true);
		expect(pool.sessionOwner("/sessions/a.jsonl")).toBeNull();
		// The window drops the tab main closed; the saved layout no longer names the session.
		expect(fw.sentTo(IPC_EVENTS.TAB_LIST_CHANGED).at(-1)?.data).toEqual({
			tabs: pool.tabsForWindow(fw.win),
			closed: ["tab-a"],
		});
		expect(pool.tabsForWindow(fw.win).map(tab => tab.tabId)).toEqual(["tab-b"]);
		expect(pool.tabLayoutForWindow(fw.win)?.tabs.map(tab => tab.sessionPath)).toEqual(["/sessions/b.jsonl"]);
		// The file is deleted only once the omp that had it open is gone.
		await tick();
		expect(settled).toBe(false);
		sidecars[0]?.exited.resolve();
		expect(await closing).toBe(true);

		// The window closed the tab itself (CLOSE_TAB) just before the delete: its omp is waited for too.
		pool.releaseTab("tab-b");
		let waited = false;
		const after = pool.closeSessionTab("/sessions/b.jsonl").then(() => {
			waited = true;
		});
		await tick();
		expect(waited).toBe(false);
		sidecars[1]?.exited.resolve();
		await after;
		// A stored session nothing holds has nothing to wait for.
		expect(await pool.closeSessionTab("/sessions/none.jsonl")).toBe(true);
	});

	it("never opens a tab on a session the user deleted, whoever asks (a reopen, a layout, a marker)", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		initDeletedSessions(null);
		deletedSessions().add("/sessions/gone.jsonl");
		expect(pool.acquire("/a", fw.win, "tab-gone", "/sessions/gone.jsonl")).toBeNull();
		expect(
			pool.restoreLayout(fw.win, {
				version: 1,
				activeIndex: 0,
				tabs: [{ cwd: "/a", kind: "agent", sessionPath: "/sessions/gone.jsonl" }],
			}),
		).toBe(0);
		expect(sidecars).toHaveLength(0);
		// The same path on a paired host is another file.
		expect(
			pool.acquire(
				"/a",
				fw.win,
				"tab-host",
				"/sessions/gone.jsonl",
				"agent",
				undefined,
				false,
				false,
				false,
				undefined,
				"host-b",
			),
		).not.toBeNull();
		// The host refuses that tab later (it deleted the session while the tab was away): the tab closes, its window
		// drops it, and the session stays deleted for this device's next restore.
		const hostTab = sidecars.at(-1);
		hostTab?.emit("sessionDeleted", "/sessions/gone.jsonl");
		expect(pool.tabsForWindow(fw.win).map(tab => tab.tabId)).not.toContain("tab-host");
		expect(hostTab?.disposed).toBe(true);
		expect(deletedSessions().has("/sessions/gone.jsonl", "host-b")).toBe(true);
		initDeletedSessions(null);
	});

	it("a desktop window's restored layout skips a session another desktop window already holds (one session, one tab)", () => {
		const { pool } = fakePool();
		const first = fakeWindow(1);
		const second = fakeWindow(2);
		pool.restoreLayout(first.win, {
			version: 1,
			activeIndex: 0,
			tabs: [{ cwd: "/a", kind: "agent", sessionPath: "/sessions/s.jsonl" }],
		});
		const owner = pool.sessionOwner("/sessions/s.jsonl");
		if (!owner) throw new Error("expected the first window to own the session");

		const restored = pool.restoreLayout(second.win, {
			version: 1,
			activeIndex: 0,
			tabs: [
				{ cwd: "/a", kind: "agent", sessionPath: "/sessions/s.jsonl" },
				{ cwd: "/b", kind: "agent", sessionPath: "/sessions/t.jsonl" },
			],
		});

		expect(restored).toBe(1);
		expect(pool.tabsForWindow(second.win).map(tab => tab.sessionPath)).toEqual(["/sessions/t.jsonl"]);
		expect(pool.sessionOwner("/sessions/s.jsonl")).toEqual(owner);
	});

	it("a phone that viewed a desktop session views it again after a relaunch: one tab, one omp", () => {
		// Before: the desktop holds the session, the phone views that tab and has one of its own.
		const before = fakePool();
		const desktop = fakeWindow(1);
		const phone = fakeWindow(-1);
		const saved = new Map<number, PersistedTabLayout | null>();
		before.pool.onWindowTabsChanged = (win, layout) => saved.set(win.webContents.id, layout);
		before.pool.acquire("/a", desktop.win, "desk", "/sessions/shared.jsonl");
		before.pool.acquire("/b", phone.win, "own", "/sessions/phone.jsonl");
		expect(before.pool.attachViewer(phone.win, "desk")).toBe(true);
		// The phone's saved layout names the session it views too, and its own.
		expect(saved.get(-1)?.tabs.map(tab => tab.sessionPath)).toEqual([
			"/sessions/shared.jsonl",
			"/sessions/phone.jsonl",
		]);
		const desktopLayout = before.pool.tabLayoutForWindow(desktop.win);
		const phoneLayout = saved.get(-1);
		if (!desktopLayout || !phoneLayout) throw new Error("expected both layouts");
		expect(desktopLayout.tabs.map(tab => tab.sessionPath)).toEqual(["/sessions/shared.jsonl"]);

		// Relaunch: the desktop's windows first, then the paired device's (index.ts).
		const after = fakePool();
		const desktop2 = fakeWindow(1);
		const phone2 = fakeWindow(-2);
		after.pool.restoreLayout(desktop2.win, desktopLayout);
		const owner = after.pool.sessionOwner("/sessions/shared.jsonl");
		if (!owner) throw new Error("expected the desktop to own the session again");
		expect(after.pool.restoreLayout(phone2.win, phoneLayout)).toBe(2);

		const phoneTabs = after.pool.tabsForWindow(phone2.win);
		expect(phoneTabs.map(tab => [tab.sessionPath, tab.shared === true])).toEqual([
			["/sessions/shared.jsonl", true],
			["/sessions/phone.jsonl", false],
		]);
		expect(phoneTabs[0]?.tabId).toBe(owner.tabId);
		expect(after.pool.sessionOwner("/sessions/shared.jsonl")).toEqual(owner);
		// One sidecar per session: the desktop's and the phone's own, none for the viewed one.
		expect(after.sidecars).toHaveLength(2);
	});

	it("carries the task an agent opened a tab for in its status and the window's tab list", () => {
		const { pool } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		pool.setTabTask("tab-a", "Fix the flaky upload test");
		expect(fw.sentTo(IPC_EVENTS.TAB_STATUS).at(-1)?.data).toMatchObject({
			tabId: "tab-a",
			task: "Fix the flaky upload test",
		});
		expect(pool.tabsForWindow(fw.win)[0]?.task).toBe("Fix the flaky upload test");
	});

	it("keeps which session opened a tab through a relaunch: the opener's file rides the layout, not its tab id", () => {
		const before = fakePool();
		const fw = fakeWindow(1);
		before.pool.acquire("/a", fw.win, "tab-boss", "/sessions/boss.jsonl");
		before.pool.acquire("/wt/x", fw.win, "tab-child");
		before.pool.noteSessionFile("tab-child", "/sessions/child.jsonl");
		before.pool.setTabOpener("tab-child", "tab-boss");

		expect(fw.sentTo(IPC_EVENTS.TAB_STATUS).at(-1)?.data).toMatchObject({
			tabId: "tab-child",
			openedBy: "tab-boss",
			openedBySession: "/sessions/boss.jsonl",
		});
		const layout = before.pool.tabLayoutForWindow(fw.win);
		expect(layout?.tabs.map(tab => tab.openedBy)).toEqual([undefined, "/sessions/boss.jsonl"]);

		// The opener's tab closing does not forget it: the file is what finds it again.
		before.pool.releaseTab("tab-boss");
		expect(before.pool.tabLayoutForWindow(fw.win)?.tabs[0]?.openedBy).toBe("/sessions/boss.jsonl");

		if (!layout) throw new Error("expected a layout");
		const after = fakePool();
		const restoredWindow = fakeWindow(2);
		after.pool.restoreLayout(restoredWindow.win, layout);
		const [boss, child] = after.pool.tabsForWindow(restoredWindow.win);
		expect(child?.openedBySession).toBe("/sessions/boss.jsonl");
		expect(boss?.openedBySession).toBeUndefined();
		// Written out again, so a second relaunch still knows.
		expect(after.pool.tabLayoutForWindow(restoredWindow.win)?.tabs[1]?.openedBy).toBe("/sessions/boss.jsonl");
	});

	it("ignores an opener it does not hold", () => {
		const { pool } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		pool.setTabOpener("tab-a", "tab-gone");
		pool.setTabOpener("tab-gone", "tab-a");
		expect(pool.tabsForWindow(fw.win)[0]?.openedBy).toBeUndefined();
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
		// renames those straight on disk instead of asking a set_session_name
		// that has nobody to answer, rather than refusing it.
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

		// A relaunch restores into a pool where nothing holds the session any more.
		fw.close();
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
	it("does not retain fire-and-forget extension UI updates", async () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");

		sidecars[0]?.emitEditorText("update-1");
		expect(fw.sentTo(IPC_EVENTS.EXTENSION_UI)).toHaveLength(1);
		expect(await pool.routeSideChannel("update-1", { type: "extension_ui_response", id: "update-1" })).toBe(false);
	});

	it("routes an extension-ui response to the raising sidecar even after a tab switch", async () => {
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
		expect(await pool.routeSideChannel("req-1", response)).toBe(true);
		expect(a?.sentFrames).toEqual([response]);
		expect(b?.sentFrames).toEqual([]);

		// Final responses consume the route — a repeat id falls back to the caller.
		expect(await pool.routeSideChannel("req-1", response)).toBe(false);
	});

	it("routes identical request ids independently when panes provide their tab owner", async () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		pool.acquire("/b", fw.win, "tab-b");
		const [a, b] = sidecars;
		a?.emitExtensionUi("same-id");
		b?.emitExtensionUi("same-id");
		const yes = { type: "extension_ui_response", id: "same-id", confirmed: true };
		const no = { type: "extension_ui_response", id: "same-id", confirmed: false };
		expect(await pool.routeSideChannel("same-id", yes, "tab-a")).toBe(true);
		expect(await pool.routeSideChannel("same-id", no, "tab-b")).toBe(true);
		expect(a?.sentFrames).toEqual([yes]);
		expect(b?.sentFrames).toEqual([no]);
	});

	it("keeps the route when the sidecar cannot take the answer, so the card can be answered again", async () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		const [a] = sidecars;
		a?.emitExtensionUi("req-offline");
		const response = { type: "extension_ui_response", id: "req-offline", confirmed: true };

		if (a) a.sideChannelError = codedError("remote_offline", "The device running this tab is offline");
		await expect(pool.routeSideChannel("req-offline", response)).rejects.toThrow(/offline/);
		expect(a?.sentFrames).toEqual([]);
		expect(pool.openRequests(fw.win).map(open => open.request.id)).toEqual(["req-offline"]);

		// The link dropped while the answer was on its way: the host never took it, so the route stays too.
		if (a) {
			a.sideChannelError = undefined;
			a.sideChannelRejection = codedError("remote_offline", "The device running this tab is offline");
		}
		await expect(pool.routeSideChannel("req-offline", response)).rejects.toThrow(/offline/);
		expect(pool.openRequests(fw.win).map(open => open.request.id)).toEqual(["req-offline"]);
		expect(a?.sentFrames).toEqual([]);

		// The link is back: the same answer still finds its owner, and only now consumes the route.
		if (a) a.sideChannelRejection = undefined;
		expect(await pool.routeSideChannel("req-offline", response)).toBe(true);
		expect(a?.sentFrames).toEqual([response]);
		expect(await pool.routeSideChannel("req-offline", response)).toBe(false);
	});

	it("fails host-uri requests on the raising sidecar instead of forwarding them", async () => {
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
		expect(await pool.routeSideChannel("uri-1", { type: "host_uri_result", id: "uri-1" })).toBe(false);
	});

	it("answers host tools through the executor without tracking a route", async () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		const [a] = sidecars;
		pool.hostToolExecutor = (sidecar, request) => {
			sidecar.sendSideChannel({ type: "host_tool_result", id: request.id, result: "inline" });
		};

		a?.emitHostToolCall("tool-inline");
		expect(a?.sentFrames).toEqual([{ type: "host_tool_result", id: "tool-inline", result: "inline" }]);
		expect(await pool.routeSideChannel("tool-inline", { type: "host_tool_result", id: "tool-inline" })).toBe(false);
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

	it("drops pending routes when the owning tab is released", async () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		pool.acquire("/b", fw.win, "tab-b");
		const [a, b] = sidecars;

		a?.emitExtensionUi("req-doomed");
		expect(pool.releaseTab("tab-a")).toBe(true);
		// A late response falls back instead of writing to a disposed sidecar.
		expect(await pool.routeSideChannel("req-doomed", { type: "extension_ui_response", id: "req-doomed" })).toBe(
			false,
		);
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
	it("forwards a background tab's extension UI to its tab and routes the answer back", async () => {
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
		expect(await pool.routeSideChannel("ask-b", response)).toBe(true);
		expect(b?.sentFrames).toEqual([response]);
		expect(a?.sentFrames).toEqual([]);
	});

	it("forgets a request omp cancelled and forwards the cancel to the tab", async () => {
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
		expect(await pool.routeSideChannel("confirm-b", { type: "extension_ui_response", id: "confirm-b" })).toBe(false);
		expect(b?.sentFrames).toEqual([]);
	});

	it("lists the asks and approvals still open for a window that reloaded, until they are answered or withdrawn", async () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		const other = fakeWindow(2);
		pool.acquire("/a", fw.win, "tab-a");
		pool.acquire("/b", other.win, "tab-b");
		const [a, b] = sidecars;

		a?.emitUiRequest({ id: "ask-a", method: "ask", title: "Which one?", questions: [] });
		a?.emitUiRequest({ id: "confirm-a", method: "confirm", title: "Go?", message: "?" });
		a?.emitUiRequest({ id: "widget-a", method: "setWidget", widgetKey: "next-prompt", widgetLines: ["hi"] });
		b?.emitUiRequest({ id: "ask-b", method: "ask", title: "Elsewhere?", questions: [] });
		expect(pool.openRequests(fw.win).map(open => [open.tabId, open.request.id])).toEqual([
			["tab-a", "ask-a"],
			["tab-a", "confirm-a"],
		]);

		await pool.routeSideChannel("ask-a", { type: "extension_ui_response", id: "ask-a", cancelled: true });
		a?.emitUiRequest({ id: "cancel-1", method: "cancel", targetId: "confirm-a" });
		expect(pool.openRequests(fw.win)).toEqual([]);
		expect(pool.openRequests(other.win).map(open => open.request.id)).toEqual(["ask-b"]);
	});

	it("marks a provider sign-in's own requests, so a reloaded window gives them back to its login panel", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		const [a] = sidecars;
		pool.noteSignIn("tab-a", true);
		a?.emitUiRequest({ id: "url", method: "open_url", url: "https://claude.ai/oauth" });
		a?.emitUiRequest({ id: "paste", method: "input", title: "Paste the authorization code" });
		// Not a kind stock's login sends: an ordinary card even now.
		a?.emitUiRequest({ id: "ask", method: "confirm", title: "Go?", message: "?" });
		pool.noteSignIn("tab-a", false);
		// After the sign-in, a paste is the chat's again (an MCP server's sign-in).
		a?.emitUiRequest({ id: "mcp", method: "input", title: "Token" });
		expect(pool.openRequests(fw.win).map(open => [open.request.id, open.signIn !== undefined])).toEqual([
			["url", true],
			["paste", true],
			["ask", false],
			["mcp", false],
		]);
	});

	it("marks a sign-in's requests on the live frame and on a re-attach's re-send, and tells the page when the sign-in ends", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		const a = sidecars[0];
		if (!a) throw new Error("expected a sidecar");
		// The re-attach's list replaces the open set, so the gone ones' cards close with a `cancel`; those are not under test.
		const sent = () =>
			fw
				.sentTo(IPC_EVENTS.EXTENSION_UI)
				.map(item => item.data as IpcExtensionUiPayload)
				.filter(frame => frame.request.method !== "cancel");
		const paste = {
			type: "extension_ui_request",
			id: "paste",
			method: "input",
			title: "Paste the authorization code",
		};
		const mcp = { type: "extension_ui_request", id: "mcp", method: "input", title: "Token" };
		const url = "https://claude.ai/oauth";

		pool.noteSignIn("tab-a", true, { providerId: "anthropic" });
		a.emitUiRequest({ id: "url", method: "open_url", url, launchUrl: "http://localhost:1455/launch" });
		a.emitUiRequest({ id: "paste", method: "input", title: paste.title });
		a.emitUiRequest({ id: "ask", method: "confirm", title: "Go?", message: "?" });
		const link = pool.openRequests(fw.win)[0]?.request;
		expect(sent()).toMatchObject([
			{ request: { id: "url" }, signIn: { active: true, providerId: "anthropic", link } },
			{ request: { id: "paste" }, signIn: { active: true, providerId: "anthropic", link } },
			{ request: { id: "ask" } },
		]);
		expect(sent()[2]).not.toHaveProperty("signIn");

		// A re-attach re-sends the paste while `login` still runs: the page gets it as the panel's.
		fw.sent.length = 0;
		a.emit("openAsks", [paste]);
		expect(sent()).toMatchObject([{ request: { id: "paste" }, signIn: { active: true, providerId: "anthropic" } }]);

		// `login` answers: a page that took it over is told, with the outcome.
		pool.noteSignIn("tab-a", false, { providerId: "anthropic", error: "denied" });
		expect(fw.sentTo(IPC_EVENTS.SIGN_IN_ENDED).map(item => item.data)).toEqual([
			{ tabId: "tab-a", providerId: "anthropic", error: "denied" },
		]);

		// The leftover paste is still the panel's (answered `cancelled`); a later paste is the chat's.
		fw.sent.length = 0;
		a.emit("openAsks", [paste, mcp]);
		expect(sent()).toMatchObject([
			{ request: { id: "paste" }, signIn: { active: false, providerId: null } },
			{ request: { id: "mcp" } },
		]);
		expect(sent()[0]).not.toHaveProperty("signIn.link");
		expect(sent()[1]).not.toHaveProperty("signIn");
	});

	it("follows the sign-ins a paired host reports: its re-sent code paste stays the panel's while the host's login runs", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		const a = sidecars[0];
		if (!a) throw new Error("expected a sidecar");
		const paste = {
			type: "extension_ui_request",
			id: "paste",
			method: "input",
			title: "Paste the authorization code",
		};
		const frames = () =>
			fw
				.sentTo(IPC_EVENTS.EXTENSION_UI)
				.map(item => item.data as IpcExtensionUiPayload)
				.filter(frame => frame.request.method !== "cancel");
		const ended = () => fw.sentTo(IPC_EVENTS.SIGN_IN_ENDED).map(item => item.data);

		// This window's `login` call failed with the link, but the host's login runs on: it says so on re-attach.
		pool.noteSignIn("tab-a", true, { providerId: "anthropic" });
		pool.noteSignIn("tab-a", false, { providerId: "anthropic", error: "offline" });
		expect(ended()).toHaveLength(1);
		fw.sent.length = 0;
		a.emit("signIn", { active: ["anthropic"] });
		a.emit("openAsks", [paste]);
		expect(frames()).toMatchObject([{ request: { id: "paste" }, signIn: { active: true, providerId: "anthropic" } }]);
		expect(ended()).toEqual([]);
		expect(pool.openRequests(fw.win)[0]?.signIn).toMatchObject({ active: true, providerId: "anthropic" });

		// The host's login answers: the page that took it over learns the outcome.
		a.emit("signIn", { active: [], ended: { providerId: "anthropic", error: null } });
		expect(ended()).toEqual([{ tabId: "tab-a", providerId: "anthropic", error: null }]);
		expect(pool.openRequests(fw.win)[0]?.signIn).toMatchObject({ active: false });

		// An end that happened while the link was down shows only as the list shrinking: outcome unseen.
		fw.sent.length = 0;
		a.emit("signIn", { active: ["anthropic"] });
		a.emit("signIn", { active: [] });
		expect(ended()).toEqual([{ tabId: "tab-a", providerId: "anthropic" }]);

		// A local `login` still in flight keeps the tab's sign-in running whatever the host says.
		fw.sent.length = 0;
		pool.noteSignIn("tab-a", true, { providerId: "anthropic" });
		a.emit("signIn", { active: ["anthropic"] });
		a.emit("signIn", { active: [], ended: { providerId: "anthropic", error: "denied" } });
		expect(ended()).toEqual([]);
		pool.noteSignIn("tab-a", false, { providerId: "anthropic", error: "denied" });
		expect(ended()).toEqual([{ tabId: "tab-a", providerId: "anthropic", error: "denied" }]);
	});

	it("drops a paired host's sign-ins when the host reports its omp gone, so the next omp's asks are chat cards again", () => {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		const a = sidecars[0];
		if (!a) throw new Error("expected a sidecar");
		a.emitStatus("ready");
		a.emit("signIn", { active: ["anthropic"] });

		// A link blip is not the host's omp leaving: its login may still run.
		a.emitLinkStatus("error");
		a.emitLinkStatus("starting");
		expect(fw.sentTo(IPC_EVENTS.SIGN_IN_ENDED)).toEqual([]);

		// The host reports a new omp (the old tab closed after its grace, or the host restarted): that
		// omp's logins died with it, and the outcome went unseen.
		a.emitStatus("starting");
		expect(fw.sentTo(IPC_EVENTS.SIGN_IN_ENDED).map(item => item.data)).toEqual([
			{ tabId: "tab-a", providerId: "anthropic" },
		]);
		a.emitStatus("ready");
		a.emitUiRequest({ id: "ask", method: "input", title: "Which branch?" });
		expect(pool.openRequests(fw.win)).toEqual([{ tabId: "tab-a", request: expect.objectContaining({ id: "ask" }) }]);
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

	describe("resume facts (turn-resume.ts)", () => {
		it("reports a running turn, an open ask, Stop, and the waiting-for-connection state per tab", async () => {
			const { pool, sidecars } = fakePool();
			const fw = fakeWindow(1);
			pool.acquire("/a", fw.win, "tab-a", "/sessions/a.jsonl");
			const a = sidecars[0];
			a?.emitStatus("ready");
			const changes = vi.fn();
			pool.onRunningChange = changes;
			const factA = () => pool.resumeFacts().find(fact => fact.tabId === "tab-a");

			expect(factA()).toMatchObject({ sessionFile: "/sessions/a.jsonl", running: false, awaitingUi: false });

			a?.emitEvents([{ type: "agent_start" }]);
			expect(factA()).toMatchObject({ running: true, stopped: false });

			// An ask raises a blocking request: the tab says so, and the resume rules hear of it.
			changes.mockClear();
			a?.emitUiRequest({ id: "ask-1", method: "ask", title: "Which?", questions: [] });
			expect(factA()?.awaitingUi).toBe(true);
			expect(changes).toHaveBeenCalled();
			changes.mockClear();
			await pool.routeSideChannel("ask-1", { type: "extension_ui_response", id: "ask-1" });
			expect(factA()?.awaitingUi).toBe(false);
			expect(changes).toHaveBeenCalled();

			// Stop is remembered until the next run starts.
			pool.noteStopped("tab-a");
			expect(factA()?.stopped).toBe(true);
			a?.emitEvents([{ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "aborted" }] }]);
			a?.emitEvents([{ type: "agent_start" }]);
			expect(factA()?.stopped).toBe(false);

			pool.setAwaitingConnection("tab-a", true);
			expect(factA()?.awaitingConnection).toBe(true);
			expect(fw.sentTo(IPC_EVENTS.TAB_STATUS).at(-1)?.data).toMatchObject({
				tabId: "tab-a",
				awaitingConnection: true,
			});
			pool.setAwaitingConnection("tab-a", false);
			expect(fw.sentTo(IPC_EVENTS.TAB_STATUS).at(-1)?.data).not.toHaveProperty("awaitingConnection");
		});

		it("holds a scheduled retry in main: TAB_STATUS pushes it, GET_TABS re-reads it after a reload, and clearing removes it", () => {
			const { pool, sidecars } = fakePool();
			const fw = fakeWindow(1);
			pool.acquire("/a", fw.win, "tab-a", "/sessions/a.jsonl");
			sidecars[0]?.emitStatus("ready");
			const retry = { at: 31_000, attempt: 1, max: 3 };

			pool.setScheduledRetry("tab-a", retry);
			expect(fw.sentTo(IPC_EVENTS.TAB_STATUS).at(-1)?.data).toMatchObject({ tabId: "tab-a", scheduledRetry: retry });
			// A renderer that reloads asks for the window's tabs again.
			expect(pool.tabsForWindow(fw.win).find(tab => tab.tabId === "tab-a")?.scheduledRetry).toEqual(retry);

			pool.setScheduledRetry("tab-a", undefined);
			expect(fw.sentTo(IPC_EVENTS.TAB_STATUS).at(-1)?.data).not.toHaveProperty("scheduledRetry");
			expect(pool.tabsForWindow(fw.win).find(tab => tab.tabId === "tab-a")).not.toHaveProperty("scheduledRetry");
			// An unknown tab is ignored.
			expect(() => pool.setScheduledRetry("nope", retry)).not.toThrow();
		});

		it("counts the user's session edits as `touched` and tells the resume rules", () => {
			const { pool, sidecars } = fakePool();
			const fw = fakeWindow(1);
			pool.acquire("/a", fw.win, "tab-a", "/sessions/a.jsonl");
			sidecars[0]?.emitStatus("ready");
			const changes = vi.fn();
			pool.onRunningChange = changes;
			const factA = () => pool.resumeFacts().find(fact => fact.tabId === "tab-a");

			expect(factA()).not.toHaveProperty("touched");
			pool.noteTouched("tab-a");
			expect(factA()?.touched).toBe(1);
			expect(changes).toHaveBeenCalled();
			pool.noteTouched("tab-a");
			expect(factA()?.touched).toBe(2);
		});

		it("reports stock's pending auto-retry with its failure, and tells the resume rules when one starts", () => {
			const { pool, sidecars } = fakePool();
			const fw = fakeWindow(1);
			pool.acquire("/a", fw.win, "tab-a", "/sessions/a.jsonl");
			const a = sidecars[0];
			a?.emitStatus("ready");
			a?.emitEvents([{ type: "agent_start" }]);
			const changes = vi.fn();
			pool.onRunningChange = changes;
			const factA = () => pool.resumeFacts().find(fact => fact.tabId === "tab-a");

			a?.emitEvents([
				{ type: "auto_retry_start", attempt: 1, maxAttempts: 10, delayMs: 500, errorMessage: "Connection error." },
			]);
			expect(changes).toHaveBeenCalled();
			expect(factA()?.retry).toEqual({ errorMessage: "Connection error." });
			a?.emitEvents([{ type: "auto_retry_end", success: true, attempt: 1 }]);
			expect(factA()?.retry).toBeUndefined();
		});

		it("forgets an open ask when its omp exits or restarts: no 'asking' outlives the process", async () => {
			const { pool, sidecars } = fakePool();
			const fw = fakeWindow(1);
			pool.acquire("/a", fw.win, "tab-a", "/sessions/a.jsonl");
			const a = sidecars[0];
			a?.emitStatus("ready");
			a?.emitEvents([{ type: "agent_start" }]);
			a?.emitUiRequest({ id: "ask-1", method: "ask", title: "Which?", questions: [] });
			const factA = () => pool.resumeFacts().find(fact => fact.tabId === "tab-a");
			expect(factA()?.awaitingUi).toBe(true);
			const changes = vi.fn();
			pool.onRunningChange = changes;

			// omp crashed: the restarted process never heard of that request.
			a?.emitStatus("restarting");
			expect(factA()).toMatchObject({ running: false, awaitingUi: false });
			expect(changes).toHaveBeenCalled();
			a?.emitStatus("ready");
			expect(factA()?.awaitingUi).toBe(false);
			// A late answer has no live request to reach.
			expect(await pool.routeSideChannel("ask-1", { type: "extension_ui_response", id: "ask-1" })).toBe(false);
		});

		it("keeps a paired host's open ask through a link blip, and drops it once the host reports its omp gone", async () => {
			const { pool, sidecars } = fakePool();
			const fw = fakeWindow(1);
			pool.acquire("/a", fw.win, "tab-a", "/sessions/a.jsonl");
			const a = sidecars[0];
			a?.emitStatus("ready");
			a?.emitUiRequest({ id: "ask-1", method: "ask", title: "Which?", questions: [] });

			// The link dropped and came back: the host's omp still holds the ask.
			a?.emitLinkStatus("error");
			a?.emitLinkStatus("starting");
			expect(pool.openRequests(fw.win).map(open => open.request.id)).toEqual(["ask-1"]);
			a?.emitStatus("ready");
			expect(pool.openRequests(fw.win).map(open => open.request.id)).toEqual(["ask-1"]);

			// The host itself says its omp restarted: that request is gone with it.
			a?.emitStatus("restarting");
			expect(pool.openRequests(fw.win)).toEqual([]);
			expect(await pool.routeSideChannel("ask-1", { type: "extension_ui_response", id: "ask-1" })).toBe(false);
		});

		it("replaces a paired host's open asks with the list its re-attach sends, closing the gone ones' cards", async () => {
			const { pool, sidecars } = fakePool();
			const fw = fakeWindow(1);
			pool.acquire("/a", fw.win, "tab-a", "/sessions/a.jsonl");
			const a = sidecars[0];
			if (!a) throw new Error("expected a sidecar");
			a.emitStatus("ready");
			a.emitUiRequest({ id: "stale", method: "confirm", title: "Deploy?", message: "" });
			a.emitUiRequest({ id: "kept", method: "ask", questions: [] });
			const kept = pool.openRequests(fw.win)[1]?.request;
			const raised = { type: "extension_ui_request", id: "raised", method: "input", title: "Name?" };
			const uiSent = () => fw.sentTo(IPC_EVENTS.EXTENSION_UI).map(entry => entry.data);

			// The link dropped and came back; the host's omp withdrew one ask meanwhile and raised another.
			a.emitLinkStatus("error");
			a.emitLinkStatus("starting");
			a.emitStatus("ready");
			fw.sent.length = 0;
			a.emit("openAsks", [kept, raised]);
			expect(pool.openRequests(fw.win).map(open => open.request.id)).toEqual(["kept", "raised"]);
			expect(pool.resumeFacts()[0]?.awaitingUi).toBe(true);
			// The gone one's card closes; the reconnect's `starting` cleared the page, so the open ones come back.
			// One this window already showed is marked `resent` (its OS notification went out then); the new one is not.
			expect(uiSent()).toEqual([
				{
					tabId: "tab-a",
					request: { type: "extension_ui_request", id: "withdrawn:stale", method: "cancel", targetId: "stale" },
				},
				{ tabId: "tab-a", request: kept, resent: true },
				{ tabId: "tab-a", request: raised },
			]);
			expect(await pool.routeSideChannel("stale", { type: "extension_ui_response", id: "stale" })).toBe(false);

			// An answer on its way when the list was taken: neither dropped nor shown again.
			const delivered = Promise.withResolvers<void>();
			vi.spyOn(a, "sendSideChannel").mockReturnValueOnce(delivered.promise);
			const answering = pool.routeSideChannel("kept", { type: "extension_ui_response", id: "kept", answers: [] });
			fw.sent.length = 0;
			a.emit("openAsks", [kept, raised]);
			expect(uiSent()).toEqual([{ tabId: "tab-a", request: raised, resent: true }]);
			delivered.resolve();
			expect(await answering).toBe(true);
			expect(pool.openRequests(fw.win).map(open => open.request.id)).toEqual(["raised"]);

			// The host's omp restarted while the link was down and holds nothing now.
			fw.sent.length = 0;
			a.emit("openAsks", []);
			expect(pool.openRequests(fw.win)).toEqual([]);
			expect(pool.resumeFacts()[0]?.awaitingUi).toBe(false);
			expect(uiSent()).toEqual([
				{
					tabId: "tab-a",
					request: { type: "extension_ui_request", id: "withdrawn:raised", method: "cancel", targetId: "raised" },
				},
			]);
		});

		it("starts a deferred tab's process on demand and finds the tab of a session", () => {
			const { pool, sidecars } = fakePool();
			const fw = fakeWindow(1);
			pool.acquire("/a", fw.win, "tab-a", "/sessions/a.jsonl", "agent", undefined, false, false, true);
			expect(sidecars[0]?.status).toBe("asleep");
			expect(pool.tabForSession("/sessions/a.jsonl")).toBe("tab-a");
			expect(pool.tabForSession("/sessions/none.jsonl")).toBeNull();

			expect(pool.startTab("tab-a")).toBe(sidecars[0]);
			expect(sidecars[0]?.status).not.toBe("asleep");
			expect(pool.startTab("missing")).toBeNull();
		});

		it("shows the wait a paired host holds for its tab (the host's `awaitingConnection` event)", () => {
			const { pool, sidecars } = fakePool();
			const fw = fakeWindow(1);
			pool.acquire("/a", fw.win, "tab-a", "/sessions/a.jsonl");
			const a = sidecars[0];
			a?.emitStatus("ready");
			a?.emit("awaitingConnection", true);
			expect(pool.resumeFacts()[0]?.awaitingConnection).toBe(true);
			expect(fw.sentTo(IPC_EVENTS.TAB_STATUS).at(-1)?.data).toMatchObject({
				tabId: "tab-a",
				awaitingConnection: true,
			});
			// The link dropping does not end the host's wait.
			a?.emitStatus("error");
			expect(pool.resumeFacts()[0]?.awaitingConnection).toBe(true);
			a?.emit("awaitingConnection", false);
			expect(pool.resumeFacts()[0]?.awaitingConnection).toBe(false);
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

describe("SidecarPool multi-viewer", () => {
	/** A desktop window owning tab-a, and a web device's window (negative id) viewing it. */
	function shared() {
		const { pool, sidecars } = fakePool();
		const desktop = fakeWindow(1);
		const phone = fakeWindow(-1);
		pool.acquire("/a", desktop.win, "tab-a");
		const [sidecar] = sidecars;
		if (!sidecar) throw new Error("no sidecar");
		sidecar.emitStatus("ready");
		expect(pool.attachViewer(phone.win, "tab-a")).toBe(true);
		desktop.sent.length = 0;
		phone.sent.length = 0;
		return { pool, sidecar, desktop, phone };
	}

	it("fans one set of sidecar listeners out to every window that shows the tab", () => {
		const { pool, sidecar, desktop, phone } = shared();
		// Light wiring once plus one full wiring for both windows.
		expect(sidecar.listenerCount("events")).toBe(2);
		sidecar.emitAgentEvents(["agent_start"]);
		expect(desktop.sentTo(IPC_EVENTS.EVENTS_BATCH)).toHaveLength(1);
		expect(phone.sentTo(IPC_EVENTS.EVENTS_BATCH)).toHaveLength(1);
		expect(phone.sentTo(IPC_EVENTS.TAB_STATUS).at(-1)?.data).toMatchObject({ tabId: "tab-a", status: "running" });
		expect(desktop.sentTo(IPC_EVENTS.TAB_STATUS).at(-1)?.data).toMatchObject({ tabId: "tab-a", status: "running" });

		// Each window has its own view: hiding the tab in the desktop keeps the phone's stream.
		pool.acquire("/b", desktop.win, "tab-b");
		expect(pool.setActiveTab(desktop.win, "tab-b")).toBe(true);
		desktop.sent.length = 0;
		phone.sent.length = 0;
		sidecar.emitAgentEvents(["agent_end"]);
		expect(desktop.sentTo(IPC_EVENTS.EVENTS_BATCH)).toHaveLength(0);
		expect(phone.sentTo(IPC_EVENTS.EVENTS_BATCH)).toHaveLength(1);
		expect(pool.activeTabForWindow(phone.win)).toBe("tab-a");
	});

	it("lists a viewed tab as shared, counts its viewers, and lets the viewer reach it", () => {
		const { pool, sidecar, desktop, phone } = shared();
		expect(pool.tabsForWindow(phone.win)).toMatchObject([{ tabId: "tab-a", shared: true, viewerCount: 1 }]);
		expect(pool.tabsForWindow(desktop.win)[0]).toMatchObject({ tabId: "tab-a", viewerCount: 1 });
		expect(pool.tabsForWindow(desktop.win)[0]?.shared).toBeUndefined();
		expect(pool.sidecarForTab(phone.win, "tab-a")).toBe(sidecar);
		expect(pool.tabTarget(phone.win, "tab-a")).toMatchObject({ tabId: "tab-a", winId: 1 });
		expect(pool.isShared("tab-a")).toBe(true);
		// The saved layout stays the owner's.
		expect(pool.tabLayoutForWindow(phone.win)).toBeNull();
	});

	it("takes the first answer to an ask; the other window's card closes and its late answer is refused", async () => {
		const { pool, sidecar, desktop, phone } = shared();
		sidecar.emitExtensionUi("req-1");
		expect(desktop.sentTo(IPC_EVENTS.EXTENSION_UI)).toHaveLength(1);
		expect(phone.sentTo(IPC_EVENTS.EXTENSION_UI)).toHaveLength(1);
		expect(pool.openRequests(phone.win).map(open => open.request.id)).toEqual(["req-1"]);

		const yes = { type: "extension_ui_response", id: "req-1", confirmed: true };
		expect(await pool.routeSideChannel("req-1", yes, undefined, phone.win)).toBe(true);
		expect(sidecar.sentFrames).toEqual([yes]);
		expect(desktop.sentTo(IPC_EVENTS.EXTENSION_UI).at(-1)?.data).toEqual({
			tabId: "tab-a",
			request: { type: "extension_ui_request", id: "answered:req-1", method: "cancel", targetId: "req-1" },
			answeredElsewhere: true,
		});
		expect(phone.sentTo(IPC_EVENTS.EXTENSION_UI)).toHaveLength(1);

		const no = { type: "extension_ui_response", id: "req-1", confirmed: false };
		await expect(pool.routeSideChannel("req-1", no, undefined, desktop.win)).rejects.toThrow("[already_answered]");
		await expect(pool.routeSideChannel("req-1", no, "tab-a", desktop.win)).rejects.toThrow("[already_answered]");
		expect(sidecar.sentFrames).toEqual([yes]);
	});

	it("lets every window answer again when the first answer never reached the omp", async () => {
		const { pool, sidecar, desktop, phone } = shared();
		sidecar.emitExtensionUi("req-1");
		const response = { type: "extension_ui_response", id: "req-1", confirmed: true };
		sidecar.sideChannelError = new Error("link down");
		await expect(pool.routeSideChannel("req-1", response, undefined, phone.win)).rejects.toThrow("link down");
		sidecar.sideChannelError = undefined;
		expect(await pool.routeSideChannel("req-1", response, undefined, desktop.win)).toBe(true);
		expect(phone.sentTo(IPC_EVENTS.EXTENSION_UI).at(-1)?.data).toMatchObject({ answeredElsewhere: true });
	});

	it("lets a viewer leave without touching the sidecar or the owner's view", () => {
		const { pool, sidecar, desktop, phone } = shared();
		expect(pool.detachViewer(desktop.win, "tab-a")).toBe(false);
		phone.close();
		expect(sidecar.disposed).toBe(false);
		expect(pool.isShared("tab-a")).toBe(false);
		expect(pool.size).toBe(1);
	});

	it("lets a viewer close the tab in its own window and keep its other view", () => {
		const { pool, sidecar, desktop, phone } = shared();
		expect(pool.detachViewer(phone.win, "tab-a")).toBe(true);
		expect(sidecar.disposed).toBe(false);
		expect(pool.tabsForWindow(phone.win)).toEqual([]);
		expect(pool.activeTabForWindow(phone.win)).toBeNull();
		expect(phone.sentTo(IPC_EVENTS.TAB_LIST_CHANGED).at(-1)?.data).toEqual({ tabs: [] });
		expect(pool.tabsForWindow(desktop.win)[0]?.viewerCount).toBeUndefined();
		expect(desktop.sentTo(IPC_EVENTS.TAB_LIST_CHANGED).at(-1)?.data).toEqual({
			tabs: pool.tabsForWindow(desktop.win),
		});
		expect(sidecar.listenerCount("events")).toBe(2);
		desktop.sent.length = 0;
		sidecar.emitAgentEvents(["agent_start"]);
		expect(desktop.sentTo(IPC_EVENTS.EVENTS_BATCH)).toHaveLength(1);
	});

	it("releases the tab for every window when its owner window closes", () => {
		const { pool, sidecar, desktop, phone } = shared();
		desktop.close();
		expect(sidecar.disposed).toBe(true);
		expect(pool.size).toBe(0);
		expect(phone.sentTo(IPC_EVENTS.TAB_LIST_CHANGED).at(-1)?.data).toEqual({ tabs: [] });
		expect(pool.activeTabForWindow(phone.win)).toBeNull();
	});

	it("tells the omp a draft is empty only once every window's is, and again when a busy viewer leaves", async () => {
		const { pool, sidecar, desktop, phone } = shared();
		const command = "set_idle_compaction_draft";
		expect(pool.noteDraft("tab-a", desktop.win.webContents.id, command, true)).toBe(true);
		expect(pool.noteDraft("tab-a", phone.win.webContents.id, command, false)).toBe(false);
		expect(pool.noteDraft("tab-a", desktop.win.webContents.id, command, true)).toBe(false);
		// The other draft command is counted on its own.
		expect(pool.noteDraft("tab-a", desktop.win.webContents.id, "set_next_prompt_draft", true)).toBe(true);
		phone.close();
		await Promise.resolve();
		expect(sidecar.rpcCommands).toEqual([{ type: command, empty: true }]);
		expect(pool.noteDraft("tab-a", desktop.win.webContents.id, command, true)).toBe(true);
	});
});

describe("SidecarPool tab activity (the observer Web Push listens to)", () => {
	function observed() {
		const { pool, sidecars } = fakePool();
		const fw = fakeWindow(1);
		pool.acquire("/a", fw.win, "tab-a");
		const a = sidecars[0];
		if (!a) throw new Error("expected a sidecar");
		a.emitStatus("ready");
		a.emitSessionInfo({ title: "Refactor" });
		const seen: TabActivity[] = [];
		pool.observeTabs(activity => seen.push(activity));
		return { pool, a, fw, seen };
	}
	const reply = (stopReason: string, extra: Record<string, unknown> = {}) => ({
		type: "agent_end",
		messages: [{ role: "assistant", content: [{ type: "text", text: "All done." }], stopReason, ...extra }],
	});

	it("announces a turn starting and settling idle, with how it ended", () => {
		const { a, seen } = observed();
		a.emitEvents([{ type: "agent_start" }]);
		a.emitEvents([reply("stop")]);
		expect(seen).toEqual([
			{ type: "busy", tabId: "tab-a" },
			{ type: "idle", tabId: "tab-a", outcome: { stopReason: "stop", reply: "All done." } },
		]);
	});

	it("announces a fast turn that starts and ends inside one batch as idle", () => {
		const { a, seen } = observed();
		a.emitEvents([{ type: "agent_start" }, reply("error", { errorMessage: "boom", content: [] })]);
		expect(seen).toEqual([{ type: "idle", tabId: "tab-a", outcome: { stopReason: "error", errorMessage: "boom" } }]);
	});

	it("waits for background work: idle comes at session_settled, not at agent_end", () => {
		const { a, seen } = observed();
		a.emitEvents([{ type: "agent_start" }]);
		a.emit("promptResult", { type: "prompt_result", sessionSettled: false });
		a.emitEvents([reply("stop")]);
		expect(seen.map(activity => activity.type)).toEqual(["busy"]);
		a.emit("sessionSettled", { type: "session_settled" });
		expect(seen.map(activity => activity.type)).toEqual(["busy", "idle"]);
		expect(seen[1]).toMatchObject({ outcome: { stopReason: "stop" } });
	});

	it("does not announce the middle of an auto-retry saga as settled", () => {
		const { a, seen } = observed();
		a.emitEvents([{ type: "agent_start" }]);
		a.emitEvents([{ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "529" }]);
		a.emitEvents([reply("error", { errorMessage: "529", content: [] })]);
		expect(seen.map(activity => activity.type)).toEqual(["busy"]);
		a.emitEvents([{ type: "auto_retry_end", success: false, attempt: 3, finalError: "overloaded" }]);
		expect(seen.at(-1)).toEqual({
			type: "idle",
			tabId: "tab-a",
			outcome: { stopReason: "error", errorMessage: "overloaded" },
		});
	});

	it("announces an ask when it is raised and when it is answered", async () => {
		const { pool, a, seen } = observed();
		a.emitUiRequest({ id: "ask-1", method: "confirm", title: "Deploy?", message: "" });
		expect(seen).toEqual([{ type: "ask", tabId: "tab-a", requestId: "ask-1", text: "Deploy?" }]);
		await pool.routeSideChannel("ask-1", { type: "extension_ui_response", id: "ask-1", confirmed: true });
		expect(seen.at(-1)).toEqual({ type: "askClosed", tabId: "tab-a", requestId: "ask-1" });
		expect(seen).toHaveLength(2);
	});

	it("announces an ask omp withdrew, and every ask a restart of its omp took with it", () => {
		const { a, seen } = observed();
		a.emitUiRequest({ id: "ask-1", method: "select", title: "Which?", options: [] });
		a.emitUiRequest({ id: "cancel-1", method: "cancel", targetId: "ask-1" });
		expect(seen.map(activity => activity.type)).toEqual(["ask", "askClosed"]);
		a.emitUiRequest({ id: "ask-2", method: "input", title: "Name?" });
		a.emitStatus("restarting");
		expect(seen.slice(2)).toEqual([
			{ type: "ask", tabId: "tab-a", requestId: "ask-2", text: "Name?" },
			{ type: "askClosed", tabId: "tab-a", requestId: "ask-2" },
		]);
	});

	it("keeps a paired host's ask through a link blip, announces the ones a re-attach raised or withdrew, not the ones it re-sent", () => {
		const { a, seen } = observed();
		a.emitUiRequest({ id: "stale", method: "confirm", title: "Deploy?", message: "" });
		a.emitUiRequest({ id: "kept", method: "input", title: "Name?" });
		a.emitLinkStatus("error");
		a.emitLinkStatus("starting");
		a.emitStatus("ready");
		expect(seen.map(activity => activity.type)).toEqual(["ask", "ask"]);
		const keptRequest = { type: "extension_ui_request", id: "kept", method: "input", title: "Name?" };
		const raised = { type: "extension_ui_request", id: "raised", method: "input", title: "Other?" };
		a.emit("openAsks", [keptRequest, raised]);
		expect(seen.slice(2)).toEqual([
			{ type: "askClosed", tabId: "tab-a", requestId: "stale" },
			{ type: "ask", tabId: "tab-a", requestId: "raised", text: "Other?" },
		]);
	});

	it("never announces a provider sign-in's own requests as asks", () => {
		const { pool, a, seen } = observed();
		pool.noteSignIn("tab-a", true, { providerId: "anthropic" });
		a.emitUiRequest({ id: "url-1", method: "open_url", url: "https://example.com/login" });
		a.emitUiRequest({ id: "paste-1", method: "input", title: "Paste the code" });
		expect(seen).toEqual([]);
	});

	it("announces a released tab, and an observer that throws never breaks the pool or the others", () => {
		const { pool, a, seen } = observed();
		const later: TabActivity[] = [];
		pool.observeTabs(() => {
			throw new Error("observer failed");
		});
		const stop = pool.observeTabs(activity => later.push(activity));
		a.emitEvents([{ type: "agent_start" }]);
		expect(seen).toEqual([{ type: "busy", tabId: "tab-a" }]);
		expect(later).toEqual(seen);
		stop();
		pool.releaseTab("tab-a");
		expect(seen.at(-1)).toEqual({ type: "released", tabId: "tab-a" });
		expect(later).toHaveLength(1);
	});

	it("reports a live tab's facts for the debounce's second look, null once it is gone", () => {
		const { pool, a } = observed();
		expect(pool.tabFacts("tab-a")).toEqual({
			title: "Refactor",
			busy: false,
			awaitingConnection: false,
			retrying: false,
			scheduledRetry: false,
		});
		a.emitEvents([{ type: "agent_start" }]);
		pool.setAwaitingConnection("tab-a", true);
		a.emitEvents([{ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10, errorMessage: "529" }]);
		expect(pool.tabFacts("tab-a")).toEqual({
			title: "Refactor",
			busy: true,
			awaitingConnection: true,
			retrying: true,
			scheduledRetry: false,
		});
		pool.setScheduledRetry("tab-a", { at: 1_000, attempt: 1, max: 3 });
		expect(pool.tabFacts("tab-a")?.scheduledRetry).toBe(true);
		pool.setScheduledRetry("tab-a", undefined);
		expect(pool.tabFacts("tab-a")?.scheduledRetry).toBe(false);
		pool.releaseTab("tab-a");
		expect(pool.tabFacts("tab-a")).toBeNull();
		expect(pool.tabFacts("nope")).toBeNull();
	});

	it("holds a tab's plan proposal from its frame until it resolves or the omp goes away", () => {
		const { pool, a } = observed();
		const frame = {
			type: "plan_proposal",
			planFilePath: "local://PLAN.md",
			title: "Plan",
			planContent: "x",
			options: [],
		};
		a.emitEvents([frame]);
		expect(pool.pendingPlan("tab-a")).toEqual({ title: "Plan", planFilePath: "local://PLAN.md" });
		a.emitEvents([{ type: "plan_proposal_resolved", planFilePath: "local://other.md" }]);
		expect(pool.pendingPlan("tab-a")).not.toBeNull();
		a.emitEvents([{ type: "plan_proposal_resolved", planFilePath: "local://PLAN.md" }]);
		expect(pool.pendingPlan("tab-a")).toBeNull();
		a.emitEvents([frame]);
		a.emit("status", { status: "restarting" });
		expect(pool.pendingPlan("tab-a")).toBeNull();
	});
});

describe("SidecarPool hosted views (a window here showing a paired device's tab on this computer)", () => {
	function hostedView() {
		const { pool } = fakePool();
		const desktop = fakeWindow(1);
		const view = Object.assign(new FakeSidecar("/work"), { kind: "agent" as const });
		view.currentStatus = "ready";
		expect(pool.acquireHostedView(desktop.win, "tab-h", view as unknown as SidecarLike, "/s/x.jsonl")).toBe(true);
		return { pool, desktop, view };
	}

	it("lists the view as a shared tab of its window and owns the session here, yet runs and restarts nothing", () => {
		const { pool, desktop, view } = hostedView();
		expect(pool.tabsForWindow(desktop.win)).toMatchObject([
			{ tabId: "tab-h", shared: true, status: "ready", sessionPath: "/s/x.jsonl", active: true },
		]);
		expect(pool.sessionOwner("/s/x.jsonl")).toEqual({ tabId: "tab-h", winId: 1 });
		expect(pool.isHostedView("tab-h")).toBe(true);
		expect(view.started).toBe(false);
		view.emitAgentEvents(["agent_start"]);
		expect(desktop.sentTo(IPC_EVENTS.TAB_STATUS).at(-1)?.data).toMatchObject({ tabId: "tab-h", status: "running" });
		// The device's tab is the resume coordinator's, the quit guard's and the updaters': a view is none of theirs,
		// and a relaunch never reopens it as this computer's own omp.
		expect(pool.resumeFacts()).toEqual([]);
		expect(pool.tabInventory()).toEqual([]);
		expect(pool.tabLayoutForWindow(desktop.win)).toBeNull();
		expect(pool.workspaceDirs()).toEqual([]);
		view.emitAgentEvents(["agent_end"]);
		pool.restartOnNewOmp();
		pool.applyExtensionUpdate({ reload: false, restart: true, reconnect: [] });
		expect(view.restartArgs).toEqual([]);
	});

	it("closes the view without an error status when the device's tab ends, and the window's list drops it", () => {
		const { pool, desktop, view } = hostedView();
		desktop.sent.length = 0;
		view.emit(VIEW_ENDED_EVENT);
		expect(view.disposed).toBe(true);
		expect(pool.sessionOwner("/s/x.jsonl")).toBeNull();
		expect(pool.isHostedView("tab-h")).toBe(false);
		expect(desktop.sentTo(IPC_EVENTS.TAB_LIST_CHANGED).at(-1)?.data).toEqual({ tabs: [] });
		expect(desktop.sentTo(IPC_EVENTS.TAB_STATUS)).toEqual([]);
	});

	it("marks the cancel of an ask the device answered first as answered elsewhere, never omp's own withdrawal", () => {
		const { desktop, view } = hostedView();
		view.emitExtensionUi("ask-1");
		view.emitUiRequest({ id: "answered:ask-1", method: "cancel", targetId: "ask-1" });
		expect(desktop.sentTo(IPC_EVENTS.EXTENSION_UI).at(-1)?.data).toMatchObject({
			request: { method: "cancel", targetId: "ask-1" },
			answeredElsewhere: true,
		});
		view.emitExtensionUi("ask-2");
		view.emitUiRequest({ id: "c", method: "cancel", targetId: "ask-2" });
		expect(desktop.sentTo(IPC_EVENTS.EXTENSION_UI).at(-1)?.data).not.toHaveProperty("answeredElsewhere");
	});
});

describe("SidecarPool device views (a paired device viewing a tab of a window here)", () => {
	const MAC = { deviceId: "mac", name: "Mac" };
	function viewed() {
		const { pool, sidecars } = fakePool();
		const desktop = fakeWindow(1);
		pool.acquire("/a", desktop.win, "tab-a", "/s/a.jsonl");
		const [sidecar] = sidecars;
		if (!sidecar) throw new Error("no sidecar");
		sidecar.emitStatus("ready");
		const view = pool.viewForDevice("/s/a.jsonl", MAC, "Host B");
		if (!view) throw new Error("no view");
		desktop.sent.length = 0;
		return { pool, sidecar, desktop, view };
	}

	it("hands the device the tab's omp: its stream but never its host tool calls, the tab counts it as a viewer", async () => {
		const { pool, sidecar, desktop, view } = viewed();
		expect(pool.viewForDevice("/s/none.jsonl", MAC, "Host B")).toBeNull();
		const seen: string[] = [];
		for (const name of ["events", "hostToolCall", "hostUriRequest"]) view.on(name, () => seen.push(name));
		sidecar.emitAgentEvents(["agent_start"]);
		sidecar.emitHostToolCall("h1");
		sidecar.emitHostUriRequest("u1");
		expect(seen).toEqual(["events"]);
		expect(pool.tabsForWindow(desktop.win)[0]).toMatchObject({ tabId: "tab-a", viewerCount: 1 });
		expect(pool.deviceViewing("/s/a.jsonl")).toBe(true);
		await view.rpcClient?.command({ type: "prompt", message: "hi" });
		expect(sidecar.rpcCommands).toEqual([
			{ type: "prompt_origin_set", origin: MAC, text: "hi" },
			{ type: "prompt", message: "hi" },
		]);
		// The device leaving takes only its listeners.
		view.removeAllListeners();
		view.dispose();
		expect(sidecar.disposed).toBe(false);
		expect(pool.deviceViewing("/s/a.jsonl")).toBe(false);
	});

	it("takes the first answer to an ask from the device or a window, and refuses the other's", async () => {
		const { pool, sidecar, desktop, view } = viewed();
		sidecar.emitExtensionUi("req-1");
		const yes = { type: "extension_ui_response", id: "req-1", confirmed: true };
		await view.sendSideChannel(yes);
		expect(sidecar.sentFrames).toEqual([yes]);
		expect(desktop.sentTo(IPC_EVENTS.EXTENSION_UI).at(-1)?.data).toMatchObject({ answeredElsewhere: true });
		await expect(
			pool.routeSideChannel("req-1", { ...yes, confirmed: false }, undefined, desktop.win),
		).rejects.toThrow("[already_answered]");

		const ui: Array<{ id?: string }> = [];
		view.on("extensionUi", (request: { id?: string }) => ui.push(request));
		sidecar.emitExtensionUi("req-2");
		const no = { type: "extension_ui_response", id: "req-2", confirmed: false };
		expect(await pool.routeSideChannel("req-2", no, undefined, desktop.win)).toBe(true);
		expect(ui.at(-1)).toMatchObject({ id: "answered:req-2", method: "cancel", targetId: "req-2" });
		expect(() => view.sendSideChannel({ ...no, confirmed: true })).toThrow("[already_answered]");
		expect(sidecar.sentFrames).toEqual([yes, no]);
	});

	it("ends the device's view when the window closes the tab, before its omp goes", () => {
		const { pool, sidecar, view } = viewed();
		const ended = vi.fn(() => expect(sidecar.disposed).toBe(false));
		view.on(VIEW_ENDED_EVENT, ended);
		pool.releaseTab("tab-a");
		expect(ended).toHaveBeenCalledTimes(1);
		expect(sidecar.disposed).toBe(true);
	});
});
