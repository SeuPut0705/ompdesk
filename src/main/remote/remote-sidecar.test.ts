import { describe, expect, it } from "vitest";
import { ipcErrorCode } from "../../shared/ipc-error-codes";
import type { RemoteLinkState } from "../../shared/ipc-types";
import type { RpcResponse, SidecarStatusPayload } from "../../shared/rpc-types";
import type { BridgeConnectResult } from "../bridge-health";
import type { TabEventMessage, TabStatusArg } from "./app-protocol";
import { type RemoteLink, RemoteSidecar } from "./remote-sidecar";

interface SentRequest {
	method: string;
	params: Record<string, unknown>;
	timeoutMs: number | undefined;
}

/** A RemoteClient stand-in: records requests, answers from per-method handlers, refuses while not online. */
class FakeLink implements RemoteLink {
	readonly deviceId = "host-b";
	state: RemoteLinkState = "online";
	readonly sent: SentRequest[] = [];
	attached = false;
	readonly handlers: Record<string, (params: Record<string, unknown>) => unknown> = {
		"tab.open": params => ({ cwd: `/canonical${String(params.cwd)}`, kind: "agent", attached: this.attached }),
		"tab.command": (): RpcResponse => ({ type: "response", command: "get_state", success: true, data: { ok: 1 } }),
	};

	async request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
		if (this.state !== "online") throw Object.assign(new Error("host-b is offline"), { code: "remote_offline" });
		const record = params as Record<string, unknown>;
		this.sent.push({ method, params: record, timeoutMs });
		return (this.handlers[method]?.(record) ?? null) as T;
	}

	methods(): string[] {
		return this.sent.map(request => request.method);
	}
}

function hostStatus(status: TabStatusArg["status"], extra: Partial<TabStatusArg> = {}): TabEventMessage {
	return {
		rtab: "tab-1",
		name: "status",
		arg: {
			status,
			statusPayload: {},
			processAlive: status === "ready",
			cwd: "/canonical/p",
			kind: "agent",
			...extra,
		},
	};
}

function setup(): { link: FakeLink; sidecar: RemoteSidecar; statuses: SidecarStatusPayload[]; disposed: number[] } {
	const link = new FakeLink();
	const disposed: number[] = [];
	const sidecar = new RemoteSidecar({
		link,
		rtab: "tab-1",
		cwd: "/p",
		kind: "agent",
		fresh: true,
		offlineMessage: () => "Device offline",
		onDispose: () => disposed.push(1),
	});
	const statuses: SidecarStatusPayload[] = [];
	sidecar.on("status", (payload: SidecarStatusPayload) => statuses.push(payload));
	return { link, sidecar, statuses, disposed };
}

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("RemoteSidecar", () => {
	it("opens and starts the tab on the host, then re-emits the host's events verbatim", async () => {
		const { link, sidecar, statuses } = setup();
		expect(sidecar.status).toBe("asleep");
		expect(sidecar.rpcClient).toBeNull();
		expect(sidecar.device).toBe("host-b");

		sidecar.start();
		expect(sidecar.status).toBe("starting");
		await settle();
		expect(link.methods()).toEqual(["tab.open", "tab.start"]);
		expect(link.sent[0]?.params).toEqual({ rtab: "tab-1", cwd: "/p", kind: "agent", fresh: true });
		// The host's canonical cwd wins.
		expect(sidecar.cwd).toBe("/canonical/p");

		sidecar.handleEvent(hostStatus("ready", { statusPayload: { modelFallback: "x/y" } }));
		expect(sidecar.status).toBe("ready");
		expect(sidecar.processAlive).toBe(true);
		expect(statuses.at(-1)).toEqual({ status: "ready", cwd: "/canonical/p", modelFallback: "x/y" });

		const events: unknown[] = [];
		sidecar.on("events", (batch: unknown) => events.push(batch));
		sidecar.on("extensionUi", (request: unknown) => events.push(request));
		sidecar.on("hostToolCall", (request: unknown) => events.push(request));
		const batch = [{ type: "agent_start" }];
		sidecar.handleEvent({ rtab: "tab-1", name: "events", arg: batch });
		sidecar.handleEvent({ rtab: "tab-1", name: "extensionUi", arg: { id: "ui-1", method: "confirm" } });
		sidecar.handleEvent({ rtab: "tab-1", name: "hostToolCall", arg: { id: "ht-1", toolName: "gui_notify" } });
		expect(events).toEqual([batch, { id: "ui-1", method: "confirm" }, { id: "ht-1", toolName: "gui_notify" }]);

		const bridges: BridgeConnectResult[] = [];
		sidecar.on("bridge", (result: BridgeConnectResult) => bridges.push(result));
		sidecar.handleEvent({
			rtab: "tab-1",
			name: "bridge",
			arg: { connected: true, ompVersion: "19.0.0", unavailable: [{ feature: "mcp" }] },
		});
		const bridge = bridges[0];
		if (!bridge?.connected) throw new Error("expected a connected bridge result");
		// The capabilities probe is answered from what the host already learned.
		expect(await bridge.bridge.request("capabilities")).toEqual({
			ompVersion: "19.0.0",
			unavailable: [{ feature: "mcp" }],
		});
	});

	it("forwards commands, side-channel frames and lifecycle calls to its rtab on the host", async () => {
		const { link, sidecar } = setup();
		sidecar.start();
		await settle();
		sidecar.handleEvent(hostStatus("ready"));

		const response = await sidecar.rpcClient?.command({ type: "get_state" }, 20_000);
		expect(response).toMatchObject({ success: true, data: { ok: 1 } });
		const command = link.sent.find(request => request.method === "tab.command");
		expect(command?.params).toEqual({ rtab: "tab-1", command: { type: "get_state" }, timeoutMs: 20_000 });
		// The link waits for the host's own timeout plus the round trip.
		expect(command?.timeoutMs).toBeGreaterThan(20_000);

		sidecar.sendSideChannel({ type: "host_tool_result", id: "ht-1" });
		sidecar.syncImageGeneration();
		// The host's own reply-language setting applies: nothing goes over the link.
		sidecar.syncReplyLanguage();
		expect(sidecar.adoptCwd("/canonical/p")).toBe(false);
		expect(sidecar.adoptCwd("/elsewhere")).toBe(true);
		sidecar.restart(undefined, "/s/next.jsonl");
		await settle();
		expect(link.sent.slice(-4).map(request => [request.method, request.params])).toEqual([
			["tab.sideChannel", { rtab: "tab-1", frame: { type: "host_tool_result", id: "ht-1" } }],
			["tab.syncImageGeneration", { rtab: "tab-1" }],
			["tab.adoptCwd", { rtab: "tab-1", cwd: "/elsewhere" }],
			["tab.restart", { rtab: "tab-1", sessionPath: "/s/next.jsonl" }],
		]);
	});

	it("goes to error with the offline message and refuses commands while the link is down", async () => {
		const { link, sidecar, statuses } = setup();
		sidecar.start();
		await settle();
		sidecar.handleEvent(hostStatus("ready"));
		sidecar.handleEvent({ rtab: "tab-1", name: "session", arg: { sessionId: "s1", sessionFile: "/s/one.jsonl" } });

		link.state = "offline";
		sidecar.linkStateChanged("offline");
		expect(sidecar.status).toBe("error");
		expect(sidecar.offline).toBe(true);
		expect(sidecar.processAlive).toBe(false);
		expect(statuses.at(-1)).toEqual({ status: "error", cwd: "/canonical/p", message: "Device offline" });
		// Flapping between connecting and offline during backoff reports once.
		sidecar.linkStateChanged("connecting");
		sidecar.linkStateChanged("offline");
		expect(statuses.filter(status => status.message === "Device offline")).toHaveLength(1);

		const refused = await sidecar.rpcClient?.command({ type: "get_state" }).catch((error: unknown) => error);
		expect(ipcErrorCode(refused)).toBe("remote_offline");
		const sentBefore = link.sent.length;
		sidecar.sendSideChannel({ type: "extension_ui_response", id: "x" });
		expect(link.sent).toHaveLength(sentBefore);
	});

	it("resumes when the link returns: re-attaches a running host tab, or restarts on the newest session", async () => {
		const { link, sidecar } = setup();
		sidecar.start();
		await settle();
		sidecar.handleEvent(hostStatus("ready"));
		sidecar.handleEvent({ rtab: "tab-1", name: "session", arg: { sessionId: "s1", sessionFile: "/s/one.jsonl" } });

		// Within the host's grace period: re-attach, no new start.
		link.state = "offline";
		sidecar.linkStateChanged("offline");
		link.state = "online";
		link.attached = true;
		const before = link.sent.length;
		sidecar.linkStateChanged("online");
		expect(sidecar.status).toBe("starting");
		await settle();
		expect(link.sent.slice(before).map(request => request.method)).toEqual(["tab.open"]);
		expect(link.sent[before]?.params).toMatchObject({ sessionPath: "/s/one.jsonl" });
		sidecar.handleEvent(hostStatus("ready"));
		expect(sidecar.status).toBe("ready");
		expect(sidecar.offline).toBe(false);

		// After the grace period the host forgot the tab: open + start resume the session file.
		link.state = "offline";
		sidecar.linkStateChanged("offline");
		link.state = "online";
		link.attached = false;
		const later = link.sent.length;
		sidecar.linkStateChanged("online");
		await settle();
		expect(link.sent.slice(later).map(request => request.method)).toEqual(["tab.open", "tab.start"]);
	});

	it("never brings up a tab nobody started, and closes its host tab on dispose", async () => {
		const { link, sidecar, disposed } = setup();
		link.state = "offline";
		sidecar.linkStateChanged("offline");
		link.state = "online";
		sidecar.linkStateChanged("online");
		await settle();
		expect(sidecar.status).toBe("asleep");
		expect(link.sent).toEqual([]);

		sidecar.start();
		await settle();
		sidecar.dispose();
		expect(link.methods().at(-1)).toBe("tab.close");
		expect(disposed).toEqual([1]);
		sidecar.dispose();
		expect(disposed).toEqual([1]);
	});
});
