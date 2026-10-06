import { describe, expect, it, vi } from "vitest";
import type { ModelInfo, ProviderInfo, RpcResponse } from "../../../shared/rpc-types";
import type { TabRpc } from "../../lib/tab-rpc";
import { ensureServingDefault, readDefaultModelRole } from "./default-model";

function ok(data: unknown): RpcResponse {
	return { type: "response", command: "test", success: true, data };
}

function fakeRpc(defaultRole: string | undefined | Error) {
	const calls = {
		setModel: vi.fn(async (provider: string, id: string) => ok({ provider, id })),
		setModelRole: vi.fn(async (_role: string, _model: string | null) => ok({})),
		getModelRoles: vi.fn(async () => {
			if (defaultRole instanceof Error) throw defaultRole;
			return ok({ roles: [{ id: "smol" }, { id: "default", model: defaultRole }] });
		}),
	};
	// Only the three commands the default-model path sends are implemented.
	return { calls, rpc: calls as unknown as TabRpc };
}

const acme: ProviderInfo = {
	id: "acme",
	name: "acme",
	authenticated: true,
	loginAvailable: false,
	disabled: false,
	modelCount: 2,
};
const apple: ProviderInfo = {
	id: "apple",
	name: "apple",
	authenticated: false,
	loginAvailable: false,
	disabled: false,
	modelCount: 1,
};
const onDevice: ModelInfo = { provider: "apple", id: "on-device", contextWindow: 8_192 };
const opus: ModelInfo = { provider: "acme", id: "acme-opus-5", name: "Acme Opus 5" };

describe("ensureServingDefault", () => {
	it("moves a session that started on the on-device model to the connected provider and pins it", async () => {
		const { calls, rpc } = fakeRpc(undefined);
		const outcome = await ensureServingDefault(rpc, null, {
			providers: [acme, apple],
			configs: [],
			models: [onDevice, opus],
			current: onDevice,
		});
		expect(outcome).toMatchObject({ kind: "switched", model: opus, from: onDevice });
		expect(calls.setModel).toHaveBeenCalledWith("acme", "acme-opus-5");
		expect(calls.setModelRole).toHaveBeenCalledWith("default", "acme/acme-opus-5");
	});

	it("pins a live model that can serve so the next launch cannot flip", async () => {
		const { calls, rpc } = fakeRpc(undefined);
		const outcome = await ensureServingDefault(rpc, null, {
			providers: [acme, apple],
			configs: [],
			models: [onDevice, opus],
			current: opus,
		});
		expect(outcome.kind).toBe("kept");
		expect(calls.setModel).not.toHaveBeenCalled();
		expect(calls.setModelRole).toHaveBeenCalledWith("default", "acme/acme-opus-5");
	});

	it("never overrides a default the user saved, even a small one", async () => {
		const { calls, rpc } = fakeRpc("apple/on-device");
		const outcome = await ensureServingDefault(rpc, null, {
			providers: [acme, apple],
			configs: [],
			models: [onDevice, opus],
			current: onDevice,
		});
		expect(outcome.kind).toBe("unchanged");
		expect(calls.setModel).not.toHaveBeenCalled();
		expect(calls.setModelRole).not.toHaveBeenCalled();
	});

	it("does nothing when the saved default cannot be read or nothing can serve", async () => {
		const unreadable = fakeRpc(new Error("unsupported_omp"));
		expect(
			await ensureServingDefault(unreadable.rpc, null, {
				providers: [acme],
				configs: [],
				models: [opus],
				current: null,
			}),
		).toEqual({ kind: "unchanged" });
		const keylessOnly = fakeRpc(undefined);
		expect(
			await ensureServingDefault(keylessOnly.rpc, null, {
				providers: [apple],
				configs: [],
				models: [onDevice],
				current: onDevice,
			}),
		).toEqual({ kind: "unchanged" });
		expect(keylessOnly.calls.setModelRole).not.toHaveBeenCalled();
	});
});

describe("readDefaultModelRole", () => {
	it("distinguishes unset from unreadable", async () => {
		expect(await readDefaultModelRole(fakeRpc(undefined).rpc)).toBeNull();
		expect(await readDefaultModelRole(fakeRpc("acme/acme-opus-5").rpc)).toBe("acme/acme-opus-5");
		expect(await readDefaultModelRole(fakeRpc(new Error("boom")).rpc)).toBeUndefined();
	});
});
