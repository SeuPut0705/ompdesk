import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureProviderOptions } from "../../../../e2e/models-config-fixture";
import type { CustomProvidersConfig } from "../../../shared/ipc-types";
import type { ModelInfo, ProviderInfo, ProvidersResult, RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { useFirstRunStore } from "../../stores/first-run";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { useToastStore } from "../../stores/toast";
import { FirstRunGate } from "./FirstRunGate";
import { FirstRunSetup } from "./FirstRunSetup";

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

function ok(command: string, data: unknown): RpcResponse {
	return { type: "response", command, success: true, data };
}

function provider(partial: Partial<ProviderInfo> & { id: string }): ProviderInfo {
	return { name: partial.id, authenticated: false, loginAvailable: true, disabled: false, modelCount: 0, ...partial };
}

const acme = provider({ id: "acme", name: "Acme", authenticated: true, loginAvailable: false, modelCount: 2 });
const apple = provider({ id: "apple", loginAvailable: false, modelCount: 1 });
const anthropic = provider({ id: "anthropic", name: "Anthropic (Claude Pro/Max)" });
const onDevice: ModelInfo = { provider: "apple", id: "on-device", name: "On-device", contextWindow: 8_192 };
const opus: ModelInfo = { provider: "acme", id: "acme-opus-5", name: "Acme Opus 5", contextWindow: 200_000 };

let catalog: ProvidersResult = { providers: [], models: [], discoveryStates: [], refreshPending: false, generation: 1 };
let defaultRole: string | undefined;
const rpc = {
	getProviders: vi.fn(async () => ok("get_providers", catalog)),
	getAvailableModels: vi.fn(async () => ok("get_available_models", catalog)),
	getModelRoles: vi.fn(async () => ok("get_model_roles", { roles: [{ id: "default", model: defaultRole }] })),
	setModel: vi.fn(async (provider: string, id: string) => ok("set_model", { provider, id })),
	setModelRole: vi.fn(async () => ok("set_model_role", {})),
	login: vi.fn(async () => ok("login", {})),
};
const listProviders = vi.fn(
	async (): Promise<CustomProvidersConfig> => ({ providers: [], options: fixtureProviderOptions }),
);
Object.assign(window as unknown as Record<string, unknown>, {
	omp: { rpc, models: { listProviders }, ui: { respondExtensionUi: vi.fn() }, system: { openExternal: vi.fn() } },
});

const text = () => document.body.textContent ?? "";
function button(name: string): HTMLButtonElement | undefined {
	return Array.from(document.body.querySelectorAll("button")).find(
		candidate => (candidate.textContent ?? "").trim() === name,
	) as HTMLButtonElement | undefined;
}

function delay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

const roots: Root[] = [];
async function mount(element: ReactElement): Promise<void> {
	const root = createRoot(document.body as unknown as Element);
	await act(async () => root.render(<I18nProvider>{element}</I18nProvider>));
	await act(async () => delay(0));
	await act(async () => delay(0));
	roots.push(root);
}

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots.length = 0;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useFirstRunStore.getState().reset();
	useModelStore.getState().reset();
	useSessionStore.getState().reset();
	useToastStore.setState({ toasts: [] });
	for (const fn of Object.values(rpc)) fn.mockClear();
	defaultRole = undefined;
});

describe("FirstRunGate", () => {
	it("starts the inline setup when no provider can serve (a keyless on-device model does not count)", async () => {
		catalog = { ...catalog, providers: [apple, anthropic], models: [onDevice] };
		useSessionStore.getState().setStatus("ready", "/tmp/project");
		await mount(
			<>
				<FirstRunGate />
				<FirstRunSetup />
			</>,
		);
		expect(useFirstRunStore.getState().phase).toBe("connect");
		expect(text()).toContain(translate("setup.title"));
		expect(text()).toContain("Anthropic (Claude Pro/Max)");
		expect(document.querySelector('[role="dialog"]')).toBeNull();

		await act(async () => button(translate("setup.later"))?.click());
		expect(useFirstRunStore.getState().phase).toBe("idle");
		expect(text()).not.toContain(translate("setup.title"));
	});

	it("moves a session off the on-device model when a connected provider exists, and pins the default", async () => {
		catalog = { ...catalog, providers: [acme, apple], models: [onDevice, opus] };
		useModelStore.setState({ model: onDevice });
		useSessionStore.getState().setStatus("ready", "/tmp/project");
		await mount(<FirstRunGate />);

		expect(useFirstRunStore.getState().phase).toBe("idle");
		expect(rpc.setModel).toHaveBeenCalledWith("acme", "acme-opus-5");
		expect(rpc.setModelRole).toHaveBeenCalledWith("default", "acme/acme-opus-5");
		expect(useToastStore.getState().toasts.map(toast => toast.title)).toContain(
			translate("setup.defaultSwitched.title"),
		);
	});

	it("leaves a saved default alone", async () => {
		catalog = { ...catalog, providers: [acme, apple], models: [onDevice, opus] };
		defaultRole = "apple/on-device";
		useModelStore.setState({ model: onDevice });
		useSessionStore.getState().setStatus("ready", "/tmp/project");
		await mount(<FirstRunGate />);
		expect(rpc.setModel).not.toHaveBeenCalled();
		expect(rpc.setModelRole).not.toHaveBeenCalled();
	});
});

describe("FirstRunSetup model step", () => {
	it("offers only models that can serve and saves the choice as the default", async () => {
		catalog = { ...catalog, providers: [acme, apple], models: [onDevice, opus] };
		useSessionStore.getState().setStatus("ready", "/tmp/project");
		useFirstRunStore.getState().setPhase("model", "acme");
		await mount(<FirstRunSetup />);

		expect(text()).toContain("Acme Opus 5");
		expect(text()).not.toContain("On-device");
		expect(text()).toContain(translate("modelPicker.badge.recommended"));

		await act(async () => button(translate("setup.model.use"))?.click());
		expect(rpc.setModel).toHaveBeenCalledWith("acme", "acme-opus-5");
		expect(rpc.setModelRole).toHaveBeenCalledWith("default", "acme/acme-opus-5");
		expect(useFirstRunStore.getState().phase).toBe("idle");
		expect(useToastStore.getState().toasts.map(toast => toast.title)).toContain(translate("setup.ready.title"));
	});
});
