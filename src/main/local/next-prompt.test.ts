import { describe, expect, it, vi } from "vitest";
import { INLINE_MAX_DRAFT_CHARS } from "../../../resources/gui-bridge/next-prompt-contracts";
import { localHandlerFor } from "./index";
import { handlers } from "./next-prompt";
import type { LocalCommandContext } from "./types";

/** A context whose bridge answers every request with `answer` and records what was asked. */
function fakeCtx(answer: unknown = { ok: true }) {
	const request = vi.fn(async (_method: string, _params?: unknown) => answer);
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

function run(type: string, params: Record<string, unknown>, ctx: LocalCommandContext): Promise<unknown> {
	const handler = handlers[type];
	if (!handler) throw new Error(`no handler for ${type}`);
	return handler({ type, ...params }, ctx);
}

describe("prompt suggestion commands", () => {
	it("are served locally, one handler per command type", () => {
		for (const type of [
			"get_next_prompt",
			"set_next_prompt_draft",
			"refresh_next_prompt",
			"cancel_next_prompt",
			"complete_inline",
		]) {
			expect(localHandlerFor(type), type).toBe(handlers[type]);
		}
	});

	it("reads the state through bridge next_prompt_state and returns it untouched", async () => {
		const state = { suggestions: true, inline: true, legacyExtension: false, requests: { suggest: 0, inline: 0 } };
		const { ctx, request } = fakeCtx(state);
		await expect(run("get_next_prompt", {}, ctx)).resolves.toBe(state);
		expect(request).toHaveBeenCalledExactlyOnceWith("next_prompt_state");
	});

	it("maps the draft flag to next_prompt_draft and rejects anything but a boolean", async () => {
		const { ctx, request } = fakeCtx();
		await run("set_next_prompt_draft", { empty: false }, ctx);
		expect(request).toHaveBeenCalledExactlyOnceWith("next_prompt_draft", { empty: false });
		await expect(run("set_next_prompt_draft", { empty: "yes" }, ctx)).rejects.toThrow();
		await expect(run("set_next_prompt_draft", {}, ctx)).rejects.toThrow();
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("maps a refresh reason to next_prompt_refresh and rejects the reasons only the bridge raises", async () => {
		const { ctx, request } = fakeCtx();
		for (const reason of ["bash", "switch", "refresh"]) await run("refresh_next_prompt", { reason }, ctx);
		expect(request.mock.calls).toEqual([
			["next_prompt_refresh", { reason: "bash" }],
			["next_prompt_refresh", { reason: "switch" }],
			["next_prompt_refresh", { reason: "refresh" }],
		]);
		for (const reason of ["turn", "compaction", "", 3, undefined]) {
			await expect(run("refresh_next_prompt", { reason }, ctx)).rejects.toThrow();
		}
		expect(request).toHaveBeenCalledTimes(3);
	});

	it("maps a cancel scope to next_prompt_cancel and rejects an unknown scope", async () => {
		const { ctx, request } = fakeCtx();
		for (const scope of ["suggest", "inline", "all"]) await run("cancel_next_prompt", { scope }, ctx);
		expect(request.mock.calls).toEqual([
			["next_prompt_cancel", { scope: "suggest" }],
			["next_prompt_cancel", { scope: "inline" }],
			["next_prompt_cancel", { scope: "all" }],
		]);
		await expect(run("cancel_next_prompt", { scope: "everything" }, ctx)).rejects.toThrow();
		await expect(run("cancel_next_prompt", {}, ctx)).rejects.toThrow();
		expect(request).toHaveBeenCalledTimes(3);
	});

	it("sends an inline completion request as next_prompt_inline and returns the bridge's answer", async () => {
		const completion = { requestId: "r-1", text: " the tests" };
		const { ctx, request } = fakeCtx(completion);
		await expect(run("complete_inline", { draft: "please run", requestId: "r-1" }, ctx)).resolves.toBe(completion);
		expect(request).toHaveBeenCalledExactlyOnceWith("next_prompt_inline", { draft: "please run", requestId: "r-1" });
	});

	it("bounds the draft at twice the longest one the bridge sends, and the request id at 64 characters", async () => {
		const { ctx, request } = fakeCtx();
		const longest = "a".repeat(INLINE_MAX_DRAFT_CHARS * 2);
		await run("complete_inline", { draft: longest, requestId: "r".repeat(64) }, ctx);
		expect(request).toHaveBeenCalledTimes(1);
		await expect(run("complete_inline", { draft: `${longest}a`, requestId: "r-2" }, ctx)).rejects.toThrow();
		await expect(run("complete_inline", { draft: "please run", requestId: "r".repeat(65) }, ctx)).rejects.toThrow();
		await expect(run("complete_inline", { draft: "please run", requestId: "" }, ctx)).rejects.toThrow();
		await expect(run("complete_inline", { draft: 5, requestId: "r-3" }, ctx)).rejects.toThrow();
		await expect(run("complete_inline", { requestId: "r-4" }, ctx)).rejects.toThrow();
		expect(request).toHaveBeenCalledTimes(1);
	});
});
