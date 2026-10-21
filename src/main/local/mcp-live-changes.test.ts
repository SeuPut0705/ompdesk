import { afterEach, describe, expect, it } from "vitest";
import type { McpLiveChange } from "../../../resources/gui-bridge/extensions/mcp-contracts";
import { onMcpChange } from "../mcp-live";
import { handlers } from "./extensions";
import type { LocalCommandContext } from "./types";

/** A session whose bridge answers each MCP method with `replies[method]`, or throws it when it is an Error. */
function session(replies: Record<string, unknown>): LocalCommandContext {
	return {
		cwd: "/tmp",
		omp: { bin: "omp", version: "18.12.5", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
		send: async <T>() => undefined as T,
		bridge: {
			request: async <T>(method: string): Promise<T> => {
				const reply = replies[method] ?? { servers: [] };
				if (reply instanceof Error) throw reply;
				return reply as T;
			},
			connected: true,
			onEvent: () => () => {},
		},
	};
}

const changes: McpLiveChange[] = [];
onMcpChange(change => changes.push(change));
afterEach(() => {
	changes.length = 0;
});

describe("an MCP change one session makes reaches the others", () => {
	it("after an add, an adopt or a toggle of that server, and after a reload of all of them", async () => {
		const ctx = session({ mcp_add: { added: true }, mcp_action: { ok: true }, mcp_reload: { servers: [] } });
		await handlers.mcp_add({ type: "mcp_add", name: "higgsfield", config: { transport: "http" } }, ctx);
		await handlers.mcp_action({ type: "mcp_action", name: "docs", action: "adopt" }, ctx);
		await handlers.mcp_reload({ type: "mcp_reload" }, ctx);
		expect(changes).toEqual([{ names: ["higgsfield"] }, { names: ["docs"] }, { names: [], all: true }]);
	});

	it("after a sign-in that succeeded, never after one cancelled, failed or busy", async () => {
		await handlers.mcp_reauth({ type: "mcp_reauth", name: "mobbin" }, session({ mcp_reauth: { ok: true } }));
		await handlers.mcp_reauth(
			{ type: "mcp_reauth", name: "mobbin" },
			session({ mcp_reauth: { ok: false, error: "cancelled" } }),
		);
		await expect(
			handlers.mcp_reauth({ type: "mcp_reauth", name: "mobbin" }, session({ mcp_reauth: { busy: "other" } })),
		).rejects.toMatchObject({ code: "oauth_busy" });
		expect(changes).toEqual([{ names: ["mobbin"] }]);
	});

	it("not when the change failed", async () => {
		await expect(
			handlers.mcp_add(
				{ type: "mcp_add", name: "x", config: { transport: "http" } },
				session({ mcp_add: new Error('Server "x" already exists') }),
			),
		).rejects.toThrow("already exists");
		expect(changes).toEqual([]);
	});
});
