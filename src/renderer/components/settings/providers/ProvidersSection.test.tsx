import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
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
import { USAGE_POLL_MS } from "../../../lib/usage-reports";
import { useExtensionUiStore } from "../../../stores/extension-ui";
import { useModelStore } from "../../../stores/model";
import { useRemoteStore } from "../../../stores/remote";
import { useSessionStore } from "../../../stores/session";
import { setFocusedSessionRuntime } from "../../../stores/session-runtime-context";
import { useTabsStore } from "../../../stores/tabs";
import { useToastStore } from "../../../stores/toast";
import { useUiStore } from "../../../stores/ui";
import { routeCommands } from "../../../test-support/route-commands";
import { ExtensionDialog } from "../../dialogs/ExtensionDialog";
import { SettingsDataProvider } from "../settings-data";
import { SettingsNavigationProvider } from "../settings-navigation";
import { ProvidersSection } from "./ProvidersSection";

const viewer = vi.hoisted(() => ({ web: false }));
vi.mock("../../../web/pwa", () => ({ webPwa: () => (viewer.web ? {} : null) }));

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
if (typeof elementPrototype.scrollIntoView !== "function") elementPrototype.scrollIntoView = () => {};

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
const cancelLogin = vi.fn(
	async (): Promise<RpcResponse> => ({ type: "response", command: "login_cancel", success: true }),
);
const getProviderAccounts = vi.fn(
	async (): Promise<RpcResponse> => ({
		type: "response",
		command: "get_provider_accounts",
		success: true,
		data: { providerId: "anthropic", accounts: [] },
	}),
);
/** The tab's usage poll, whose schedule re-reads the account quotas. */
const getUsage = vi.fn(
	async (): Promise<RpcResponse> => ({ type: "response", command: "get_usage", success: true, data: { reports: [] } }),
);
const listProviders = vi.fn(
	async (): Promise<CustomProvidersConfig> => ({ providers: [], options: fixtureProviderOptions }),
);
const respondExtensionUi = vi.fn();
const openExternal = vi.fn(async () => {});

const accountRotationGet = vi.fn(async () => ({ mode: "quota" as const, evenSupported: true }));

Object.assign(window as unknown as Record<string, unknown>, {
	omp: {
		rpc: routeCommands({
			getProviders,
			logout,
			disconnectProvider,
			login,
			cancelLogin,
			getProviderAccounts,
			getUsage,
		}),
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

/** Opens one row's overflow menu (the row is named "{provider} {account}") and picks an action. */
async function chooseAction(row: string, action: string): Promise<void> {
	await act(async () => button(translate("providers.row.actions", { name: row }))?.click());
	const item = Array.from(document.body.querySelectorAll('[role="menuitem"]')).find(candidate =>
		(candidate.textContent ?? "").includes(action),
	) as HTMLElement | undefined;
	if (!item) throw new Error(`no "${action}" in the menu of ${row}`);
	await act(async () => item.click());
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
		tailnet: "ready",
		host: {
			enabled: false,
			name: "laptop",
			port: null,
			addresses: [],
			listenError: null,
			peers: [],
			keepAwake: true,
			keepingAwake: false,
			usedBy: [],
		},
		hosts: [{ deviceId: HOST_ID, name: "Studio", state: "online" }],
		forgotten: [],
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
	useUiStore.getState().clearProviderFocus();
	useModelStore.getState().reset();
	useSessionStore.getState().reset();
	useExtensionUiStore.getState().clearAll();
	useExtensionUiStore.setState({ inlineLogins: 0, loginRequestIds: {}, adoptedLogin: null });
	useToastStore.setState({ toasts: [] });
	useTabsStore.getState().reset();
	useRemoteStore.getState().reset();
	setFocusedSessionRuntime(null);
	viewer.web = false;
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
	cancelLogin.mockClear();
	respondExtensionUi.mockReset();
});

describe("ProvidersSection", () => {
	it("shows a provider list that a catalog push replaces, not just the read it made on mount", async () => {
		useSessionStore.setState({ status: "ready" });
		await mount(<ProvidersSection />);
		expect(text()).toContain("Claude");

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

		await chooseAction("My Proxy", translate("providers.logout"));
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
		await chooseAction("anthropic", translate("providers.logout"));
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

	it("tells a keyless models.yml entry with models that it needs a key, not that it has no models", async () => {
		// The real omp (stock auth: apiKey by default) lists no models for an entry without a key.
		const model = { id: "local-model" };
		listProviders.mockResolvedValueOnce({
			providers: [
				config("keyless", { hasApiKey: false, models: [model] }),
				config("open-server", { hasApiKey: false, auth: "none", models: [model] }),
			],
			options: fixtureProviderOptions,
		});
		getProviders.mockResolvedValueOnce(providersResponse(snapshot([row("anthropic")], { generation: 5 })));
		useSessionStore.setState({ status: "ready" });
		await mount(<ProvidersSection />);
		const rowText = (id: string) => document.querySelector(`[data-custom-provider="${id}"]`)?.textContent ?? "";
		expect(rowText("keyless")).toContain(translate("providerList.needsKey"));
		expect(rowText("keyless")).not.toContain(translate("providerList.noModels"));
		expect(rowText("open-server")).toContain(translate("providerList.notLoaded"));
	});

	it("lists every provider to add as one compact grid, sorted by company, and searches across it", async () => {
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
		// No collapsed tail: all 31 are in the grid at once.
		expect(document.querySelectorAll("[data-provider-picker] li").length).toBe(31);
		expect(text()).toContain("DeepSeek");
		expect(text()).toContain("tail-7");

		await typeInto(document.querySelector('input[type="search"]'), "tail-7");
		expect(text()).toContain("tail-7");
		expect(text()).not.toContain("DeepSeek");
	});

	it("signs in to the only provider a search leaves when Enter is pressed", async () => {
		getProviders.mockResolvedValue(
			providersResponse(
				snapshot([
					row("deepseek", { name: "DeepSeek", authenticated: false, loginAvailable: true }),
					row("groq", { name: "Groq", authenticated: false, loginAvailable: true }),
				]),
			),
		);
		useSessionStore.setState({ status: "ready" });
		await mount(<ProvidersSection />);
		const search = document.querySelector('input[type="search"]');
		await typeInto(search, "gro");
		const propsKey = Object.getOwnPropertyNames(search as object).find(key => key.startsWith("__reactProps$"));
		const props = (search as unknown as Record<string, { onKeyDown?: (event: object) => void }>)[propsKey ?? ""];
		await act(async () => props?.onKeyDown?.({ key: "Enter" }));
		expect(login).toHaveBeenCalledWith("groq");
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
		expect(text()).toContain("Claude");
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

	describe("showing the card of a provider a Model roles row asked for", () => {
		async function focused(id: string): Promise<Element[]> {
			getProviders.mockResolvedValue(
				providersResponse(
					snapshot([
						row("anthropic", { name: "Anthropic" }),
						row("openrouter", { name: "OpenRouter", authenticated: false, loginAvailable: true }),
						row("deepseek", { name: "DeepSeek", authenticated: false, loginAvailable: true }),
					]),
				),
			);
			useSessionStore.setState({ status: "ready" });
			useUiStore.getState().focusProvider(id);
			const shown: Element[] = [];
			const originalScroll = elementPrototype.scrollIntoView;
			elementPrototype.scrollIntoView = function (this: Element) {
				shown.push(this);
			};
			try {
				await mount(<ProvidersSection />);
			} finally {
				elementPrototype.scrollIntoView = originalScroll;
			}
			return shown;
		}

		it("opens the folded picker and scrolls to a featured provider's card", async () => {
			const shown = await focused("openrouter");

			expect(button(translate("providers.add"))?.getAttribute("aria-expanded")).toBe("true");
			expect(shown.at(-1)?.getAttribute("data-featured-provider")).toBe("openrouter");
			expect(useUiStore.getState().providerFocus).toBeNull();
		});

		it("scrolls to the tile of a provider the picker lists plainly", async () => {
			const shown = await focused("deepseek");

			expect(shown.at(-1)?.getAttribute("data-provider-connect")).toBe("deepseek");
			expect(useUiStore.getState().providerFocus).toBeNull();
		});

		it("scrolls to a connected provider's row without opening the picker", async () => {
			const shown = await focused("anthropic");

			expect(button(translate("providers.add"))?.getAttribute("aria-expanded")).toBe("false");
			expect(shown.at(-1)?.getAttribute("data-provider-row")).toBe("anthropic");
		});

		it("lands on the section for a provider with no card here", async () => {
			const shown = await focused("elsewhere");

			expect(shown.at(-1)?.id).toBe("settings-models-accounts");
			expect(useUiStore.getState().providerFocus).toBeNull();
		});
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

	it("brings the edited endpoint, or Add custom endpoint, back into view when the form closes", async () => {
		listProviders.mockResolvedValue({ providers: [config("my-proxy")], options: fixtureProviderOptions });
		useSessionStore.setState({ status: "ready" });
		const shown: Element[] = [];
		const originalScroll = elementPrototype.scrollIntoView;
		elementPrototype.scrollIntoView = function (this: Element) {
			shown.push(this);
		};
		try {
			await mount(<ProvidersSection />);
			await act(async () => button(translate("providers.editFor", { provider: "my-proxy" }))?.click());
			expect(text()).toContain(translate("providerCfg.title.edit"));
			await act(async () => button(translate("providerCfg.form.cancel"))?.click());
			expect(shown.at(-1)?.closest("[data-custom-provider]")?.getAttribute("data-custom-provider")).toBe("my-proxy");

			await act(async () => button(translate("providerList.addCustom"))?.click());
			await act(async () => button(translate("providerCfg.form.cancel"))?.click());
			expect(shown.at(-1)?.hasAttribute("data-custom-add")).toBe(true);
		} finally {
			elementPrototype.scrollIntoView = originalScroll;
		}
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

		await act(async () => button(translate("providers.picker.connect", { provider: "DeepSeek" }))?.click());
		expect(login).toHaveBeenCalledWith("deepseek");
		expect(useExtensionUiStore.getState().inlineLogins).toBe(1);

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
		// No callback server (no launchUrl): the link is a page to copy the key from, opened on a click only.
		expect(openExternal).not.toHaveBeenCalled();
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
		expect(useExtensionUiStore.getState().inlineLogins).toBe(0);
		expect(
			useToastStore
				.getState()
				.toasts.map(entry => entry.message)
				.join("\n"),
		).toContain(translate("providers.loginSuccess", { provider: "DeepSeek" }));
	});

	it("shows the sign-in's latest progress notice in the panel's status line", async () => {
		login.mockReturnValueOnce(Promise.withResolvers<RpcResponse>().promise);
		getProviders.mockResolvedValue(
			providersResponse(
				snapshot([row("anthropic", { name: "Anthropic", authenticated: false, loginAvailable: true })]),
			),
		);
		useSessionStore.setState({ status: "ready" });
		await mount(<ProvidersSection />);
		await act(async () => button(translate("providers.picker.connect", { provider: "Claude" }))?.click());
		const status = () => document.querySelector("[data-login-progress]")?.textContent ?? "";
		expect(status()).toBe(translate("providerList.login.starting"));

		await act(async () => {
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "progress-1",
				method: "notify",
				message: "Exchanging authorization code…",
				notifyType: "info",
			});
		});
		expect(status()).toBe("Exchanging authorization code…");
		// Consumed here, so no toast repeats it.
		expect(useExtensionUiStore.getState().pendingRequests).toEqual([]);
		expect(document.querySelector('[data-login-progress] [role="status"]')).toBeTruthy();
	});

	it("folds the picker away once a provider found there is connected", async () => {
		const pending = Promise.withResolvers<RpcResponse>();
		login.mockReturnValueOnce(pending.promise);
		const deepseek = row("deepseek", { name: "DeepSeek", authenticated: false, loginAvailable: true });
		getProviders.mockResolvedValue(providersResponse(snapshot([row("anthropic"), deepseek])));
		useSessionStore.setState({ status: "ready" });
		await mount(<ProvidersSection />);

		const add = button(translate("providers.add"));
		await act(async () => add?.click());
		expect(add?.getAttribute("aria-expanded")).toBe("true");
		await act(async () => button(translate("providers.picker.connect", { provider: "DeepSeek" }))?.click());
		await act(async () => {
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "key-1",
				method: "input",
				title: "Paste your DeepSeek API key",
			});
		});
		await typeInto(document.querySelector('input[type="password"]'), "sk-test");
		await act(async () => {
			document
				.querySelector('input[type="password"]')
				?.closest("form")
				?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});
		getProviders.mockResolvedValue(
			providersResponse(snapshot([row("anthropic"), { ...deepseek, authenticated: true, authKind: "apikey" }])),
		);
		await act(async () => {
			pending.resolve({ type: "response", command: "login", success: true });
		});

		expect(add?.getAttribute("aria-expanded")).toBe("false");
		expect(text()).not.toContain(translate("providerList.noMatch", { query: "" }).split('"')[0]);
		expect(text()).toContain("DeepSeek");
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
		await act(async () => button(translate("providers.picker.connect", { provider: "DeepSeek" }))?.click());
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

	it("honors Cancel before an API-key prompt arrives", async () => {
		const pending = Promise.withResolvers<RpcResponse>();
		login.mockReturnValueOnce(pending.promise);
		getProviders.mockResolvedValue(
			providersResponse(
				snapshot([row("deepseek", { name: "DeepSeek", authenticated: false, loginAvailable: true })]),
			),
		);
		useSessionStore.setState({ status: "ready" });
		await mount(<ProvidersSection />);
		await act(async () => button(translate("providers.picker.connect", { provider: "DeepSeek" }))?.click());
		await act(async () => button(translate("common.cancel"))?.click());
		expect(document.querySelector("[data-login-progress]")).toBeTruthy();
		expect(respondExtensionUi).not.toHaveBeenCalled();
		await act(async () =>
			useExtensionUiStore.getState().pushRequest({
				type: "extension_ui_request",
				id: "late-key",
				method: "input",
				title: "Paste your DeepSeek API key",
			}),
		);
		expect(respondExtensionUi).toHaveBeenCalledWith({
			type: "extension_ui_response",
			id: "late-key",
			cancelled: true,
		});
		expect(document.querySelector("[data-login-progress]")).toBeNull();
		await act(async () =>
			pending.resolve({ type: "response", command: "login", success: false, error: "Cancelled" }),
		);
		expect(text()).not.toContain(translate("providerList.login.failed", { provider: "DeepSeek" }));
	});

	describe("browser sign-in", () => {
		// Stock's login sequence (rpc-mode `login` over a callback-server flow, as
		// probed from omp 18.10.3): open_url with the loopback launch page, the
		// "waiting" progress notice, then the code paste raced against the callback.
		const openUrl = {
			type: "extension_ui_request",
			id: "url-1",
			method: "open_url",
			url: "https://claude.ai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback&state=xyz",
			launchUrl: "http://localhost:54545/launch",
			// rules/auth/anthropic.kdl
			instructions:
				"Complete login in your browser. If the browser cannot reach this machine, paste the final redirect URL or authorization code when prompted.",
		} as const;
		const pasteRequest = (id: string) =>
			({
				type: "extension_ui_request",
				id,
				method: "input",
				title: "Paste the authorization code (or full redirect URL):",
				timeout: 600_000,
			}) as const;
		let pendingLogin = Promise.withResolvers<RpcResponse>();

		async function startSignIn(
			device: string | undefined,
			extra: ReactElement | null = null,
			beforeRequests?: () => Promise<void>,
		): Promise<void> {
			pendingLogin = Promise.withResolvers<RpcResponse>();
			login.mockReturnValueOnce(pendingLogin.promise);
			getProviders.mockResolvedValue(
				providersResponse(
					snapshot([row("anthropic", { name: "Anthropic", authenticated: false, loginAvailable: true })]),
				),
			);
			useSessionStore.setState({ status: "ready" });
			focusTab(device);
			await mount(
				<>
					<ProvidersSection />
					{extra}
				</>,
			);
			await act(async () => button(translate("providers.picker.connect", { provider: "Claude" }))?.click());
			await beforeRequests?.();
			await act(async () => {
				useExtensionUiStore.getState().pushRequest(openUrl);
				useExtensionUiStore.getState().pushRequest({
					type: "extension_ui_request",
					id: "wait-1",
					method: "notify",
					message: "Waiting for browser authentication...",
					notifyType: "info",
				});
				useExtensionUiStore.getState().pushRequest(pasteRequest("code-1"));
			});
			// A paired host's tab leaves the browser to the button; a local one has opened it already.
			if (device !== undefined) await act(async () => button(translate("providerList.login.openBrowser"))?.click());
		}

		const pasteField = () => document.querySelector('input[type="password"]');
		const progress = () => document.querySelector("[data-login-progress]")?.textContent ?? "";
		const pendingIds = () => useExtensionUiStore.getState().pendingRequests.map(request => request.id);
		const cancelledIds = () =>
			respondExtensionUi.mock.calls
				.map(([response]) => response as { id: string; cancelled?: boolean })
				.filter(response => response.cancelled === true)
				.map(response => response.id);

		it("on a remote tab opens the provider's URL only on a click, not the host's launch page, and asks for the redirect", async () => {
			await startSignIn(HOST_ID);
			expect(openExternal).toHaveBeenCalledTimes(1);
			expect(openExternal).toHaveBeenCalledWith(openUrl.url);
			expect(openExternal).not.toHaveBeenCalledWith(openUrl.launchUrl);
			expect(document.querySelector("[data-remote-login-hint]")?.textContent).toBe(
				translate("providerList.login.remoteHint", { name: "Studio" }),
			);
			// The host's callback is unreachable from this browser, so the paste is open from the start.
			expect(text()).toContain(translate("providerList.login.pasteLabel"));
			expect(pasteField()).toBeTruthy();
		});

		it("on a web viewer's local-host tab opens the provider page only on a click and shows the paste fallback", async () => {
			viewer.web = true;
			await startSignIn(undefined);
			expect(openExternal).not.toHaveBeenCalled();
			expect(pasteField()).toBeTruthy();
			expect(text()).toContain(translate("providerList.login.pasteHint"));
			expect(button(translate("providerList.login.pasteToggle"))).toBeUndefined();

			await act(async () => button(translate("providerList.login.openBrowser"))?.click());
			expect(openExternal).toHaveBeenCalledExactlyOnceWith(openUrl.url);
			expect(openExternal).not.toHaveBeenCalledWith(openUrl.launchUrl);
		});

		it("sends a pasted answer once while delivery is pending and allows retry after refusal", async () => {
			await startSignIn(HOST_ID);
			const delivery = Promise.withResolvers<void>();
			respondExtensionUi.mockReturnValueOnce(delivery.promise);
			await typeInto(pasteField(), "test-code");
			const form = pasteField()?.closest("form");
			await act(async () => {
				form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
				form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
			});
			expect(
				respondExtensionUi.mock.calls.filter(([response]) => response.id === "code-1" && response.value),
			).toHaveLength(1);
			expect(pasteField()).toBeTruthy();

			await act(async () => delivery.reject(new Error("Host is disconnected")));
			expect(text()).toContain(translate("providerList.login.pasteLabel"));
			expect(
				useToastStore.getState().toasts.some(entry => entry.title === translate("extDialog.answerFailed")),
			).toBe(true);
			await act(async () => form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
			expect(
				respondExtensionUi.mock.calls.filter(([response]) => response.id === "code-1" && response.value),
			).toHaveLength(2);
			expect(pasteField()).toBeNull();
		});

		it("does not clear a replacement prompt when the previous answer finishes delivery", async () => {
			await startSignIn(HOST_ID);
			const delivery = Promise.withResolvers<void>();
			respondExtensionUi.mockReturnValueOnce(delivery.promise);
			await typeInto(pasteField(), "first-code");
			await act(async () =>
				pasteField()
					?.closest("form")
					?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
			);
			await act(async () => {
				useExtensionUiStore.getState().pushRequest(pasteRequest("code-2"));
			});
			await act(async () => delivery.resolve());
			expect(pasteField()).toBeTruthy();
			await typeInto(pasteField(), "second-code");
			await act(async () =>
				pasteField()
					?.closest("form")
					?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
			);
			expect(respondExtensionUi).toHaveBeenLastCalledWith(
				{ type: "extension_ui_response", id: "code-2", value: "second-code" },
				"t1",
			);
		});

		it("on a local tab opens the launch page by itself, once, and shows no paste hint", async () => {
			await startSignIn(undefined);
			expect(openExternal).toHaveBeenCalledTimes(1);
			expect(openExternal).toHaveBeenCalledWith(openUrl.launchUrl);
			expect(document.querySelector("[data-remote-login-hint]")).toBeNull();
			// The code prompt beside an OAuth callback does not turn the browser sign-in into a key page.
			expect(button(translate("providerList.login.openKeyPage"))).toBeUndefined();
		});

		it("keeps waiting for the browser first; the code paste is an optional, localized fallback below it", async () => {
			await startSignIn(undefined);
			// Stock's English progress line reads in the UI language.
			expect(progress()).toBe(translate("providerList.login.waiting"));
			expect(text()).not.toContain("Paste the authorization code");
			// Stock's English instructions, which send the user to the paste, give way to the panel's own line.
			expect(text()).not.toContain("when prompted");
			expect(text()).toContain(translate("providerList.login.browser", { provider: "Claude" }));
			expect(pasteField()).toBeNull();
			const toggle = button(translate("providerList.login.pasteToggle"));
			expect(toggle?.getAttribute("aria-expanded")).toBe("false");

			await act(async () => toggle?.click());
			expect(toggle?.getAttribute("aria-expanded")).toBe("true");
			expect(text()).toContain(translate("providerList.login.pasteHint"));
			expect(text()).toContain(translate("providerList.login.pasteLabel"));
			// Still waiting for the browser beside the open fallback.
			expect(progress()).toBe(translate("providerList.login.waiting"));
			await typeInto(pasteField(), "http://localhost:54545/callback?code=abc&state=xyz");
			await act(async () => {
				pasteField()
					?.closest("form")
					?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
			});
			expect(respondExtensionUi).toHaveBeenCalledWith(
				{
					type: "extension_ui_response",
					id: "code-1",
					value: "http://localhost:54545/callback?code=abc&state=xyz",
				},
				"t1",
			);
		});

		it("dismisses stock's paste request once the callback signed in, so it never reaches the chat", async () => {
			await startSignIn(undefined, <ExtensionDialog />);
			expect(document.querySelector("[data-prompt-countdown]")).toBeNull();
			await act(async () => {
				pendingLogin.resolve({ type: "response", command: "login", success: true });
			});
			// Stock leaves its raced paste request open (no `cancel` frame); answering it now is a no-op for omp.
			expect(cancelledIds()).toEqual(["code-1"]);
			expect(pendingIds()).toEqual([]);
			expect(text()).not.toContain("Paste the authorization code");
			expect(button(translate("extDialog.submit"))).toBeUndefined();
		});

		it("closing the panel mid-sign-in keeps stock's paste request out of the chat until the login answers", async () => {
			await startSignIn(undefined);
			// Mounted after the section: a root's first commit clears its container (here the body).
			const chat = document.createElement("div");
			document.body.appendChild(chat);
			const chatRoot = createRoot(chat as unknown as Element);
			roots.push(chatRoot);
			await act(async () =>
				chatRoot.render(
					<I18nProvider>
						<ExtensionDialog />
					</I18nProvider>,
				),
			);
			// Settings closes while the browser sign-in is still open.
			await act(async () => roots[0]?.unmount());
			expect(pendingIds()).toContain("code-1");
			expect(chat.textContent ?? "").not.toContain("Paste the authorization code");
			expect(chat.querySelector("[data-prompt-countdown]")).toBeNull();

			await act(async () => {
				pendingLogin.resolve({ type: "response", command: "login", success: true });
			});
			expect(cancelledIds()).toEqual(["code-1"]);
			expect(pendingIds()).toEqual([]);
			expect(chat.textContent ?? "").toBe("");
		});

		it.each([undefined, HOST_ID])("honors Cancel before the browser link arrives on %s", async device => {
			await startSignIn(device, null, async () => {
				await act(async () => button(translate("common.cancel"))?.click());
				expect(progress()).toBe(translate("providerList.login.starting"));
				expect(cancelLogin).not.toHaveBeenCalled();
			});
			expect(cancelLogin).toHaveBeenCalledExactlyOnceWith(openUrl.url);
			expect(openExternal).not.toHaveBeenCalled();
			expect(document.querySelector("[data-login-progress]")).toBeNull();
			await act(async () =>
				pendingLogin.resolve({ type: "response", command: "login", success: false, error: "Cancelled" }),
			);
			expect(text()).not.toContain(translate("providerList.login.failed", { provider: "Claude" }));
			expect(cancelledIds()).toEqual(["code-1"]);
		});

		it("cancel ends stock's login through its callback instead of answering the paste request", async () => {
			await startSignIn(undefined, <ExtensionDialog />);
			await act(async () => button(translate("common.cancel"))?.click());
			expect(cancelLogin).toHaveBeenCalledWith(openUrl.url);
			// An empty answer would only make stock ask again (its manual-code loop).
			expect(cancelledIds()).toEqual([]);
			expect(document.querySelector("[data-login-progress]")).toBeNull();
			// A re-asked paste request while stock winds down stays out of the chat.
			await act(async () => useExtensionUiStore.getState().pushRequest(pasteRequest("code-2")));
			expect(text()).not.toContain("Paste the authorization code");

			await act(async () => {
				pendingLogin.resolve({
					type: "response",
					command: "login",
					success: false,
					error: "Authorization failed: Cancelled in OMPdesk",
				});
			});
			expect(cancelledIds()).toEqual(["code-1", "code-2"]);
			expect(pendingIds()).toEqual([]);
			// The user cancelled: no failure banner.
			expect(text()).not.toContain(translate("providerList.login.failed", { provider: "Claude" }));

			// A new sign-in starts clean: it waits for the browser again.
			pendingLogin = Promise.withResolvers<RpcResponse>();
			login.mockReturnValueOnce(pendingLogin.promise);
			await act(async () => button(translate("providers.picker.connect", { provider: "Claude" }))?.click());
			await act(async () => useExtensionUiStore.getState().pushRequest(openUrl));
			expect(progress()).toBe(translate("providerList.login.waiting"));
		});

		describe("after a reload mid-sign-in", () => {
			// The page lost the `login` call; main still runs it and hands the sign-in back.
			async function reloadMidSignIn(endedError?: string): Promise<void> {
				getProviders.mockResolvedValue(
					providersResponse(
						snapshot([row("anthropic", { name: "Anthropic", authenticated: false, loginAvailable: true })]),
					),
				);
				useSessionStore.setState({ status: "ready" });
				focusTab(undefined);
				const store = useExtensionUiStore.getState();
				store.adoptLogin({ active: true, providerId: "anthropic", link: openUrl });
				store.restoreLoginRequest(pasteRequest("code-1"));
				if (endedError) store.settleAdoptedLogin(endedError);
				await mount(<ProvidersSection />);
			}

			it("shows an adopted failure even when the panel first mounts after the login ended", async () => {
				await reloadMidSignIn("Authorization failed before the panel opened");
				expect(text()).toContain("Authorization failed before the panel opened");
				expect(button(translate("providerList.login.retry"))).toBeDefined();
				expect(login).not.toHaveBeenCalled();
				await act(async () => button(translate("providerList.login.retry"))?.click());
				expect(login).toHaveBeenCalledWith("anthropic");
			});

			it("restores the paste fallback on a web viewer without opening a browser", async () => {
				viewer.web = true;
				await reloadMidSignIn();
				expect(login).not.toHaveBeenCalled();
				expect(openExternal).not.toHaveBeenCalled();
				expect(pasteField()).toBeTruthy();
				expect(button(translate("providerList.login.pasteToggle"))).toBeUndefined();
				await act(async () => button(translate("providerList.login.openBrowser"))?.click());
				expect(openExternal).toHaveBeenCalledExactlyOnceWith(openUrl.url);
			});

			it("shows the sign-in again with its browser link, the paste fallback and Cancel", async () => {
				await reloadMidSignIn();
				expect(login).not.toHaveBeenCalled();
				expect(progress()).toBe(translate("providerList.login.inProgress"));
				expect(button(translate("providerList.login.openBrowser"))).toBeDefined();
				// A sign-in this page did not start never opens the browser again by itself.
				expect(openExternal).not.toHaveBeenCalled();
				expect(button(translate("providerList.login.pasteToggle"))).toBeDefined();
				expect(button(translate("common.cancel"))).toBeDefined();
				// The leftover request stays the panel's: nothing is answered while the sign-in runs.
				expect(respondExtensionUi).not.toHaveBeenCalled();

				await act(async () => button(translate("common.cancel"))?.click());
				expect(cancelLogin).toHaveBeenCalledWith(openUrl.url);
				expect(document.querySelector("[data-login-progress]")).toBeNull();
				// Cancelling does not bring it back while main winds the login down.
				expect(useExtensionUiStore.getState().adoptedLogin?.hidden).toBe(true);
			});

			it("a Cancel after a reload ends quietly when main's login answers cancelled: no failure, the paste cancelled once", async () => {
				await reloadMidSignIn();
				await act(async () => button(translate("common.cancel"))?.click());
				await act(async () => {
					for (const request of useExtensionUiStore
						.getState()
						.settleAdoptedLogin("Authorization failed: Cancelled in OMPdesk"))
						void respondExtensionUi({ type: "extension_ui_response", id: request.id, cancelled: true });
				});
				expect(text()).not.toContain(translate("providerList.login.failed", { provider: "Claude" }));
				expect(cancelledIds()).toEqual(["code-1"]);
			});

			it("reloads the providers when main reports the sign-in connected, and cancels the leftover paste", async () => {
				await reloadMidSignIn();
				listProviders.mockClear();
				await act(async () => {
					for (const request of useExtensionUiStore.getState().settleAdoptedLogin(null))
						void respondExtensionUi({ type: "extension_ui_response", id: request.id, cancelled: true });
				});
				expect(document.querySelector("[data-login-progress]")).toBeNull();
				expect(cancelledIds()).toEqual(["code-1"]);
				expect(useExtensionUiStore.getState().adoptedLogin).toBeNull();
				expect(listProviders).toHaveBeenCalled();
			});

			it("shows main's failure for the sign-in with a retry", async () => {
				await reloadMidSignIn();
				await act(async () => {
					useExtensionUiStore.getState().settleAdoptedLogin("Authorization failed: denied");
				});
				expect(text()).toContain(translate("providerList.login.failed", { provider: "Claude" }));
				expect(text()).toContain("Authorization failed: denied");
				expect(button(translate("providerList.login.retry"))).toBeDefined();
			});
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
	}

	it("groups a provider's accounts under one header, open, without a toggle", async () => {
		await mountWithAccounts();
		expect(document.querySelector("[data-provider-list] [aria-controls]")).toBeNull();
		const groups = Array.from(document.querySelectorAll("[data-provider-list] > li"));
		expect(groups.map(item => item.getAttribute("data-provider-row"))).toEqual(["anthropic"]);
		const items = Array.from(groups[0].querySelectorAll("[data-provider-accounts] > li"));
		expect(items.map(item => item.getAttribute("data-provider-account"))).toEqual(["7", "9"]);
		// The brand and the mark sit once, on the header; the account rows repeat neither.
		expect(groups[0].querySelectorAll("[data-provider-mark]").length).toBe(1);
		expect(groups[0].querySelectorAll("[data-provider-name]").length).toBe(1);
		expect(groups[0].querySelector("[data-provider-name]")?.textContent).toBe("Claude");
		expect(groups[0].querySelector("[data-provider-head]")?.textContent).toContain(
			translate("providers.accounts.count", { count: 2 }),
		);
		expect(items.every(item => item.querySelector("[data-provider-mark]") === null)).toBe(true);
		expect(getProviderAccounts).toHaveBeenCalledTimes(1);
	});

	it("shows the plan stock's live name carries, so a rename needs no OMPdesk change", async () => {
		const renamed = row("anthropic", {
			name: "Anthropic (Claude Ultra)",
			authKind: "oauth",
			loginAvailable: true,
		});
		getProviders.mockResolvedValue(providersResponse(snapshot([renamed])));
		getProviderAccounts.mockResolvedValue({
			type: "response",
			command: "get_provider_accounts",
			success: true,
			data: { providerId: "anthropic", accounts: [accounts[0]] },
		});
		useSessionStore.setState({ status: "ready" });
		await mount(<ProvidersSection />);
		const head = document.querySelector("[data-provider-head]");
		expect(head?.querySelector("[data-provider-name]")?.textContent).toBe("Claude");
		expect(head?.textContent).toContain("Ultra");
		expect(head?.querySelector("[title]")?.getAttribute("title")).toBe("Anthropic (Claude Ultra)");
	});

	it("sorts the open list by company, one row per provider, each with its real mark or the neutral glyph", async () => {
		getProviders.mockResolvedValue(
			providersResponse(
				snapshot([
					row("openrouter", { name: "OpenRouter" }),
					row("acme", { name: "Acme Gateway" }),
					row("openai-codex", { name: "OpenAI Codex" }),
					row("anthropic", { name: "Anthropic" }),
					row("openai", { name: "OpenAI" }),
				]),
			),
		);
		useSessionStore.setState({ status: "ready" });
		await mount(<ProvidersSection />);
		const rows = Array.from(document.querySelectorAll("[data-provider-list] > li"));
		expect(rows.map(item => item.getAttribute("data-provider-row"))).toEqual([
			"acme",
			"anthropic",
			"openai",
			"openai-codex",
			"openrouter",
		]);
		expect(rows.map(item => item.querySelector("[data-provider-mark]")?.getAttribute("data-provider-mark"))).toEqual([
			"fallback",
			"anthropic",
			"openai",
			"openai",
			"openrouter",
		]);
	});

	it("lists every account in one row with its tightest quota, the one in use and the one skipped until reset", async () => {
		await mountWithAccounts();
		expect(getProviderAccounts).toHaveBeenCalledWith("anthropic", false);
		const body = text();
		expect(body).toContain("work@example.com");
		expect(body).toContain("home@example.com");
		expect(body).toContain(translate("providers.accounts.inUse"));
		expect(body.split(translate("providers.accounts.inUse")).length).toBe(2);
		expect(body.split(translate("providers.state.signedIn")).length).toBe(3);
		// Both windows as gauges with the share used inside, the short window first.
		const gaugeText = (account: string) =>
			Array.from(document.querySelectorAll(`[data-provider-account="${account}"] .omp-usage-gauge-text`)).map(
				gauge => gauge.textContent,
			);
		expect(gaugeText("7")).toEqual(["5H6%", "7D61%"]);
		const bars = Array.from(document.querySelectorAll('[data-provider-account="7"] [role="progressbar"]'));
		expect(bars.map(bar => bar.getAttribute("aria-valuenow"))).toEqual(["6", "61"]);
		expect(body).toContain(translate("providers.accounts.limitedUntil", { time: formatClock(limitedUntil) }));
		// The account-switching mode sits with the accounts, for this device's omp.
		expect(document.querySelector('[data-models-rotation] [role="radiogroup"]')).toBeTruthy();
		expect(accountRotationGet).toHaveBeenLastCalledWith(undefined);
	});

	it("signs out of every account from any account's menu", async () => {
		await mountWithAccounts();
		await chooseAction("Anthropic", translate("providers.logoutAll"));
		expect(text()).toContain(translate("providers.logoutTitle", { provider: "Claude" }));
	});

	it("removes only the chosen account, by its credentialId, after confirming", async () => {
		await mountWithAccounts();
		getProviders.mockClear();
		await chooseAction(
			"Anthropic home@example.com",
			translate("providers.accounts.remove", { account: "home@example.com" }),
		);
		expect(logout).not.toHaveBeenCalled();
		expect(text()).toContain(
			translate("providers.accounts.removeBody", { account: "home@example.com", provider: "Claude" }),
		);
		await act(async () => button(translate("providers.accounts.removeConfirm"))?.click());

		expect(logout).toHaveBeenCalledWith("anthropic", 9);
		expect(disconnectProvider).not.toHaveBeenCalled();
		expect(getProviders).toHaveBeenCalledWith(true);
	});

	it("warns that removing the last account disconnects the provider", async () => {
		await mountWithAccounts([accounts[0]]);
		await chooseAction(
			"Anthropic work@example.com",
			translate("providers.accounts.remove", { account: "work@example.com" }),
		);
		expect(text()).toContain(
			translate("providers.accounts.removeLastBody", { account: "work@example.com", provider: "Claude" }),
		);
		await act(async () => button(translate("providers.accounts.removeConfirm"))?.click());
		expect(logout).toHaveBeenCalledWith("anthropic", 7);
	});

	it("adds another account through the same sign-in flow", async () => {
		await mountWithAccounts();
		await act(async () => button(translate("providers.accounts.addTo", { provider: "Anthropic" }))?.click());
		expect(login).toHaveBeenCalledWith("anthropic");
	});

	it("says how old each account's quota is and when each window resets", async () => {
		const now = Date.now();
		await mountWithAccounts([
			{
				...accounts[0],
				fetchedAt: now - 5_000,
				limits: [
					{
						id: "anthropic:5h",
						label: "Claude 5 Hour",
						usedFraction: 0.06,
						resetsAt: now + 3 * 3_600_000 + 30_000,
					},
				],
			},
		]);
		// The age sits in the quota's tooltip, next to every window's reset; the row shows the tightest reset.
		const cell = document.querySelector("[data-quota-updated]");
		expect(cell?.getAttribute("title")).toMatch(/Updated [5-7]s ago/);
		const reset = document.querySelector(".omp-usage-gauge-reset");
		expect(reset?.textContent).toBe("↻ 3h");
		// The full localized text stays as the tooltip and the accessible name.
		expect(reset?.getAttribute("title")).toBe(translate("usage.resetsIn", { time: "3h 0m" }));
		expect(reset?.getAttribute("aria-label")).toBe(translate("usage.resetsIn", { time: "3h 0m" }));
	});

	it("refreshes through the bridge's stock invalidate, while the live poll reads stock's cache", async () => {
		await mountWithAccounts();
		expect(getProviderAccounts).toHaveBeenLastCalledWith("anthropic", false);
		await chooseAction("Anthropic", translate("providers.accounts.refresh", { provider: "Claude" }));
		expect(getProviderAccounts).toHaveBeenLastCalledWith("anthropic", true);
	});

	it("keeps the open list live: a later read replaces the quota without reopening", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			await mountWithAccounts();
			const calls = getProviderAccounts.mock.calls.length;
			getProviderAccounts.mockResolvedValue({
				type: "response",
				command: "get_provider_accounts",
				success: true,
				data: {
					providerId: "anthropic",
					accounts: [
						{ ...accounts[0], limits: [{ id: "anthropic:5h", label: "Claude 5 Hour", usedFraction: 0.5 }] },
					],
				},
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(USAGE_POLL_MS);
			});
			expect(getProviderAccounts.mock.calls.length).toBe(calls + 1);
			expect(document.querySelector(".omp-usage-gauge-text")?.textContent).toBe("5H50%");
		} finally {
			vi.useRealTimers();
		}
	});

	it("lists no accounts for a provider signed in with an API key", async () => {
		getProviders.mockResolvedValue(
			providersResponse(snapshot([row("deepseek", { authKind: "apikey", loginAvailable: true })])),
		);
		useSessionStore.setState({ status: "ready" });
		await mount(<ProvidersSection />);
		expect(getProviderAccounts).not.toHaveBeenCalled();
		expect(document.querySelector("[data-provider-add]")).toBeNull();
		expect(document.querySelector("[data-models-rotation]")).toBeNull();
	});
});
