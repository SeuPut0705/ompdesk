import { describe, expect, it, vi } from "vitest";
import { localHandlerFor } from "./index";
import { handlers, noteTypedPrompt } from "./prompt-origin";
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

describe("noteTypedPrompt", () => {
	const client = () => {
		const command = vi.fn(async (_command: unknown) => ({}));
		return { client: { command }, command };
	};

	it("names a person's steer as one, a prompt or follow-up as none", async () => {
		const { client: c, command } = client();
		await noteTypedPrompt(c, { type: "steer", message: "how far?" });
		await noteTypedPrompt(c, { type: "prompt", message: "join", streamingBehavior: "steer" });
		await noteTypedPrompt(c, { type: "prompt", message: "later", streamingBehavior: "followUp" });
		await noteTypedPrompt(c, { type: "follow_up", message: "after" });
		await noteTypedPrompt(c, { type: "prompt", message: "fresh" });
		expect(command.mock.calls.map(([sent]) => sent)).toEqual([
			{ type: "typed_prompt", text: "how far?", steer: true },
			{ type: "typed_prompt", text: "join", steer: true },
			{ type: "typed_prompt", text: "later", steer: false },
			{ type: "typed_prompt", text: "after", steer: false },
			{ type: "typed_prompt", text: "fresh", steer: false },
		]);
	});

	it("says nothing for an agent's wrapped message, a retry or a command without text", async () => {
		const { client: c, command } = client();
		await noteTypedPrompt(c, {
			type: "steer",
			message: '<ompdesk-agent-message from="worker">\nstatus?\n</ompdesk-agent-message>',
		});
		await noteTypedPrompt(c, { type: "abort_and_prompt", message: "again" });
		await noteTypedPrompt(c, { type: "get_state" });
		expect(command).not.toHaveBeenCalled();
	});

	it("waits for a slow bridge no longer than its bound and swallows a refusal", async () => {
		vi.useFakeTimers();
		try {
			const never = vi.fn(() => new Promise<never>(() => {}));
			const slow = noteTypedPrompt({ command: never }, { type: "steer", message: "x" });
			await vi.advanceTimersByTimeAsync(600);
			await expect(slow).resolves.toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
		const refusing = vi.fn(async () => {
			throw new Error("Unknown bridge method: typed_prompt");
		});
		await expect(noteTypedPrompt({ command: refusing }, { type: "steer", message: "x" })).resolves.toBeUndefined();
	});
});
