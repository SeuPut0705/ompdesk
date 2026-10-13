import { describe, expect, it, vi } from "vitest";
import { handlers } from "./extensions";
import type { LocalCommandContext } from "./types";

function context(builtin: boolean) {
	const request = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
		const reply =
			method === "get_mcp_servers"
				? { servers: [{ name: "rea", ...(builtin ? { builtin: "rea" } : {}) }] }
				: { ok: true };
		return reply;
	});
	const ctx: LocalCommandContext = {
		cwd: "/tmp",
		omp: { bin: "omp", version: "18.8.7", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
		send: async <T>() => undefined as T,
		bridge: {
			request: async <T>(method: string, params?: unknown): Promise<T> => {
				// The controlled fixture above supplies the requested bridge method's shape.
				const reply = await request(method, params);
				return reply as T;
			},
			connected: true,
			onEvent: () => () => {},
		},
	};
	return { ctx, request };
}

describe("built-in MCP declarations", () => {
	it("refuses config mutations of the bundled declaration", async () => {
		const { ctx, request } = context(true);
		for (const action of ["disable", "remove", "reconnect"]) {
			await expect(handlers.mcp_action({ type: "mcp_action", name: "rea", action }, ctx)).rejects.toMatchObject({
				code: "invalid_params",
			});
		}
		expect(request.mock.calls.every(([method]) => method === "get_mcp_servers")).toBe(true);
	});
	it("leaves a user's own same-name server on stock's mutation path", async () => {
		const { ctx, request } = context(false);
		await expect(handlers.mcp_action({ type: "mcp_action", name: "rea", action: "disable" }, ctx)).resolves.toEqual({
			ok: true,
		});
		expect(request).toHaveBeenLastCalledWith("mcp_action", { name: "rea", action: "disable" });
	});
});
