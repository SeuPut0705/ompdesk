import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureProviderOptions } from "../../../../e2e/models-config-fixture";
import type { CustomProvidersConfig } from "../../../shared/ipc-types";
import type { ModelInfo, ProviderInfo, ProvidersResult, RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { FIRST_RUN_STEP_PREF, useFirstRunStore } from "../../stores/first-run";
import { useGithubAuthStore } from "../../stores/github-auth";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { useToastStore } from "../../stores/toast";
import { fakeGithubAuth, githubState } from "../../test-support/github-auth";
import { routeCommands } from "../../test-support/route-commands";
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
const rpc = routeCommands({
	getProviders: vi.fn(async () => ok("get_providers", catalog)),
	getAvailableModels: vi.fn(async () => ok("get_available_models", catalog)),
	getModelRoles: vi.fn(async () => ok("get_model_roles", { roles: [{ id: "default", model: defaultRole }] })),
	setModel: vi.fn(async (provider: string, id: string) => ok("set_model", { provider, id })),
	setModelRole: vi.fn(async () => ok("set_model_role", {})),
	login: vi.fn(async () => ok("login", {})),
});
const listProviders = vi.fn(
	async (): Promise<CustomProvidersConfig> => ({ providers: [], options: fixtureProviderOptions }),
);
const prefs: Record<string, unknown> = {};
const prefsApi = {
	get: vi.fn(async (key?: string) => (key ? prefs[key] : prefs)),
	set: vi.fn(async (key: string, value: unknown) => {
		if (value === undefined) delete prefs[key];
		else prefs[key] = value;
	}),
};
const github = fakeGithubAuth();
Object.assign(window as unknown as Record<string, unknown>, {
	omp: {
		rpc,
		models: { listProviders },
		prefs: prefsApi,
		githubAuth: github.api,
		ui: { respondExtensionUi: vi.fn() },
		system: { openExternal: vi.fn() },
	},
});

/** A document-level key, as the window delivers it when nothing inside claimed it. */
function press(key: string, modifiers: { metaKey?: boolean; ctrlKey?: boolean } = {}): Event {
	const event = new Event("keydown", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "key", { value: key });
	for (const [name, value] of Object.entries(modifiers)) Object.defineProperty(event, name, { value });
	document.dispatchEvent(event);
	return event;
}

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
	useGithubAuthStore.getState().reset();
	github.set(githubState());
	for (const fn of Object.values(rpc)) fn.mockClear();
	for (const key of Object.keys(prefs)) delete prefs[key];
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
		// GitHub is the optional last step, and the step reached is kept for a relaunch.
		expect(useFirstRunStore.getState().phase).toBe("github");
		expect(prefs[FIRST_RUN_STEP_PREF]).toBe("github");
		expect(useToastStore.getState().toasts.map(toast => toast.title)).toContain(translate("setup.ready.title"));
		expect(document.querySelector('[data-testid="first-run-github"]')).not.toBeNull();
		expect(text()).toContain(translate("githubAuth.signIn"));

		await act(async () => button(translate("setup.github.skip"))?.click());
		expect(useFirstRunStore.getState().phase).toBe("idle");
		expect(FIRST_RUN_STEP_PREF in prefs).toBe(false);
	});

	it("skips the GitHub step when an account is signed in with a full Git identity", async () => {
		catalog = { ...catalog, providers: [acme], models: [opus] };
		github.set(
			githubState({
				status: { installed: true, version: "2.62.0", authenticated: true, login: "octocat", otherAccounts: [] },
				identity: { name: "The Octocat", email: "octocat@github.com" },
			}),
		);
		useSessionStore.getState().setStatus("ready", "/tmp/project");
		useFirstRunStore.getState().setPhase("model", "acme");
		await mount(<FirstRunSetup />);
		await act(async () => button(translate("setup.model.use"))?.click());
		expect(useFirstRunStore.getState().phase).toBe("idle");
	});
});

describe("FirstRunSetup resume and keys", () => {
	it("resumes the step reached before a relaunch once a provider can serve", async () => {
		catalog = { ...catalog, providers: [acme], models: [opus] };
		prefs[FIRST_RUN_STEP_PREF] = "github";
		useSessionStore.getState().setStatus("ready", "/tmp/project");
		await mount(
			<>
				<FirstRunGate />
				<FirstRunSetup />
			</>,
		);
		expect(useFirstRunStore.getState().phase).toBe("github");
		expect(document.querySelector('[data-first-run-step="github"]')).not.toBeNull();
		// Resuming is not a fresh default pick.
		expect(rpc.setModel).not.toHaveBeenCalled();
	});

	it("starts over at connect when the saved step has no provider to stand on", async () => {
		catalog = { ...catalog, providers: [anthropic], models: [] };
		prefs[FIRST_RUN_STEP_PREF] = "model";
		useSessionStore.getState().setStatus("ready", "/tmp/project");
		await mount(<FirstRunGate />);
		expect(useFirstRunStore.getState().phase).toBe("connect");
		expect(prefs[FIRST_RUN_STEP_PREF]).toBe("connect");
	});

	it("runs the step's primary action on ⌘/Ctrl+Enter", async () => {
		catalog = { ...catalog, providers: [acme], models: [opus] };
		useSessionStore.getState().setStatus("ready", "/tmp/project");
		useFirstRunStore.getState().setPhase("model", "acme");
		await mount(<FirstRunSetup />);
		const advance = await act(async () => press("Enter", { metaKey: true }));
		expect(advance.defaultPrevented).toBe(true);
		expect(rpc.setModel).toHaveBeenCalledWith("acme", "acme-opus-5");
		expect(useFirstRunStore.getState().phase).toBe("github");

		await act(async () => {
			press("Enter", { ctrlKey: true });
		});
		expect(useFirstRunStore.getState().phase).toBe("idle");
	});

	it("asks before Esc leaves setup, and a field that claims Esc keeps it", async () => {
		catalog = { ...catalog, providers: [anthropic], models: [] };
		useSessionStore.getState().setStatus("ready", "/tmp/project");
		useFirstRunStore.getState().setPhase("connect", null);
		await mount(<FirstRunSetup />);

		const claimed = new Event("keydown", { bubbles: true, cancelable: true });
		Object.defineProperty(claimed, "key", { value: "Escape" });
		claimed.preventDefault();
		await act(async () => document.dispatchEvent(claimed));
		expect(document.querySelector('[role="dialog"]')).toBeNull();

		const leave = await act(async () => press("Escape"));
		expect(leave.defaultPrevented).toBe(true);
		expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain(translate("setup.leave.title"));
		expect(useFirstRunStore.getState().phase).toBe("connect");

		await act(async () => button(translate("setup.leave.stay"))?.click());
		expect(useFirstRunStore.getState().phase).toBe("connect");

		await act(async () => {
			press("Escape");
		});
		const dialog = document.body.querySelector('[role="dialog"]');
		const later = Array.from(dialog?.querySelectorAll("button") ?? []).find(
			candidate => candidate.textContent?.trim() === translate("setup.later"),
		) as HTMLButtonElement | undefined;
		await act(async () => later?.click());
		expect(useFirstRunStore.getState().phase).toBe("idle");
		expect(text()).not.toContain(translate("setup.title"));
	});
});
