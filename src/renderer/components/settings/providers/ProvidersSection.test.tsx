import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CustomProviderView } from "../../../../shared/ipc-types";
import type { ModelCatalogUpdateFrame, ProviderInfo, ProvidersResult, RpcResponse } from "../../../../shared/rpc-types";
import { I18nProvider, translate } from "../../../lib/i18n";
import { useExtensionUiStore } from "../../../stores/extension-ui";
import { useModelStore } from "../../../stores/model";
import { useSessionStore } from "../../../stores/session";
import { useToastStore } from "../../../stores/toast";
import { useUiStore } from "../../../stores/ui";
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
const login = vi.fn(async (): Promise<RpcResponse> => ({ type: "response", command: "login", success: true }));
const listProviders = vi.fn(async (): Promise<CustomProviderView[]> => []);
const respondExtensionUi = vi.fn();

Object.assign(window as unknown as Record<string, unknown>, {
	omp: {
		rpc: { getProviders, logout, login },
		models: { listProviders },
		ui: { respondExtensionUi },
		system: { openExternal: vi.fn(async () => {}) },
	},
});

const text = () => document.body.textContent ?? "";

function button(name: string): HTMLButtonElement | undefined {
	return Array.from(document.body.querySelectorAll("button")).find(
		candidate => (candidate.textContent ?? "").trim() === name || candidate.getAttribute("aria-label") === name,
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
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
	await act(async () => {
		await delay(0);
	});
	roots.push(root);
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
	getProviders.mockReset();
	getProviders.mockResolvedValue(providersResponse(snapshot([row("anthropic")])));
	listProviders.mockReset();
	listProviders.mockResolvedValue([]);
	logout.mockClear();
	login.mockReset();
	login.mockResolvedValue({ type: "response", command: "login", success: true });
	respondExtensionUi.mockClear();
});

describe("ProviderRow", () => {
	const handlers = { onConnect: () => {}, onLogout: () => {}, onEditConfig: () => {}, onDeleteConfig: () => {} };
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

	it("offers editing rather than sign-out when models.yml supplies the key", () => {
		// Signing out clears the credential store, but the reload re-installs the
		// key written in models.yml — a sign-out there can never change the row.
		const html = render(row("infronai"), config("infronai"));
		expect(html).toContain(translate("providers.edit"));
		expect(html).toContain(translate("providerCfg.list.delete"));
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
		getProviders
			.mockResolvedValueOnce(
				providersResponse(snapshot([row("my-proxy", { name: "My Proxy" })], { refreshPending: true })),
			)
			.mockResolvedValue(
				providersResponse(snapshot([row("my-proxy", { name: "My Proxy", modelCount: 12 })], { generation: 2 })),
			);
		useSessionStore.setState({ status: "ready" });
		await mount(<ProvidersSection pollMs={25} />);
		expect(text()).toContain(translate("providers.refreshPending"));

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

		expect(logout).toHaveBeenCalledWith("my-proxy");
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
		expect(logout).not.toHaveBeenCalled();
	});

	it("reports a failed catalog read instead of an empty list", async () => {
		getProviders.mockRejectedValueOnce(new Error("socket hang up"));
		useSessionStore.setState({ status: "ready" });
		await mount(<ProvidersSection />);
		expect(text()).toContain("socket hang up");
		expect(text()).toContain(translate("providers.loadFailed"));
	});

	it("names a models.yml provider the sidecar lists no models for", async () => {
		listProviders.mockResolvedValueOnce([config("my-proxy")]);
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
});
