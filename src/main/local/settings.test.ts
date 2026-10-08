import { describe, expect, it, vi } from "vitest";
import { type BridgeProviderAccounts, handlers, mergeProviderAccounts, type StockLogoutAccount } from "./settings";
import type { LocalCommandContext } from "./types";

const work: StockLogoutAccount = {
	credentialId: 7,
	label: "work@example.com",
	detail: "oauth #7",
	type: "oauth",
	active: true,
};
const home: StockLogoutAccount = {
	credentialId: 9,
	label: "home@example.com",
	detail: "oauth #9",
	type: "oauth",
	active: false,
};
const fiveHour = { id: "5h", label: "5 Hour", usedFraction: 0.4, windowLabel: "5h", resetsAt: 1_000 };

type Fake = (...args: never[]) => Promise<unknown>;

/** The handlers only await `send`/`request`; vi mocks stand in for their generic signatures. */
function fakeCtx(send: Fake, request: Fake): LocalCommandContext {
	return {
		cwd: "/repo",
		omp: { bin: "omp", version: "18.8.0", run: vi.fn() },
		send: send as LocalCommandContext["send"],
		bridge: {
			request: request as LocalCommandContext["bridge"]["request"],
			onEvent: vi.fn(() => () => {}),
			connected: true,
		},
		emit: vi.fn(),
	};
}

describe("mergeProviderAccounts", () => {
	it("joins stock accounts with per-account quota by credentialId", () => {
		const usage: BridgeProviderAccounts = {
			providerId: "anthropic",
			pinnedCredentialId: 9,
			accounts: [
				{ credentialId: 9, state: "healthy", remainingFraction: 0.6, limits: [fiveHour] },
				{ credentialId: 7, state: "depleted", resetsAt: 5_000, limits: [] },
			],
		};
		expect(mergeProviderAccounts("anthropic", [work, home], usage)).toEqual({
			providerId: "anthropic",
			accounts: [
				{
					credentialId: 7,
					label: "work@example.com",
					detail: "oauth #7",
					type: "oauth",
					inUse: false,
					state: "depleted",
					limitedUntil: 5_000,
					limits: [],
				},
				{
					credentialId: 9,
					label: "home@example.com",
					detail: "oauth #9",
					type: "oauth",
					inUse: true,
					state: "healthy",
					remainingFraction: 0.6,
					limits: [fiveHour],
				},
			],
		});
	});

	it("marks nothing in use without a session pin, even where stock calls an account active", () => {
		const result = mergeProviderAccounts("anthropic", [work], { providerId: "anthropic", accounts: [] });
		expect(result.accounts[0]).toMatchObject({ inUse: false, state: "unknown", limits: [] });
	});

	it("lists the accounts when the quota read failed", () => {
		const result = mergeProviderAccounts("anthropic", [work, home], undefined, "unsupported_omp");
		expect(result.usageError).toBe("unsupported_omp");
		expect(result.accounts.map(account => account.credentialId)).toEqual([7, 9]);
	});
});

describe("logout handler", () => {
	it("removes one credential through stock logout", async () => {
		const send = vi.fn(async () => ({}));
		const request = vi.fn(async () => ({}));
		await handlers.logout({ type: "logout", providerId: "anthropic", credentialId: 7 }, fakeCtx(send, request));
		expect(send).toHaveBeenCalledWith({ type: "logout", providerId: "anthropic", credentialId: 7 });
		expect(request).not.toHaveBeenCalled();
	});

	it("disconnects the whole provider only when asked explicitly", async () => {
		const send = vi.fn(async () => ({}));
		const request = vi.fn(async () => ({ providerId: "anthropic" }));
		await handlers.logout({ type: "logout", providerId: "anthropic", all: true }, fakeCtx(send, request));
		expect(request).toHaveBeenCalledWith("provider_logout", { providerId: "anthropic" });
		expect(send).not.toHaveBeenCalled();
	});

	it("refuses a logout that names no credential", async () => {
		const send = vi.fn(async () => ({}));
		const request = vi.fn(async () => ({}));
		await expect(
			handlers.logout({ type: "logout", providerId: "anthropic" }, fakeCtx(send, request)),
		).rejects.toThrow();
		expect(send).not.toHaveBeenCalled();
		expect(request).not.toHaveBeenCalled();
	});
});

describe("get_provider_accounts handler", () => {
	it("asks stock for the accounts and the bridge for their quota", async () => {
		const send = vi.fn(async () => ({ accounts: [work] }));
		const request = vi.fn(async () => ({
			providerId: "anthropic",
			pinnedCredentialId: 7,
			accounts: [{ credentialId: 7, state: "healthy", limits: [] }],
		}));
		const result = await handlers.get_provider_accounts(
			{ type: "get_provider_accounts", providerId: "anthropic" },
			fakeCtx(send, request),
		);
		expect(send).toHaveBeenCalledWith({ type: "get_logout_accounts", providerId: "anthropic" });
		expect(request).toHaveBeenCalledWith("provider_accounts", { providerId: "anthropic" });
		expect(result).toMatchObject({ accounts: [{ credentialId: 7, inUse: true }] });
	});

	it("keeps the stock list when the bridge cannot read quotas", async () => {
		const send = vi.fn(async () => ({ accounts: [work] }));
		const request = vi.fn(async () => {
			throw new Error("usage fetch aborted");
		});
		const result = await handlers.get_provider_accounts(
			{ type: "get_provider_accounts", providerId: "anthropic" },
			fakeCtx(send, request),
		);
		expect(result).toMatchObject({
			usageError: "usage fetch aborted",
			accounts: [{ credentialId: 7, inUse: false }],
		});
	});
});
