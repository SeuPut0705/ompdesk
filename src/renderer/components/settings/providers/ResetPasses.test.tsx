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
import { SettingsNavigationProvider } from "../settings-navigation";
import { ProvidersSection } from "./ProvidersSection";
import { ResetPassControl, resetPassSummary } from "./ResetPasses";

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
		events: { onModelsConfigChanged: () => () => {} },
		rpc: routeCommands({ getProviders, getProviderAccounts, redeemResetPass, getUsage }),
		models: { listProviders: vi.fn(async () => ({ providers: [], options: fixtureProviderOptions })) },
		localEngines: { get: vi.fn(async () => ({ enabled: true })), set: vi.fn() },
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
	await mount(
		<SettingsNavigationProvider value={() => {}}>
			<ProvidersSection />
		</SettingsNavigationProvider>,
	);
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

/** What the kit Tooltip says once keyboard focus reaches the control. */
async function tooltipOf(target: Element | null | undefined): Promise<string | null | undefined> {
	if (!target) return undefined;
	// linkedom knows no `:focus-visible`; this focus came from the keyboard.
	const matches = target.matches.bind(target);
	const spy = vi
		.spyOn(target, "matches")
		.mockImplementation(selector => selector === ":focus-visible" || matches(selector));
	await act(async () => target.dispatchEvent(new Event("focusin", { bubbles: true })));
	const text = document.querySelector("[role=tooltip]")?.textContent;
	await act(async () => target.dispatchEvent(new Event("focusout", { bubbles: true })));
	spy.mockRestore();
	return text;
}

describe("reset passes on provider accounts", () => {
	it("shows each account's passes as a ticket with the count, and holds the action while stock says it is unavailable", async () => {
		await mountAccounts([healthy, limited]);
		const pass = (account: string) => button(translate("resetPasses.useFor", { account }));
		// The row carries the count alone; how many are usable and the expiry are the button's tooltip.
		expect(pass("home@example.com")?.textContent).toBe("2");
		expect(await tooltipOf(pass("home@example.com"))).toBe(resetPassSummary(usable, translate));
		expect(pass("home@example.com")?.disabled).toBe(false);
		expect(pass("work@example.com")?.textContent).toBe("1");
		expect(await tooltipOf(pass("work@example.com"))).toContain(
			translate("resetPasses.unavailable", { reason: translate("resetPasses.unavailableUnknown") }),
		);
		expect(pass("work@example.com")?.getAttribute("aria-disabled")).toBe("true");
		expect(text()).not.toContain(translate("resetPasses.use"));
	});

	it("says under the ticket how long until the soonest pass expires: whole days, then hours", async () => {
		const hour = 60 * 60_000;
		const expiring = (expiresAt: number): ResetPasses => ({ ...usable, expiresAt });
		await mountAccounts([
			{ ...healthy, resetPasses: expiring(Date.now() + 20 * 24 * hour + hour) },
			{ ...limited, resetPasses: expiring(Date.now() + 5 * hour + 30_000) },
		]);
		const expiry = (id: number) => document.querySelector(`[data-reset-passes="${id}"] [data-reset-pass-expiry]`);
		expect(expiry(7)?.textContent).toBe("20d");
		expect(expiry(9)?.textContent).toBe("5h");
		// The date itself is the tooltip and the accessible name.
		expect(expiry(9)?.getAttribute("title")).toMatch(/\d+\/\d+/);
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
			translate("resetPasses.confirmSpend", { account: "home@example.com", provider: "Claude", count: 2 }),
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
				quota: translate("providers.accounts.windowLeft", { window: translate("usage.limit.5h"), percent: 0 }),
			}),
		});
		expect(document.querySelector('[data-provider-account="9"] .omp-usage-gauge-text')?.textContent).toBe("5H0%");
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

	describe("an account that holds more than one kind of pass", () => {
		const fable = {
			clears: ["anthropic:5h", "anthropic:7d:fable"],
			title: "Fable launch reset",
			count: 1,
			expiresAt,
			early: false,
			creditId: "grant-fable",
		};
		const full = { clears: ["anthropic:5h", "anthropic:7d"], title: "Limit reset", count: 2, early: false };
		const fullWindows = `${translate("resetPasses.window.5h")}, ${translate("resetPasses.window.7d")}`;
		const holding = (tickets: NonNullable<ResetPasses["tickets"]>): ProviderAccount => ({
			...limited,
			resetPasses: { ...usable, ...fable, count: 3, usableCount: 1, tickets },
		});
		const cards = () => Array.from(document.body.querySelectorAll('[role="dialog"] [role="radio"]'));
		const card = (windows: string) =>
			cards().find(candidate => (candidate.textContent ?? "").includes(windows)) as HTMLButtonElement | undefined;
		const open = () =>
			act(async () => button(translate("resetPasses.useFor", { account: "home@example.com" }))?.click());
		const confirm = () =>
			act(async () =>
				(
					Array.from(document.body.querySelectorAll('[role="dialog"] button')).find(
						candidate => (candidate.textContent ?? "").trim() === translate("resetPasses.use"),
					) as HTMLButtonElement | undefined
				)?.click(),
			);

		it("lists each kind in the dialog and spends the one picked", async () => {
			await mountAccounts([holding([fable, { ...full, creditId: "grant-full" }])]);
			redeemResetPass.mockResolvedValue(
				ok("redeem_reset_pass", { ok: false, code: "nothing_to_reset", message: "" }),
			);
			await open();

			expect(cards()).toHaveLength(2);
			// A card says what its kind resets, the provider's name for it, how many and until when.
			expect(card(fullWindows)?.textContent).toContain(
				`Limit reset · ${translate("resetPasses.count", { count: 2 })}`,
			);
			expect(cards()[0]?.textContent).toContain(
				`Fable launch reset · ${translate("resetPasses.countOne")} · ${translate("resetPasses.expires", { date: "10/12" })}`,
			);
			// Until a kind is picked, the dialog describes the first one on offer.
			expect(cards()[0]?.getAttribute("aria-checked")).toBe("true");
			expect(text()).not.toContain(translate("resetPasses.confirmResets", { windows: fullWindows }));
			expect(text()).not.toContain(translate("resetPasses.chooseLimit", { provider: "Claude" }));

			await act(async () => card(fullWindows)?.click());
			expect(card(fullWindows)?.getAttribute("aria-checked")).toBe("true");
			expect(text()).toContain(translate("resetPasses.confirmResets", { windows: fullWindows }));
			expect(redeemResetPass).not.toHaveBeenCalled();

			await confirm();
			expect(redeemResetPass).toHaveBeenCalledTimes(1);
			expect(redeemResetPass).toHaveBeenCalledWith("anthropic", 9, "grant-full");
		});

		it("forgets the pick when the dialog is opened again", async () => {
			await mountAccounts([holding([fable, { ...full, creditId: "grant-full" }])]);
			await open();
			await act(async () => card(fullWindows)?.click());
			await act(async () => button(translate("common.cancel"))?.click());
			await open();
			expect(card(fullWindows)?.getAttribute("aria-checked")).toBe("false");
		});

		it("cannot pick a kind omp is offered no pass of, says why, and spends the one on offer", async () => {
			await mountAccounts([holding([fable, full])]);
			redeemResetPass.mockResolvedValue(
				ok("redeem_reset_pass", { ok: false, code: "nothing_to_reset", message: "" }),
			);
			await open();

			expect(card(fullWindows)?.disabled).toBe(true);
			expect(text()).toContain(translate("resetPasses.chooseLimit", { provider: "Claude" }));
			await act(async () => card(fullWindows)?.click());
			expect(card(fullWindows)?.getAttribute("aria-checked")).toBe("false");

			await confirm();
			expect(redeemResetPass).toHaveBeenCalledWith("anthropic", 9, "grant-fable");
		});

		/** The control alone, so a test can hand it the passes a re-read of the accounts would. */
		async function mountControl(first: ResetPasses, afterSpend?: ResetPasses) {
			const root = createRoot(document.body as unknown as Element);
			roots.push(root);
			const control = (passes: ResetPasses) => (
				<I18nProvider>
					<ResetPassControl
						account="home@example.com"
						credentialId={9}
						disabled={false}
						limits={[]}
						onRedeemed={async () => {
							if (afterSpend) root.render(control(afterSpend));
							return undefined;
						}}
						passes={passes}
						providerId="anthropic"
						providerName="Claude"
					/>
				</I18nProvider>
			);
			const show = (passes: ResetPasses) => act(async () => root.render(control(passes)));
			await show(first);
			await act(tick);
			return show;
		}
		const both = holding([fable, full]).resetPasses as ResetPasses;
		/** The account once its Fable pass is gone: the regular one is what the provider offers next. */
		const fullOnly: ResetPasses = { ...usable, ...full, creditId: "grant-full", usableCount: 2 };
		const changedToast = {
			variant: "warning",
			title: translate("resetPasses.failed"),
			detail: translate("resetPasses.outcome.offerChanged"),
		};

		it("never spends a pass that took the place of the one its open dialog shows", async () => {
			const show = await mountControl(both);
			redeemResetPass.mockResolvedValue(ok("redeem_reset_pass", { ok: true, code: "reset", message: "" }));
			await open();
			expect(cards()[0]?.getAttribute("aria-checked")).toBe("true");

			// The accounts are read again while the dialog is open: the Fable pass is gone.
			await show(fullOnly);
			await confirm();

			expect(redeemResetPass).not.toHaveBeenCalled();
			expect(document.body.querySelector('[role="dialog"]')).toBeNull();
			expect(toasts().at(-1)).toMatchObject(changedToast);
		});

		it("keeps its dialog and the pick through a re-read that still offers the same passes", async () => {
			const offered = holding([fable, { ...full, creditId: "grant-full" }]).resetPasses as ResetPasses;
			const show = await mountControl(offered);
			redeemResetPass.mockResolvedValue(
				ok("redeem_reset_pass", { ok: false, code: "nothing_to_reset", message: "" }),
			);
			await open();
			await act(async () => card(fullWindows)?.click());
			await show({ ...offered, count: 4, tickets: [{ ...full, creditId: "grant-full", count: 3 }, fable] });

			expect(card(fullWindows)?.getAttribute("aria-checked")).toBe("true");
			await confirm();
			expect(redeemResetPass).toHaveBeenCalledWith("anthropic", 9, "grant-full");
		});

		it("reports a spend that changed the offer as the spend it was", async () => {
			await mountControl(both, fullOnly);
			redeemResetPass.mockResolvedValue(ok("redeem_reset_pass", { ok: true, code: "reset", message: "" }));
			await open();
			await confirm();
			await act(tick);

			expect(redeemResetPass).toHaveBeenCalledWith("anthropic", 9, "grant-fable");
			expect(toasts().map(toast => toast.variant)).toEqual(["success"]);
		});
	});
});

describe("reset passes on the Usage page", () => {
	it("shows the same ticket and action on the account's quota card", async () => {
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
		const pass = button(translate("resetPasses.useFor", { account: "home@example.com" }));
		expect(await tooltipOf(pass)).toBe(resetPassSummary(usable, translate));
		expect(pass?.disabled).toBe(false);
	});
});
