import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { CustomProviderView } from "../../../shared/ipc-types";
import type { ProviderInfo, RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";
import { useUiStore } from "../../stores/ui";
import { Modal } from "../common";
import { FirstRunOnboardingDialog, hasUsableModelProvider } from "./FirstRunOnboardingDialog";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};

interface MockOmp {
	rpc: {
		getProviders: Mock<() => Promise<RpcResponse>>;
	};
	models: {
		listProviders: Mock<() => Promise<CustomProviderView[]>>;
	};
}

function success(providers: ProviderInfo[]): RpcResponse {
	return { type: "response", command: "test", success: true, data: { providers } };
}

function provider(partial: Partial<ProviderInfo> & { id: string }): ProviderInfo {
	return {
		name: partial.id,
		authenticated: false,
		loginAvailable: true,
		disabled: false,
		modelCount: 0,
		...partial,
	};
}

function config(partial: Partial<CustomProviderView> & { id: string }): CustomProviderView {
	return {
		api: "openai-completions",
		baseUrl: "https://api.example.com/v1",
		hasApiKey: false,
		models: [{ id: "model-id" }],
		builtin: false,
		...partial,
	};
}

function installMockOmp(providers: ProviderInfo[] = [], configs: CustomProviderView[] = []): MockOmp {
	const omp: MockOmp = {
		rpc: { getProviders: vi.fn(async () => success(providers)) },
		models: { listProviders: vi.fn(async () => configs) },
	};
	const testWindow = window as unknown as { omp: MockOmp };
	testWindow.omp = omp;
	return omp;
}

let container: InstanceType<typeof HTMLElement> | null = null;
let root: Root | null = null;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => {
		root?.render(<I18nProvider>{element}</I18nProvider>);
	});
	await flush();
}

function buttonNamed(text: string): HTMLButtonElement {
	const button = [...document.querySelectorAll("button")].find(candidate => candidate.textContent?.includes(text));
	if (!(button instanceof HTMLElement)) throw new Error(`Button not found: ${text}`);
	return button as HTMLButtonElement;
}

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	container?.remove();
	container = null;
	root = null;
	useSessionStore.getState().reset();
	useUiStore.getState().closeProviders();
	useUiStore.getState().closeProviderConfig();
});

describe("hasUsableModelProvider", () => {
	it("requires an enabled provider with both credentials and a model", () => {
		expect(hasUsableModelProvider([], [])).toBe(false);
		expect(hasUsableModelProvider([provider({ id: "openai", authenticated: true, modelCount: 0 })], [])).toBe(false);
		expect(
			hasUsableModelProvider([provider({ id: "openai", authenticated: true, modelCount: 1, disabled: true })], []),
		).toBe(false);
		expect(hasUsableModelProvider([provider({ id: "openai", authenticated: true, modelCount: 1 })], [])).toBe(true);
	});

	it("requires inventory-confirmed models for custom API-key and no-auth providers", () => {
		const gateway = config({ id: "gateway", hasApiKey: true });
		const local = config({ id: "ollama-local", auth: "none" });
		expect(hasUsableModelProvider([], [gateway])).toBe(false);
		expect(hasUsableModelProvider([provider({ id: "gateway", authenticated: true, modelCount: 1 })], [gateway])).toBe(
			true,
		);
		expect(hasUsableModelProvider([provider({ id: "ollama-local", modelCount: 1 })], [local])).toBe(true);
		expect(hasUsableModelProvider([provider({ id: "ollama-local", modelCount: 0 })], [local])).toBe(false);
	});
});

describe("FirstRunOnboardingDialog", () => {
	it("keeps the user's settings dialog accessible when the startup readiness check finishes late", async () => {
		const omp = installMockOmp();
		const pending = Promise.withResolvers<RpcResponse>();
		omp.rpc.getProviders.mockReturnValue(pending.promise);
		useSessionStore.getState().setStatus("ready", "/tmp/project");
		await mount(
			<>
				<FirstRunOnboardingDialog />
				<Modal open onClose={() => {}} title="Settings">
					Current settings
				</Modal>
			</>,
		);
		await act(async () => pending.resolve(success([])));
		await flush();
		expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
		expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Current settings");
	});

	it("opens for an empty profile, links both setup surfaces, and closes after readiness succeeds", async () => {
		const omp = installMockOmp();
		useSessionStore.getState().setStatus("ready", "/tmp/project");
		await mount(<FirstRunOnboardingDialog />);

		expect(document.body.textContent ?? "").toContain("Connect a model before your first session");
		await act(async () => buttonNamed("Open Providers & Login").click());
		expect(useUiStore.getState().providersOpen).toBe(true);
		await act(async () => buttonNamed("Configure custom provider").click());
		expect(useUiStore.getState().providerConfigOpen).toBe(true);

		omp.rpc.getProviders.mockResolvedValue(
			success([provider({ id: "deepseek", authenticated: true, modelCount: 2 })]),
		);
		await act(async () => buttonNamed("I've configured it").click());
		await flush();
		// The modal lingers ~240ms for its exit animation before unmounting.
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 300));
		});
		expect(document.body.textContent ?? "").not.toContain("Connect a model before your first session");
	});

	it("does not interrupt startup when a runnable provider already exists", async () => {
		installMockOmp([provider({ id: "anthropic", authenticated: true, modelCount: 3 })]);
		useSessionStore.getState().setStatus("ready", "/tmp/project");
		await mount(<FirstRunOnboardingDialog />);
		expect(document.body.textContent ?? "").not.toContain("Connect a model before your first session");
	});
});
