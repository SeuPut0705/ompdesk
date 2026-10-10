import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureProviderOptions } from "../../../../../e2e/models-config-fixture";
import type { CustomProvidersConfig, CustomProviderView, RemoteState } from "../../../../shared/ipc-types";
import type {
	ModelCatalogUpdateFrame,
	ProviderAccount,
	ProviderInfo,
	ProvidersResult,
	RpcResponse,
} from "../../../../shared/rpc-types";
import { formatClock } from "../../../lib/format";
import { I18nProvider, translate } from "../../../lib/i18n";
import { useExtensionUiStore } from "../../../stores/extension-ui";
import { useModelStore } from "../../../stores/model";
import { useRemoteStore } from "../../../stores/remote";
import { useSessionStore } from "../../../stores/session";
import { setFocusedSessionRuntime } from "../../../stores/session-runtime-context";
import { useTabsStore } from "../../../stores/tabs";
import { useToastStore } from "../../../stores/toast";
import { useUiStore } from "../../../stores/ui";
import { SettingsDataProvider } from "../settings-data";
import { SettingsNavigationProvider } from "../settings-navigation";
import { ProviderRow } from "./ProviderList";
import { ProvidersSection } from "./ProvidersSection";

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

function row(id: string, overrides: Partial<ProviderInfo> = {}): ProviderInfo {
	return { id, name: id, authenticated: true, loginAvailable: false, disabled: false, modelCount: 0, ...overrides };
}

function config(id: string, overrides: Partial<CustomProviderView> = {}): CustomProviderView {
	return {
		id,
		api: "openai-completions",
		baseUrl: `https://${id}.example/v1`,
		hasApiKey: true,
		models: [],
		builtin: false,
		...overrides,
	};
}

function snapshot(
	providers: ProviderInfo[],
	overrides: Partial<Omit<ProvidersResult, "providers">> = {},
): ProvidersResult {
	return { providers, models: [], discoveryStates: [], refreshPending: false, generation: 1, ...overrides };
}

function providersResponse(data: ProvidersResult): RpcResponse {
	return { type: "response", command: "get_providers", success: true, data };
}

const getProviders = vi.fn(async () => providersResponse(snapshot([row("anthropic")])));
const logout = vi.fn(async (): Promise<RpcResponse> => ({ type: "response", command: "logout", success: true }));
const disconnectProvider = vi.fn(
	async (): Promise<RpcResponse> => ({ type: "response", command: "logout", success: true }),
);
const login = vi.fn(async (): Promise<RpcResponse> => ({ type: "response", command: "login", success: true }));
const getProviderAccounts = vi.fn(
	async (): Promise<RpcResponse> => ({
		type: "response",
		command: "get_provider_accounts",
		success: true,
		data: { providerId: "anthropic", accounts: [] },
	}),
);
const listProviders = vi.fn(
	async (): Promise<CustomProvidersConfig> => ({ providers: [], options: fixtureProviderOptions }),
);
const respondExtensionUi = vi.fn();
const openExternal = vi.fn(async () => {});

const accountRotationGet = vi.fn(async () => ({ mode: "quota" as const, evenSupported: true }));

Object.assign(window as unknown as Record<string, unknown>, {
	omp: {
		rpc: { getProviders, logout, disconnectProvider, login, getProviderAccounts },
		models: { listProviders },
		ui: { respondExtensionUi },
		system: { openExternal },
		accountRotation: { get: accountRotationGet, set: vi.fn(async () => {}) },
	},
});

const text = () => document.body.textContent ?? "";

function button(name: string): HTMLButtonElement | undefined {
	return Array.from(document.body.querySelectorAll("button")).find(
		candidate => (candidate.textContent ?? "").trim() === name || candidate.getAttribute("aria-label") === name,
	) as HTMLButtonElement | undefined;
}

/** A provider row that expands what is under it, by the provider's name. */
function disclosure(name: string): HTMLButtonElement | undefined {
	return Array.from(document.body.querySelectorAll("button[aria-expanded]")).find(
		candidate => (candidate.textContent ?? "").trim() === name,
	) as HTMLButtonElement | undefined;
}

const roots: Root[] = [];
function delay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/**
 * Linkedom has no native value tracking, so call this node's own controlled
 * input handler (the same approach as inventory-ui.test.tsx).
 */
async function typeInto(element: unknown, value: string): Promise<void> {
	if (!element || typeof element !== "object") throw new Error("field not found");
	const record = element as Record<string, unknown>;
	record.value = value;
	const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
	const props = propsKey ? (record[propsKey] as { onChange?: (event: object) => void } | undefined) : undefined;
	await act(async () => props?.onChange?.({ target: element, currentTarget: element }));
}

async function mount(element: ReactElement): Promise<void> {
	const root = createRoot(document.body as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<SettingsNavigationProvider value={() => {}}>
					<SettingsDataProvider
						value={{
							schema: { entries: [], tabs: [] },
							values: {},
							loadState: "ready",
							loadError: null,
							sidecarReady: true,
							sidecarBusy: false,
							advisorActive: undefined,
							onCommitted: () => {},
							retry: () => {},
						}}
					>
						{element}
					</SettingsDataProvider>
				</SettingsNavigationProvider>
			</I18nProvider>,
		);
	});
	await act(async () => {
		await delay(0);
	});
	roots.push(root);
}

const HOST_ID = "host-studio";

/** One focused tab on the paired host "Studio" (or, with `undefined`, on this device). */
function focusTab(device: string | undefined): void {
	const remote: RemoteState = {
		host: {
			enabled: false,
			name: "laptop",
			port: null,
			addresses: [],
			code: null,
			expiresAt: null,
			peers: [],
			keepAwake: true,
			keepingAwake: false,
			usedBy: [],
		},
		hosts: [{ deviceId: HOST_ID, name: "Studio", state: "online" }],
	};
	useRemoteStore.getState().apply(remote);
	useTabsStore.setState({
		tabs: [{ id: "t1", cwd: "/Users/kim/app", status: "ready", kind: "agent", unreadDone: false, device }],
		activeTabId: "t1",
	});
	setFocusedSessionRuntime("t1");
}

afterEach(async () => {
	for (const root of roots) {
		await act(async () => root.unmount());
	}
	roots.length = 0;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useUiStore.getState().closeProviderForm();
	useModelStore.getState().reset();
	useSessionStore.getState().reset();
	useExtensionUiStore.getState().clearAll();
	useExtensionUiStore.getState().setInlineLogin(false);
	useToastStore.setState({ toasts: [] });
	useTabsStore.getState().reset();
	useRemoteStore.getState().reset();
	setFocusedSessionRuntime(null);
	openExternal.mockClear();
	getProviders.mockReset();
	getProviders.mockResolvedValue(providersResponse(snapshot([row("anthropic")])));
	listProviders.mockReset();
	listProviders.mockResolvedValue({ providers: [], options: fixtureProviderOptions });
	logout.mockClear();
	disconnectProvider.mockClear();
	getProviderAccounts.mockReset();
	getProviderAccounts.mockResolvedValue({
		type: "response",
		command: "get_provider_accounts",
		success: true,
		data: { providerId: "anthropic", accounts: [] },
	});
	login.mockReset();
	login.mockResolvedValue({ type: "response", command: "login", success: true });
	respondExtensionUi.mockClear();
});

describe("ProviderRow", () => {
	const handlers = { onConnect: () => {}, onLogout: () => {} };
	const render = (provider: ProviderInfo, config?: CustomProviderView, sidecarReady = true) =>
		renderToStaticMarkup(
			<I18nProvider>
				<ProviderRow
					busy={false}
					config={config}
					handlers={handlers}
					provider={provider}
					sidecarReady={sidecarReady}
				/>
			</I18nProvider>,
		);

	it("offers a quiet connect action, not a primary button, for a provider with a sign-in flow", () => {
		const html = render(row("tavily", { authenticated: false, loginAvailable: true }));
		expect(html).toContain(translate("providerList.connect"));
		expect(html).not.toContain("bg-(--sc-accent)");
		expect(html).not.toContain(translate("providers.logout"));
	});

	it("offers credential refresh and sign-out once connected", () => {
		const html = render(row("tavily", { loginAvailable: true }));
		expect(html).toContain(translate("providers.updateCredentials", { provider: "tavily" }));
		expect(html).toContain(translate("providers.logout"));
		expect(html).not.toContain(`>${translate("providerList.connect")}<`);
	});

	it("keeps endpoint editing in the single custom endpoint list, not the account summary", () => {
		const html = render(row("infronai"), config("infronai"));
		expect(html).not.toContain(translate("providers.edit"));
		expect(html).not.toContain(translate("providerCfg.list.delete"));
		expect(html).not.toContain(translate("providers.logout"));
	});

	it("renders no action for a catalog-only provider", () => {
		const html = render(row("catalog-only", { authenticated: false }));
		expect(html).not.toContain(translate("providers.edit"));
		expect(html).not.toContain(translate("providerList.connect"));
	});

	it("locks sign-in while omp is disconnected and says why", () => {
		const html = render(row("tavily", { authenticated: false, loginAvailable: true }), undefined, false);
		expect(html).toContain("disabled");
		expect(html).toContain(`title="${translate("providers.notConnected").replaceAll("'", "&#x27;")}"`);
	});
});

describe("ProvidersSection", () => {
	it("shows a provider list that a catalog push replaces, not just the read it made on mount", async () => {
		useSessionStore.setState({ status: "ready" });
		await mount(<ProvidersSection />);
		expect(text()).toContain("anthropic");

		await act(async () => {
			useModelStore.getState().applyCatalogUpdate({
				type: "model_catalog_update",
				...snapshot([row("anthropic"), row("my-proxy", { name: "My Proxy", modelCount: 7 })], { generation: 2 }),
			} as ModelCatalogUpdateFrame);
		});
		expect(text()).toContain("My Proxy");
		expect(text()).toContain(translate("providers.models", { count: 7 }));
	});

	it("re-reads while discovery is still running and drops the waiting banner once it lands", async () => {
		// Hold the re-read until the waiting banner is asserted: on a slow runner
		// the 25ms poll would otherwise land before the first check.
		const discoveryDone = Promise.withResolvers<void>();
		getProviders
			.mockResolvedValueOnce(
				providersResponse(snapshot([row("my-proxy", { name: "My Proxy" })], { refreshPending: true })),
			)
			.mockImplementation(async () => {
				await discoveryDone.promise;
				return providersResponse(
					snapshot([row("my-proxy", { name: "My Proxy", modelCount: 12 })], { generation: 2 }),
				);
			});
		useSessionStore.setState({ status: "ready" });
		await mount(<ProvidersSection pollMs={25} />);
		expect(text()).toContain(translate("providers.refreshPending"));
		discoveryDone.resolve();

		const deadline = Date.now() + 10_000;
		const landed = translate("providers.models", { count: 12 });
		while (!text().includes(landed) && Date.now() < deadline) {
			await act(async () => {
				await delay(25);
			});
		}
		expect(text()).toContain(landed);
		expect(getProviders.mock.calls.length).toBeGreaterThan(1);
		expect(text()).not.toContain(translate("providers.refreshPending"));
	});

	it("confirms before signing out, then forces a fresh read and names the provider", async () => {
		getProviders.mockResolvedValue(
			providersResponse(snapshot([row("my-proxy", { name: "My Proxy" })], { generation: 3 })),
		);
		useSessionStore.setState({ status: "ready" });
		await mount(<ProvidersSection />);
		getProviders.mockClear();

		await act(async () => button(translate("providers.logout"))?.click());
		expect(logout).not.toHaveBeenCalled();
		expect(text()).toContain(translate("providers.logoutTitle", { provider: "My Proxy" }));
		await act(async () => button(translate("providers.logoutConfirm"))?.click());

		expect(disconnectProvider).toHaveBeenCalledWith("my-proxy");
		expect(logout).not.toHaveBeenCalled();
		expect(getProviders).toHaveBeenCalledWith(true);
		const messages = useToastStore
			.getState()
			.toasts.map(entry => entry.message)
			.join("\n");
		expect(messages).toContain("My Proxy");
		expect(messages).not.toContain("my-proxy");
	});

	it("keeps the credential when the sign-out prompt is cancelled", async () => {
		useSessionStore.setState({ status: "ready" });
		await mount(<ProvidersSection />);
		await act(async () => button(translate("providers.logout"))?.click());
		await act(async () => button(translate("common.cancel"))?.click());
		expect(disconnectProvider).not.toHaveBeenCalled();
	});

	it("reports a failed catalog read instead of an empty list", async () => {
		getProviders.mockRejectedValueOnce(new Error("socket hang up"));
		useSessionStore.setState({ status: "ready" });
		await mount(<ProvidersSection />);
		expect(text()).toContain("socket hang up");
		expect(text()).toContain(translate("providers.loadFailed"));
	});

	it("names a models.yml provider the sidecar lists no models for", async () => {
		listProviders.mockResolvedValueOnce({ providers: [config("my-proxy")], options: fixtureProviderOptions });
		getProviders.mockResolvedValueOnce(
			providersResponse(snapshot([row("anthropic", { modelCount: 4 })], { generation: 5 })),
		);
		useSessionStore.setState({ status: "ready" });
		await mount(<ProvidersSection />);
		expect(text()).toContain("my-proxy");
		expect(text()).toContain(translate("providerList.noModels"));
	});

	it("collapses the long tail behind one button and searches across all of it", async () => {
		const tail = Array.from({ length: 30 }, (_, index) =>
			row(`tail-${index}`, { authenticated: false, loginAvailable: true }),
		);
		getProviders.mockResolvedValue(
			providersResponse(
				snapshot([row("deepseek", { name: "DeepSeek", authenticated: false, loginAvailable: true }), ...tail]),
			),
		);
		useSessionStore.setState({ status: "ready" });
		await mount(<ProvidersSection />);
		expect(text()).toContain("DeepSeek");
		expect(text()).not.toContain("tail-7");
		expect(button(translate("providerList.showMore", { count: 30 }))).toBeDefined();

		await typeInto(document.querySelector('input[type="search"]'), "tail-7");
		expect(text()).toContain("tail-7");
		expect(text()).not.toContain("DeepSeek");
	});

	it("keeps the providers to add behind 'Add a provider' once one is connected", async () => {
		getProviders.mockResolvedValue(
			providersResponse(
				snapshot([
					row("anthropic", { name: "Anthropic" }),
					row("deepseek", { name: "DeepSeek", authenticated: false, loginAvailable: true }),
				]),
			),
		);
		useSessionStore.setState({ status: "ready" });
		await mount(<ProvidersSection />);
		expect(text()).toContain("Anthropic");
		expect(text()).not.toContain("DeepSeek");
		expect(document.querySelector('input[type="search"]')).toBeNull();

		const add = button(translate("providers.add"));
		expect(add?.getAttribute("aria-expanded")).toBe("false");
		await act(async () => add?.click());
		expect(add?.getAttribute("aria-expanded")).toBe("true");
		expect(text()).toContain("DeepSeek");
		expect(document.querySelector('input[type="search"]')).toBeTruthy();
		// The picker lists only what is not connected yet.
		const picker = document.getElementById(add?.getAttribute("aria-controls") ?? "");
		const rows = Array.from(picker?.querySelectorAll("li") ?? []).map(item => item.textContent ?? "");
		expect(rows.some(item => item.includes("DeepSeek"))).toBe(true);
		expect(rows.some(item => item.includes("Anthropic"))).toBe(false);
	});

	it("opens the custom endpoint form in place of the list (no dialog)", async () => {
		useSessionStore.setState({ status: "ready" });
		await mount(<ProvidersSection />);
		await act(async () => button(translate("providerList.addCustom"))?.click());
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(text()).toContain(translate("providerCfg.title.add"));
		await act(async () => button(translate("providerCfg.form.cancel"))?.click());
		expect(useUiStore.getState().providerForm).toBeNull();
	});

	it("signs in inline: the key prompt renders masked in the row and answers omp directly", async () => {
		const pending = Promise.withResolvers<RpcResponse>();
		login.mockReturnValueOnce(pending.promise);
		getProviders.mockResolvedValue(
			providersResponse(
				snapshot([row("deepseek", { name: "DeepSeek", authenticated: false, loginAvailable: true })]),
			),
		);
		useSessionStore.setState({ status: "ready" });
		await mount(<ProvidersSection />);

		await act(async () => button(translate("providerList.connect"))?.click());
		expect(login).toHaveBeenCalledWith("deepseek");
		expect(useExtensionUiStore.getState().inlineLogin).toBe(true);

		await act(async () => {
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "url-1",
				method: "open_url",
				url: "https://platform.deepseek.com/api_keys",
				instructions: "Create or copy your API key from the DeepSeek dashboard",
			});
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "key-1",
				method: "input",
				title: "Paste your DeepSeek API key",
				placeholder: "sk-...",
			});
		});
		// The URL is shown inline and acknowledged so the prompt is not queued behind it.
		expect(respondExtensionUi).toHaveBeenCalledWith({ type: "extension_ui_response", id: "url-1", value: "done" });
		expect(text()).toContain("Create or copy your API key from the DeepSeek dashboard");
		// No callback server (no launchUrl): the link is a page to copy the key from.
		expect(button(translate("providerList.login.openKeyPage"))).toBeDefined();
		const field = document.querySelector('input[type="password"]');
		expect(field).toBeTruthy();
		await typeInto(field, "sk-test");
		// Enter / the Connect button submit the form.
		await act(async () => {
			field?.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});
		expect(respondExtensionUi).toHaveBeenCalledWith({ type: "extension_ui_response", id: "key-1", value: "sk-test" });

		getProviders.mockResolvedValue(
			providersResponse(snapshot([row("deepseek", { name: "DeepSeek", modelCount: 2 })])),
		);
		await act(async () => {
			pending.resolve({ type: "response", command: "login", success: true });
		});
		expect(useExtensionUiStore.getState().inlineLogin).toBe(false);
		expect(
			useToastStore
				.getState()
				.toasts.map(entry => entry.message)
				.join("\n"),
		).toContain(translate("providers.loginSuccess", { provider: "DeepSeek" }));
	});

	it("shows a failed sign-in inline with a retry", async () => {
		login.mockResolvedValueOnce({ type: "response", command: "login", success: false, error: "Invalid API key" });
		getProviders.mockResolvedValue(
			providersResponse(
				snapshot([row("deepseek", { name: "DeepSeek", authenticated: false, loginAvailable: true })]),
			),
		);
		useSessionStore.setState({ status: "ready" });
		await mount(<ProvidersSection />);
		await act(async () => button(translate("providerList.connect"))?.click());
		expect(text()).toContain(translate("providerList.login.failed", { provider: "DeepSeek" }));
		expect(text()).toContain("Invalid API key");
		expect(button(translate("providerList.login.retry"))).toBeDefined();
	});

	it("offers 'Edit config' only for this device's models.yml, and reads the host's file on a remote tab", async () => {
		useSessionStore.setState({ status: "ready" });
		focusTab(undefined);
		await mount(<ProvidersSection />);
		expect(button(translate("providers.editConfig"))).toBeDefined();
		expect(listProviders).toHaveBeenLastCalledWith(undefined);
		await act(async () => roots.pop()?.unmount());

		focusTab(HOST_ID);
		await mount(<ProvidersSection />);
		expect(button(translate("providers.editConfig"))).toBeUndefined();
		expect(button(translate("providerList.addCustom"))).toBeDefined();
		expect(listProviders).toHaveBeenLastCalledWith(HOST_ID);
	});

	describe("browser sign-in", () => {
		const openUrl = {
			type: "extension_ui_request",
			id: "url-1",
			method: "open_url",
			url: "https://claude.ai/oauth/authorize?state=xyz",
			launchUrl: "http://localhost:54545/launch",
		} as const;

		async function startSignIn(device: string | undefined): Promise<void> {
			login.mockReturnValueOnce(Promise.withResolvers<RpcResponse>().promise);
			getProviders.mockResolvedValue(
				providersResponse(
					snapshot([row("anthropic", { name: "Anthropic", authenticated: false, loginAvailable: true })]),
				),
			);
			useSessionStore.setState({ status: "ready" });
			focusTab(device);
			await mount(<ProvidersSection />);
			await act(async () => button(translate("providerList.connect"))?.click());
			await act(async () => {
				useExtensionUiStore.getState().pushRequest(openUrl);
				useExtensionUiStore.getState().pushRequest({
					type: "extension_ui_request",
					id: "code-1",
					method: "input",
					title: "Paste the authorization code (or full redirect URL):",
				});
			});
			await act(async () => button(translate("providerList.login.openBrowser"))?.click());
		}

		it("on a remote tab opens the provider's URL, not the host's launch page, and asks for the redirect", async () => {
			await startSignIn(HOST_ID);
			expect(openExternal).toHaveBeenCalledWith(openUrl.url);
			expect(openExternal).not.toHaveBeenCalledWith(openUrl.launchUrl);
			expect(document.querySelector("[data-remote-login-hint]")?.textContent).toBe(
				translate("providerList.login.remoteHint", { name: "Studio" }),
			);
			expect(document.querySelector('input[type="password"]')).toBeTruthy();
		});

		it("on a local tab opens the launch page and shows no paste hint", async () => {
			await startSignIn(undefined);
			expect(openExternal).toHaveBeenCalledWith(openUrl.launchUrl);
			expect(document.querySelector("[data-remote-login-hint]")).toBeNull();
			// The code prompt beside an OAuth callback does not turn the browser sign-in into a key page.
			expect(button(translate("providerList.login.openKeyPage"))).toBeUndefined();
		});
	});
});

describe("ProviderAccounts", () => {
	const limitedUntil = Date.now() + 2 * 60 * 60_000;
	const accounts: ProviderAccount[] = [
		{
			credentialId: 7,
			label: "work@example.com",
			detail: "oauth #7",
			type: "oauth",
			inUse: true,
			state: "healthy",
			remainingFraction: 0.39,
			limits: [
				{ id: "anthropic:5h", label: "Claude 5 Hour", usedFraction: 0.06 },
				{ id: "anthropic:7d", label: "Claude 7 Day", usedFraction: 0.61 },
			],
		},
		{
			credentialId: 9,
			label: "home@example.com",
			detail: "oauth #9",
			type: "oauth",
			inUse: false,
			state: "depleted",
			limitedUntil,
			limits: [],
		},
	];
	const claude = row("anthropic", { name: "Anthropic", authKind: "oauth", loginAvailable: true, modelCount: 3 });

	async function mountWithAccounts(list: ProviderAccount[] = accounts): Promise<void> {
		getProviders.mockResolvedValue(providersResponse(snapshot([claude])));
		getProviderAccounts.mockResolvedValue({
			type: "response",
			command: "get_provider_accounts",
			success: true,
			data: { providerId: "anthropic", accounts: list },
		});
		useSessionStore.setState({ status: "ready" });
		await mount(<ProvidersSection />);
		await act(async () => disclosure("Anthropic")?.click());
	}

	it("names the account count on the collapsed row and expands to the accounts in place", async () => {
		getProviders.mockResolvedValue(providersResponse(snapshot([claude])));
		getProviderAccounts.mockResolvedValue({
			type: "response",
			command: "get_provider_accounts",
			success: true,
			data: { providerId: "anthropic", accounts },
		});
		useSessionStore.setState({ status: "ready" });
		await mount(<ProvidersSection />);
		const toggle = disclosure("Anthropic");
		expect(toggle?.getAttribute("aria-expanded")).toBe("false");
		expect(text()).toContain(translate("providers.accounts.count", { count: 2 }));
		expect(text()).not.toContain("work@example.com");

		await act(async () => toggle?.click());
		expect(toggle?.getAttribute("aria-expanded")).toBe("true");
		const region = document.getElementById(toggle?.getAttribute("aria-controls") ?? "");
		expect(region?.textContent).toContain("work@example.com");
		expect(getProviderAccounts).toHaveBeenCalledTimes(1);
	});

	it("lists every connected account with its quota, the one in use and the one skipped until reset", async () => {
		await mountWithAccounts();
		expect(getProviderAccounts).toHaveBeenCalledWith("anthropic");
		const body = text();
		expect(body).toContain("work@example.com");
		expect(body).toContain("home@example.com");
		expect(body).toContain(translate("providers.accounts.inUse"));
		expect(body.split(translate("providers.accounts.inUse")).length).toBe(2);
		expect(body).toContain(translate("providers.accounts.windowLeft", { window: "Claude 5 Hour", percent: 94 }));
		expect(body).toContain(translate("providers.accounts.windowLeft", { window: "Claude 7 Day", percent: 39 }));
		// One bar per reported window, filled by the used share.
		const bars = Array.from(document.querySelectorAll('[role="progressbar"]'));
		expect(bars.map(bar => bar.getAttribute("aria-valuenow"))).toEqual(["0.06", "0.61"]);
		expect(body).toContain(translate("providers.accounts.limitedUntil", { time: formatClock(limitedUntil) }));
		expect(button(translate("providers.logoutAll"))).toBeDefined();
		// The account-switching mode sits with the accounts, for this device's omp.
		expect(document.querySelector('[data-models-rotation] [role="radiogroup"]')).toBeTruthy();
		expect(accountRotationGet).toHaveBeenLastCalledWith(undefined);
	});

	it("removes only the chosen account, by its credentialId, after confirming", async () => {
		await mountWithAccounts();
		getProviders.mockClear();
		await act(async () => button(translate("providers.accounts.remove", { account: "home@example.com" }))?.click());
		expect(logout).not.toHaveBeenCalled();
		expect(text()).toContain(
			translate("providers.accounts.removeBody", { account: "home@example.com", provider: "Anthropic" }),
		);
		await act(async () => button(translate("providers.accounts.removeConfirm"))?.click());

		expect(logout).toHaveBeenCalledWith("anthropic", 9);
		expect(disconnectProvider).not.toHaveBeenCalled();
		expect(getProviders).toHaveBeenCalledWith(true);
	});

	it("warns that removing the last account disconnects the provider", async () => {
		await mountWithAccounts([accounts[0]]);
		await act(async () => button(translate("providers.accounts.remove", { account: "work@example.com" }))?.click());
		expect(text()).toContain(
			translate("providers.accounts.removeLastBody", { account: "work@example.com", provider: "Anthropic" }),
		);
		await act(async () => button(translate("providers.accounts.removeConfirm"))?.click());
		expect(logout).toHaveBeenCalledWith("anthropic", 7);
	});

	it("adds another account through the same sign-in flow", async () => {
		await mountWithAccounts();
		await act(async () => button(translate("providers.accounts.add"))?.click());
		expect(login).toHaveBeenCalledWith("anthropic");
	});

	it("lists no accounts for a provider signed in with an API key", async () => {
		getProviders.mockResolvedValue(
			providersResponse(snapshot([row("deepseek", { authKind: "apikey", loginAvailable: true })])),
		);
		useSessionStore.setState({ status: "ready" });
		await mount(<ProvidersSection />);
		expect(getProviderAccounts).not.toHaveBeenCalled();
		expect(button(translate("providers.accounts.add"))).toBeUndefined();
		expect(document.querySelector("[data-models-rotation]")).toBeNull();
	});
});
