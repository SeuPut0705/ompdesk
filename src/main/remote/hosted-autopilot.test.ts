import { describe, expect, it } from "vitest";
import type { RpcResponse } from "../../shared/rpc-types";
import type { SidecarLike } from "../sidecar-types";
import type { ClientWindow } from "../web/client-window";
import { hostedAutopilot } from "./hosted-autopilot";

function win(id: number): ClientWindow {
	return {
		webContents: { id, send: () => undefined },
		isDestroyed: () => false,
		once: () => undefined,
		removeListener: () => undefined,
	};
}

function sidecar(sessionFile?: string): SidecarLike {
	return {
		rpcClient: {
			command: async () => ({ type: "response", success: true, data: { sessionFile } }) as RpcResponse,
		},
	} as unknown as SidecarLike;
}

describe("hostedAutopilot", () => {
	const front = win(1);
	const owning = win(2);
	const deviceTab = sidecar();
	const runTab = sidecar("/host/sessions/run.jsonl");
	const windowTab = sidecar("/host/sessions/viewed.jsonl");
	const pool = {
		sessionOwner: (path: string) => (path === "/host/sessions/viewed.jsonl" ? { tabId: "win-tab", winId: 2 } : null),
		sidecarOf: (tabId: string) => (tabId === "run-tab" ? runTab : tabId === "win-tab" ? windowTab : null),
		windowOfTab: (tabId: string) => (tabId === "win-tab" ? owning : null),
	};

	function route(targetWindow: ClientWindow | null = front) {
		const calls: { win: ClientWindow; sidecar: SidecarLike; tabId: string; command: unknown }[] = [];
		const charged: [string, string, string | undefined][] = [];
		const handle = hostedAutopilot({
			pool,
			targetWindow: () => targetWindow,
			charge: (root, peer, session) => void charged.push([root, peer, session]),
			handle: async (w, s, tabId, command) => {
				calls.push({ win: w, sidecar: s, tabId, command });
				return {
					type: "response",
					command: command.type,
					success: true,
					data:
						command.type === "set_autopilot"
							? { active: true, tabId: "run-tab", root: "/wt/run" }
							: { active: true, root: "/wt/run" },
				} as RpcResponse;
			},
		});
		return { handle, calls, charged };
	}

	it("starts a run from the device's tab in this computer's front window, names its session and charges the device", async () => {
		const { handle, calls, charged } = route();
		const response = await handle(
			{ tabId: "peer:dev:t1", peer: "dev", sidecar: deviceTab, viewsWindow: false },
			{ type: "set_autopilot", action: "start" },
		);
		expect(calls).toEqual([
			{ win: front, sidecar: deviceTab, tabId: "peer:dev:t1", command: { type: "set_autopilot", action: "start" } },
		]);
		expect(response.data).toEqual({
			active: true,
			tabId: "run-tab",
			root: "/wt/run",
			sessionPath: "/host/sessions/run.jsonl",
		});
		// Its cycles spend this computer's models for the device: they count against the device until the run ends.
		expect(charged).toEqual([["/wt/run", "dev", "/host/sessions/run.jsonl"]]);
	});

	it("reads and stops a run the device views through the window tab that runs it, charging nothing new", async () => {
		const { handle, calls, charged } = route();
		const response = await handle(
			{
				tabId: "peer:dev:t2",
				peer: "dev",
				sidecar: deviceTab,
				sessionPath: "/host/sessions/viewed.jsonl",
				viewsWindow: true,
			},
			{ type: "set_autopilot", action: "stop" },
		);
		expect(response.success).toBe(true);
		expect(response.data).toEqual({ active: true, tabId: "run-tab", root: "/wt/run" });
		expect(calls[0]).toMatchObject({ win: owning, sidecar: windowTab, tabId: "win-tab" });
		expect(charged).toEqual([]);
	});

	it("refuses without a window here instead of starting a run nobody could open", async () => {
		const { handle, calls } = route(null);
		const response = await handle(
			{ tabId: "peer:dev:t1", peer: "dev", sidecar: deviceTab, viewsWindow: false },
			{ type: "get_autopilot" },
		);
		expect(response.success).toBe(false);
		expect(response).toMatchObject({ success: false, error: expect.stringMatching(/window/) });
		expect(calls).toEqual([]);
	});
});
