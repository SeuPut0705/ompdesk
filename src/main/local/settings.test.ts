import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stockHelperRequest as stockHelperRequestImport } from "../stock-helper";
import { type BridgeProviderAccounts, handlers, mergeProviderAccounts, type StockLogoutAccount } from "./settings";
import type { LocalCommandContext } from "./types";

vi.mock("../stock-helper", () => ({ stockHelperRequest: vi.fn() }));
const stockHelperRequest = vi.mocked(stockHelperRequestImport);
beforeEach(() => stockHelperRequest.mockReset());

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

	it("passes each account's identity key and the pool provider through on an omp with account pools", () => {
		const usage: BridgeProviderAccounts = {
			providerId: "anthropic",
			credentialProvider: "anthropic",
			accounts: [
				{ credentialId: 7, state: "healthy", limits: [], identityKey: "email:work@example.com|org:org-1" },
				{ credentialId: 9, state: "healthy", limits: [], identityKey: null },
			],
		};
		const result = mergeProviderAccounts("anthropic", [work, home], usage);
		expect(result.credentialProvider).toBe("anthropic");
		expect(result.accounts.map(account => account.identityKey)).toEqual(["email:work@example.com|org:org-1", null]);
	});

	it("reports no identity keys on an omp without account pools, or when the bridge read failed", () => {
		const old = mergeProviderAccounts("anthropic", [work], { providerId: "anthropic", accounts: [] });
		expect(old.credentialProvider).toBeUndefined();
		expect("identityKey" in old.accounts[0]).toBe(false);
		const failed = mergeProviderAccounts("anthropic", [work], undefined, "boom");
		expect("identityKey" in failed.accounts[0]).toBe(false);
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
			accounts: [{ credentialId: 7, state: "healthy", limits: [], fetchedAt: 1_234 }],
		}));
		const result = await handlers.get_provider_accounts(
			{ type: "get_provider_accounts", providerId: "anthropic" },
			fakeCtx(send, request),
		);
		expect(send).toHaveBeenCalledWith({ type: "get_logout_accounts", providerId: "anthropic" });
		expect(request).toHaveBeenCalledWith("provider_accounts", { providerId: "anthropic", refresh: false });
		expect(result).toMatchObject({ accounts: [{ credentialId: 7, inUse: true, fetchedAt: 1_234 }] });
	});

	it("asks the bridge to refresh through stock's invalidate only when the renderer does", async () => {
		const send = vi.fn(async () => ({ accounts: [work] }));
		const request = vi.fn(async () => ({ providerId: "anthropic", accounts: [] }));
		await handlers.get_provider_accounts(
			{ type: "get_provider_accounts", providerId: "anthropic", refresh: true },
			fakeCtx(send, request),
		);
		expect(request).toHaveBeenLastCalledWith("provider_accounts", { providerId: "anthropic", refresh: true });
		await handlers.get_usage({ type: "get_usage", refresh: true }, fakeCtx(send, request));
		expect(request).toHaveBeenLastCalledWith("usage", { refresh: true });
		await handlers.get_usage({ type: "get_usage" }, fakeCtx(send, request));
		expect(request).toHaveBeenLastCalledWith("usage", { refresh: false });
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

describe("reset passes", () => {
	const passes = { count: 2, usableCount: 2, clears: ["5h"], early: false, creditId: "g1", redeemable: true };

	it("carries each account's reset passes through the merge", () => {
		const result = mergeProviderAccounts("anthropic", [work, home], {
			providerId: "anthropic",
			accounts: [{ credentialId: 9, state: "depleted", limits: [], resetPasses: passes }],
		});
		expect(result.accounts[0]).not.toHaveProperty("resetPasses");
		expect(result.accounts[1].resetPasses).toEqual(passes);
	});

	it("passes a redeem to the tab's bridge with the confirmed pass", async () => {
		const send = vi.fn();
		const outcome = { ok: true, code: "reset", message: "Reset applied" };
		const request = vi.fn(async () => outcome);
		const result = await handlers.redeem_reset_pass(
			{ type: "redeem_reset_pass", providerId: "anthropic", credentialId: 9, creditId: "g1" },
			fakeCtx(send, request),
		);
		expect(request).toHaveBeenCalledWith("reset_pass_redeem", {
			providerId: "anthropic",
			credentialId: 9,
			creditId: "g1",
		});
		expect(send).not.toHaveBeenCalled();
		expect(result).toEqual(outcome);
	});

	it("refuses a redeem without a credential before reaching omp", async () => {
		const request = vi.fn();
		await expect(
			handlers.redeem_reset_pass({ type: "redeem_reset_pass", providerId: "anthropic" }, fakeCtx(vi.fn(), request)),
		).rejects.toThrow();
		expect(request).not.toHaveBeenCalled();
	});
});

describe("login_cancel handler", () => {
	it("reaches the sign-in's loopback callback with a denial and the flow's state, as a provider's Deny does", async () => {
		const seen: string[] = [];
		const server = createServer((request, response) => {
			seen.push(request.url ?? "");
			// Stock's callback server answers a denial with its error page.
			response.writeHead(500).end();
		});
		await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
		try {
			const { port } = server.address() as AddressInfo;
			const redirect = encodeURIComponent(`http://127.0.0.1:${port}/callback`);
			await handlers.login_cancel(
				{
					type: "login_cancel",
					url: `https://claude.ai/oauth/authorize?redirect_uri=${redirect}&state=xyz&code=true`,
				},
				fakeCtx(vi.fn(), vi.fn()),
			);
			const [callback] = seen.map(url => new URL(url, "http://127.0.0.1"));
			expect(callback?.pathname).toBe("/callback");
			expect(Object.fromEntries(callback?.searchParams ?? [])).toEqual({
				error: "access_denied",
				error_description: "Sign-in cancelled in OMPdesk",
				state: "xyz",
			});
		} finally {
			server.close();
		}
	});

	it("refuses a sign-in without a loopback callback and never fetches it", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		try {
			const redirect = encodeURIComponent("vscode://gitlab.gitlab-workflow/authentication");
			await expect(
				handlers.login_cancel(
					{ type: "login_cancel", url: `https://gitlab.com/oauth/authorize?redirect_uri=${redirect}` },
					fakeCtx(vi.fn(), vi.fn()),
				),
			).rejects.toThrow("no loopback callback");
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});
});

describe("history handlers", () => {
	it("read through the stock helper, never the tab's omp, and keep the write in it", async () => {
		const send = vi.fn();
		const request = vi.fn(async () => ({ skipped: false }));
		const ctx = fakeCtx(send, request);
		stockHelperRequest.mockResolvedValue([{ prompt: "entry" }]);
		expect(
			await handlers.history_recent({ type: "history_recent", id: "gui-1", limit: 200, cwd: "/repo" }, ctx),
		).toEqual([{ prompt: "entry" }]);
		expect(stockHelperRequest).toHaveBeenLastCalledWith("history.recent", { limit: 200, cwd: "/repo" });
		await handlers.history_recent({ type: "history_recent", id: "gui-2", limit: 50 }, ctx);
		expect(stockHelperRequest).toHaveBeenLastCalledWith("history.recent", { limit: 50 });
		await handlers.history_search({ type: "history_search", id: "gui-3", query: "ship", limit: 20 }, ctx);
		expect(stockHelperRequest).toHaveBeenLastCalledWith("history.search", { query: "ship", limit: 20 });
		expect(request).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
		await handlers.history_record({ type: "history_record", prompt: "ship it", cwd: "/repo" }, ctx);
		expect(request).toHaveBeenCalledWith("history_record", {
			type: "history_record",
			prompt: "ship it",
			cwd: "/repo",
		});
	});

	it("refuse a malformed read instead of forwarding it", async () => {
		const ctx = fakeCtx(vi.fn(), vi.fn());
		await expect(handlers.history_search({ type: "history_search", limit: 5 }, ctx)).rejects.toThrow();
		await expect(handlers.history_recent({ type: "history_recent", limit: "many" }, ctx)).rejects.toThrow();
	});
});
