import { describe, expect, it, vi } from "vitest";
import { handlers } from "./auto-title";
import { localHandlerFor } from "./index";
import type { LocalCommandContext } from "./types";

/** A context whose bridge answers every request with `answer` and records what was asked. */
function fakeCtx(answer: unknown = { title: "Fix login bug" }) {
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

describe("regenerate_session_title", () => {
	it("is served locally", () => {
		expect(localHandlerFor("regenerate_session_title")).toBe(handlers.regenerate_session_title);
	});

	it("asks the tab's own bridge to regenerate the title, and hands back what it answers", async () => {
		const { ctx, request } = fakeCtx({ title: "Fix login bug" });
		await expect(handlers.regenerate_session_title?.({ type: "regenerate_session_title" }, ctx)).resolves.toEqual({
			title: "Fix login bug",
		});
		expect(request).toHaveBeenCalledExactlyOnceWith("regenerate_title");
		expect(ctx.send).not.toHaveBeenCalled();
	});

	it("passes a 'no title' answer through unchanged so the editor can say why", async () => {
		const { ctx } = fakeCtx({ title: null, reason: "none" });
		await expect(handlers.regenerate_session_title?.({ type: "regenerate_session_title" }, ctx)).resolves.toEqual({
			title: null,
			reason: "none",
		});
	});
});
