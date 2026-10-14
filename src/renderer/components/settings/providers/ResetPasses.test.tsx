import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureProviderOptions } from "../../../../../e2e/models-config-fixture";
import type {
	ProviderAccount,
	ProviderInfo,
	ProvidersResult,
	ResetPasses,
	RpcResponse,
	UsageReport,
} from "../../../../shared/rpc-types";
import { I18nProvider, translate } from "../../../lib/i18n";
import { useModelStore } from "../../../stores/model";
import { useSessionStore } from "../../../stores/session";
import { useToastStore } from "../../../stores/toast";
import { routeCommands } from "../../../test-support/route-commands";
import { UsageQuotas } from "../../insights/UsageQuotas";
import { ProvidersSection } from "./ProvidersSection";
import { resetPassSummary } from "./ResetPasses";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
});
const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};

const claude: ProviderInfo = {
	id: "anthropic",
	name: "Anthropic",
	authenticated: true,
	authKind: "oauth",
	loginAvailable: true,
	disabled: false,
	modelCount: 3,
};
const expiresAt = new Date(2026, 9, 12, 9, 0).getTime();
const usable: ResetPasses = {
	count: 2,
	usableCount: 2,
	expiresAt,
	title: "One free rate limit reset",
	clears: ["anthropic:5h"],
	early: false,
	creditId: "grant-1",
	redeemable: true,
};
const limited: ProviderAccount = {
	credentialId: 9,
	label: "home@example.com",
	detail: "oauth #9",
	type: "oauth",
	inUse: false,
	state: "depleted",
	limits: [{ id: "anthropic:5h", label: "5h", usedFraction: 1 }],
	resetPasses: usable,
};
const healthy: ProviderAccount = {
	credentialId: 7,
	label: "work@example.com",
	detail: "oauth #7",
	type: "oauth",
	inUse: true,
	state: "healthy",
	limits: [{ id: "anthropic:5h", label: "5h", usedFraction: 0.3 }],
	resetPasses: { count: 1, usableCount: 1, clears: ["anthropic:5h"], early: false, redeemable: false },
};

const ok = (command: string, data?: unknown): RpcResponse => ({ type: "response", command, success: true, data });
const snapshot: ProvidersResult = {
	providers: [claude],
	models: [],
	discoveryStates: [],
	refreshPending: false,
	generation: 1,
};
const getProviders = vi.fn(async () => ok("get_providers", snapshot));
const getProviderAccounts = vi.fn(async (): Promise<RpcResponse> => ok("get_provider_accounts"));
const redeemResetPass = vi.fn(async (): Promise<RpcResponse> => ok("redeem_reset_pass"));
const getUsage = vi.fn(async (): Promise<RpcResponse> => ok("get_usage"));

Object.assign(window as unknown as Record<string, unknown>, {
	omp: {
		rpc: routeCommands({ getProviders, getProviderAccounts, redeemResetPass, getUsage }),
		models: { listProviders: vi.fn(async () => ({ providers: [], options: fixtureProviderOptions })) },
		ui: { respondExtensionUi: vi.fn() },
		system: { openExternal: vi.fn(async () => {}) },
		accountRotation: { get: vi.fn(async () => ({ mode: "quota", evenSupported: true })), set: vi.fn() },
	},
});

const text = () => document.body.textContent ?? "";
function button(name: string): HTMLButtonElement | undefined {
	return Array.from(document.body.querySelectorAll("button")).find(
		candidate => (candidate.textContent ?? "").trim() === name || candidate.getAttribute("aria-label") === name,
	) as HTMLButtonElement | undefined;
}
const toasts = () => useToastStore.getState().toasts;

/** Lets pending promise continuations and timers run. */
function tick(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, 0);
	return promise;
}

const roots: Root[] = [];
async function mount(element: ReactElement): Promise<void> {
	const root = createRoot(document.body as unknown as Element);
	await act(async () => root.render(<I18nProvider>{element}</I18nProvider>));
	await act(tick);
	roots.push(root);
}

async function mountAccounts(...lists: ProviderAccount[][]): Promise<void> {
	for (const list of lists) {
		getProviderAccounts.mockResolvedValueOnce(
			ok("get_provider_accounts", { providerId: "anthropic", accounts: list }),
		);
	}
	useSessionStore.setState({ status: "ready" });
	await mount(<ProvidersSection />);
	const toggle = Array.from(document.body.querySelectorAll("button[aria-expanded]")).find(
		candidate => (candidate.textContent ?? "").trim() === "Anthropic",
	) as HTMLButtonElement | undefined;
	await act(async () => toggle?.click());
}

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots.length = 0;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useModelStore.getState().reset();
	useSessionStore.getState().reset();
	useToastStore.setState({ toasts: [] });
	getProviderAccounts.mockReset();
	redeemResetPass.mockReset();
	getUsage.mockReset();
});

describe("reset pass badge", () => {
	it("names the count, what is usable now and the soonest expiry", () => {
		expect(resetPassSummary(usable, translate)).toBe(
			`${translate("resetPasses.count", { count: 2 })} · ${translate("resetPasses.expires", { date: "10/12" })}`,
		);
		expect(resetPassSummary({ ...usable, count: 1, usableCount: 0, expiresAt: undefined }, translate)).toBe(
			`${translate("resetPasses.countOne")} · ${translate("resetPasses.usableNow", { count: 0 })}`,
		);
	});
});

describe("reset passes on provider accounts", () => {
	it("shows each account's passes and holds the action while stock says it is unavailable", async () => {
		await mountAccounts([healthy, limited]);
		expect(text()).toContain(resetPassSummary(usable, translate));
		expect(text()).toContain(translate("resetPasses.countOne"));
		expect(text()).toContain(
			translate("resetPasses.unavailable", { reason: translate("resetPasses.unavailableUnknown") }),
		);
		expect(button(translate("resetPasses.useFor", { account: "work@example.com" }))?.disabled).toBe(true);
		expect(button(translate("resetPasses.useFor", { account: "home@example.com" }))?.disabled).toBe(false);
	});

	it("explains the spend, redeems only after confirming, and shows the refreshed quota", async () => {
		const refreshed: ProviderAccount = {
			...limited,
			state: "healthy",
			limits: [{ id: "anthropic:5h", label: "5h", usedFraction: 0 }],
			resetPasses: { ...usable, count: 1, usableCount: 1, redeemable: false },
		};
		await mountAccounts([healthy, limited], [healthy, refreshed]);
		redeemResetPass.mockResolvedValueOnce(ok("redeem_reset_pass", { ok: true, code: "reset", message: "Reset" }));

		await act(async () => button(translate("resetPasses.useFor", { account: "home@example.com" }))?.click());
		expect(redeemResetPass).not.toHaveBeenCalled();
		const body = text();
		expect(body).toContain(
			translate("resetPasses.confirmSpend", { account: "home@example.com", provider: "Anthropic", count: 2 }),
		);
		expect(body).toContain(translate("resetPasses.confirmResets", { windows: translate("resetPasses.window.5h") }));
		expect(body).toContain(translate("resetPasses.confirmPass", { title: "One free rate limit reset" }));
		expect(body).toContain(translate("resetPasses.autoRedeem"));
		expect(body).toContain(translate("resetPasses.confirmWarning"));

		const confirm = Array.from(document.body.querySelectorAll('[role="dialog"] button')).find(
			candidate => (candidate.textContent ?? "").trim() === translate("resetPasses.use"),
		) as HTMLButtonElement | undefined;
		await act(async () => confirm?.click());
		await act(tick);

		expect(redeemResetPass).toHaveBeenCalledWith("anthropic", 9, "grant-1");
		expect(getProviderAccounts).toHaveBeenCalledTimes(2);
		expect(toasts().at(-1)).toMatchObject({
			variant: "success",
			title: translate("resetPasses.done", { account: "home@example.com" }),
			message: translate("resetPasses.doneQuota", {
				quota: translate("providers.accounts.windowLeft", { window: translate("usage.limit.5h"), percent: 100 }),
			}),
		});
		expect(text()).toContain(
			translate("providers.accounts.windowLeft", { window: translate("usage.limit.5h"), percent: 100 }),
		);
	});

	it("reports a refusal through an error toast without refreshing as if it had worked", async () => {
		await mountAccounts([limited]);
		redeemResetPass.mockResolvedValueOnce(
			ok("redeem_reset_pass", { ok: false, code: "offer_changed", message: "changed" }),
		);
		await act(async () => button(translate("resetPasses.useFor", { account: "home@example.com" }))?.click());
		const confirm = Array.from(document.body.querySelectorAll('[role="dialog"] button')).find(
			candidate => (candidate.textContent ?? "").trim() === translate("resetPasses.use"),
		) as HTMLButtonElement | undefined;
		await act(async () => confirm?.click());

		expect(getProviderAccounts).toHaveBeenCalledTimes(1);
		expect(toasts().at(-1)).toMatchObject({
			variant: "warning",
			title: translate("resetPasses.failed"),
			detail: translate("resetPasses.outcome.offerChanged"),
		});
	});
});

describe("reset passes on the Usage page", () => {
	it("shows the same badge and action on the account's quota card", async () => {
		const report: UsageReport = {
			provider: "anthropic",
			fetchedAt: 0,
			account: "home@example.com",
			credentialId: 9,
			limits: [{ id: "anthropic:5h", label: "5h", usedFraction: 1 }],
			resetPasses: usable,
		};
		getUsage.mockResolvedValue(ok("get_usage", { reports: [report] }));
		useSessionStore.setState({ status: "ready" });
		await mount(<UsageQuotas />);
		expect(text()).toContain(resetPassSummary(usable, translate));
		expect(button(translate("resetPasses.useFor", { account: "home@example.com" }))?.disabled).toBe(false);
	});
});
