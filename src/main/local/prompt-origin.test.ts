import { describe, expect, it, vi } from "vitest";
import { localHandlerFor } from "./index";
import { handlers } from "./prompt-origin";
import type { LocalCommandContext } from "./types";

function fakeCtx() {
	const request = vi.fn(async (_method: string, _params?: unknown) => ({ pending: 1 }));
	const ctx: LocalCommandContext = {
		cwd: "/repo",
		omp: { bin: "omp", version: "18.8.0", run: vi.fn() },
		send: vi.fn(async () => {
			throw new Error("stock must not be asked");
		}),
		bridge: {
			request: request as LocalCommandContext["bridge"]["request"],
			onEvent: vi.fn(() => () => {}),
			connected: true,
		},
	};
	return { ctx, request };
}

describe("prompt_origin_set", () => {
	const set = handlers.prompt_origin_set;
	if (!set) throw new Error("no prompt_origin_set handler");

	it("is served locally and hands the device and the text to the bridge", async () => {
		expect(localHandlerFor("prompt_origin_set")).toBe(set);
		const { ctx, request } = fakeCtx();
		const origin = { deviceId: "dev-1", name: "iPhone" };
		await expect(set({ type: "prompt_origin_set", origin, text: "hello" }, ctx)).resolves.toEqual({ pending: 1 });
		expect(request).toHaveBeenCalledExactlyOnceWith("prompt_origin_set", { origin, text: "hello" });
	});

	it("refuses a command that names no device or no text, before the bridge hears of it", async () => {
		const { ctx, request } = fakeCtx();
		await expect(set({ type: "prompt_origin_set", text: "hello" }, ctx)).rejects.toThrow();
		await expect(
			set({ type: "prompt_origin_set", origin: { deviceId: "", name: "iPhone" }, text: "hello" }, ctx),
		).rejects.toThrow();
		await expect(
			set({ type: "prompt_origin_set", origin: { deviceId: "d", name: "iPhone" } }, ctx),
		).rejects.toThrow();
		expect(request).not.toHaveBeenCalled();
	});
});
