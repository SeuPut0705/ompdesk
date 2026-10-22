import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureProviderOptions } from "../../../../e2e/models-config-fixture";
import type { CustomProvidersConfig, CustomProviderView } from "../../../shared/ipc-types";
import type { ModelInfo, ProviderInfo, ProvidersResult, RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { FIRST_RUN_STEP_PREF, useFirstRunStore } from "../../stores/first-run";
import { useMachineSetupStore } from "../../stores/machine-setup";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { setFocusedSessionRuntime } from "../../stores/session-runtime-context";
import { useTabsStore } from "../../stores/tabs";
import { useToastStore } from "../../stores/toast";
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
// linkedom has no layout and so no scrollIntoView; the model step scrolls its chosen row into view.
if (typeof elementPrototype.scrollIntoView !== "function") elementPrototype.scrollIntoView = () => {};

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
/** This computer's omp holds a credential (main's `models:signed-in`); a test of a true first run sets false. */
let signedIn: boolean | null = true;
const prefs: Record<string, unknown> = {};
const prefsApi = {
	get: vi.fn(async (key?: string) => (key ? prefs[key] : prefs)),
	set: vi.fn(async (key: string, value: unknown) => {
		if (value === undefined) delete prefs[key];
		else prefs[key] = value;
	}),
};
Object.assign(window as unknown as Record<string, unknown>, {
	omp: {
		rpc,
		models: { listProviders, signedIn: vi.fn(async () => signedIn) },
		prefs: prefsApi,
		ui: { respondExtensionUi: vi.fn() },
		system: { openExternal: vi.fn() },
		runtime: { startupMark: vi.fn() },
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
	useMachineSetupStore.getState().reset();
	useSessionStore.getState().reset();
	useToastStore.setState({ toasts: [] });
	for (const fn of Object.values(rpc)) fn.mockClear();
	for (const key of Object.keys(prefs)) delete prefs[key];
	defaultRole = undefined;
	signedIn = true;
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
		expect(text()).toContain("Claude (Pro/Max)");
		// The popular providers sit on top as their own mark-first group.
		expect(document.querySelector("[data-featured-providers] [data-provider-mark]")).not.toBeNull();
		expect(document.querySelector('[data-provider-connect="anthropic"]')).not.toBeNull();
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

	it("shows the provider step from static rows while a just-installed omp starts, then the live list", async () => {
		catalog = { ...catalog, providers: [apple, anthropic], models: [onDevice] };
		useMachineSetupStore.setState({ ompInstalled: true, takeover: false });
		useSessionStore.getState().setStatus("starting", "/tmp/project");
		await mount(
			<>
				<FirstRunGate />
				<FirstRunSetup />
			</>,
		);
		// No omp answer yet: the recommended providers, waiting for the session, and no error.
		expect(useFirstRunStore.getState()).toMatchObject({ phase: "connect", provisional: true });
		expect(rpc.getProviders).not.toHaveBeenCalled();
		const starter = document.querySelector<HTMLButtonElement>('[data-provider-connect="openai-codex"]');
		// A tab command is held until omp is ready, so the card can already start a sign-in.
		expect(starter?.disabled).toBe(false);
		expect(text()).not.toContain(translate("providers.notConnected"));
		expect(document.querySelector('[role="alert"]')).toBeNull();

		await act(async () => useSessionStore.getState().setStatus("ready", "/tmp/project"));
		await act(async () => delay(0));
		expect(useFirstRunStore.getState()).toMatchObject({ phase: "connect", provisional: false });
		expect(text()).toContain("Claude (Pro/Max)");
		expect(document.querySelector('[data-provider-connect="openai-codex"]')).toBeNull();
	});

	it("a sign-in cancelled while omp still starts never reaches omp once it is ready", async () => {
		catalog = { ...catalog, providers: [anthropic], models: [] };
		// A login that does go out stays open, as stock's does while it waits for the browser.
		const pendingLogin = Promise.withResolvers<RpcResponse>();
		rpc.login.mockReturnValueOnce(pendingLogin.promise);
		useMachineSetupStore.setState({ ompInstalled: true, takeover: false });
		useSessionStore.getState().setStatus("starting", "/tmp/project");
		useTabsStore.setState({
			tabs: [{ id: "t1", cwd: "/tmp/project", status: "starting", kind: "agent", unreadDone: false }],
			activeTabId: "t1",
		});
		setFocusedSessionRuntime("t1");
		try {
			await mount(
				<>
					<FirstRunGate />
					<FirstRunSetup />
				</>,
			);
			await act(async () =>
				document.querySelector<HTMLButtonElement>('[data-provider-connect="openai-codex"]')?.click(),
			);
			expect(document.querySelector("[data-login-progress]")).not.toBeNull();
			await act(async () => button(translate("common.cancel"))?.click());

			await act(async () => {
				useTabsStore.setState(state => ({ tabs: state.tabs.map(tab => ({ ...tab, status: "ready" })) }));
				useSessionStore.getState().setStatus("ready", "/tmp/project");
				await delay(0);
			});
			await act(async () => delay(0));
			expect(rpc.login).not.toHaveBeenCalled();
			expect(document.querySelector("[data-login-progress]")).toBeNull();
		} finally {
			pendingLogin.resolve({ type: "response", command: "login", success: false, error: "cancelled" });
			rpc.login.mockReset();
			rpc.login.mockImplementation(async () => ok("login", {}));
			setFocusedSessionRuntime(null);
			useTabsStore.setState({ tabs: [], activeTabId: null });
		}
	});

	it("closes a step opened ahead of the check when a provider serves after all", async () => {
		catalog = { ...catalog, providers: [acme, apple], models: [onDevice, opus] };
		useMachineSetupStore.setState({ ompInstalled: true, takeover: false });
		useSessionStore.getState().setStatus("starting", "/tmp/project");
		await mount(
			<>
				<FirstRunGate />
				<FirstRunSetup />
			</>,
		);
		expect(useFirstRunStore.getState().phase).toBe("connect");
		await act(async () => useSessionStore.getState().setStatus("ready", "/tmp/project"));
		await act(async () => delay(0));
		expect(useFirstRunStore.getState().phase).toBe("idle");
		expect(text()).not.toContain(translate("setup.title"));
	});

	it("opens the provider step before omp boots when this computer's omp holds no credential at all", async () => {
		catalog = { ...catalog, providers: [apple, anthropic], models: [onDevice] };
		signedIn = false;
		useSessionStore.getState().setStatus("starting", "/tmp/project");
		await mount(
			<>
				<FirstRunGate />
				<FirstRunSetup />
			</>,
		);
		expect(useFirstRunStore.getState()).toMatchObject({ phase: "connect", provisional: true });
		expect(document.querySelector('[data-provider-connect="openai-codex"]')).not.toBeNull();
	});

	it("keeps an early step the user dismissed closed once omp's check finds no provider", async () => {
		catalog = { ...catalog, providers: [apple, anthropic], models: [onDevice] };
		signedIn = false;
		useSessionStore.getState().setStatus("starting", "/tmp/project");
		await mount(
			<>
				<FirstRunGate />
				<FirstRunSetup />
			</>,
		);
		expect(useFirstRunStore.getState().phase).toBe("connect");
		await act(async () => button(translate("setup.later"))?.click());
		expect(useFirstRunStore.getState().phase).toBe("idle");

		await act(async () => useSessionStore.getState().setStatus("ready", "/tmp/project"));
		await act(async () => delay(0));
		expect(rpc.getProviders).toHaveBeenCalled();
		expect(useFirstRunStore.getState().phase).toBe("idle");
		expect(text()).not.toContain(translate("setup.title"));
	});

	it("waits for omp when a credential exists, or a keyless models.yml endpoint can serve", async () => {
		useSessionStore.getState().setStatus("starting", "/tmp/project");
		await mount(<FirstRunGate />);
		expect(useFirstRunStore.getState().phase).toBe("idle");

		signedIn = false;
		const keyless: CustomProviderView = {
			id: "local",
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:1234/v1",
			hasApiKey: false,
			auth: "none",
			models: [{ id: "m" }],
			builtin: false,
		};
		listProviders.mockResolvedValueOnce({ providers: [keyless], options: fixtureProviderOptions });
		// A fresh gate on the same page: the first one leaves before the second mounts.
		const first = roots.pop();
		await act(async () => first?.unmount());
		await mount(<FirstRunGate />);
		expect(useFirstRunStore.getState().phase).toBe("idle");
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
		// Nothing follows the model: setup ends, the saved step is forgotten and the ready toast names the model.
		expect(useFirstRunStore.getState().phase).toBe("idle");
		expect(document.querySelector("[data-first-run-step]")).toBeNull();
		expect(FIRST_RUN_STEP_PREF in prefs).toBe(false);
		expect(useToastStore.getState().toasts.map(toast => toast.title)).toContain(translate("setup.ready.title"));
	});

	it("scrolls the pre-selected model into view in a long list", async () => {
		const many: ModelInfo[] = Array.from({ length: 30 }, (_, index) => ({
			provider: "acme",
			id: `acme-model-${index}`,
			name: `Acme Model ${index}`,
			contextWindow: 100_000,
		}));
		const wanted = many[21] as ModelInfo;
		catalog = { ...catalog, providers: [acme], models: many };
		defaultRole = "acme/acme-model-21";
		useModelStore.setState({ model: wanted });
		useSessionStore.getState().setStatus("ready", "/tmp/project");
		useFirstRunStore.getState().setPhase("model", null);
		const shown: string[] = [];
		const proto = HTMLElement.prototype as unknown as { scrollIntoView: (this: HTMLElement) => void };
		const original = proto.scrollIntoView;
		proto.scrollIntoView = function (this: HTMLElement) {
			shown.push(`${this.getAttribute("aria-checked")}:${this.textContent}`);
		};
		try {
			await mount(<FirstRunSetup />);
		} finally {
			proto.scrollIntoView = original;
		}
		expect(shown.at(-1)).toContain("true:");
		expect(shown.at(-1)).toContain("Acme Model 21");
	});
});

describe("FirstRunSetup connect step", () => {
	const claude: ModelInfo = {
		provider: "anthropic",
		id: "claude-opus-5",
		name: "Claude Opus 5",
		contextWindow: 200_000,
	};
	const claudeConnected = provider({
		id: "anthropic",
		name: "Anthropic (Claude Pro/Max)",
		authenticated: true,
		modelCount: 1,
	});

	async function settle(): Promise<void> {
		for (let round = 0; round < 4; round++) await act(async () => delay(0));
	}

	async function openConnectStep(): Promise<void> {
		catalog = { ...catalog, providers: [anthropic], models: [] };
		useSessionStore.getState().setStatus("ready", "/tmp/project");
		useFirstRunStore.getState().setPhase("connect", null);
		await mount(<FirstRunSetup />);
	}

	/** Click Claude's card; omp's catalog says it is connected by the time `login` returns. */
	async function signInToClaude(connected: Partial<ProvidersResult>): Promise<void> {
		catalog = { ...catalog, ...connected };
		await act(async () => document.querySelector<HTMLButtonElement>('[data-provider-connect="anthropic"]')?.click());
		await settle();
	}

	it("ends the setup on its own after a sign-in: the default model is saved and the toast names it", async () => {
		await openConnectStep();
		await signInToClaude({ providers: [claudeConnected], models: [claude] });

		expect(document.querySelector("[data-first-run-step]")).toBeNull();
		expect(useFirstRunStore.getState().phase).toBe("idle");
		expect(rpc.setModel).toHaveBeenCalledWith("anthropic", "claude-opus-5");
		expect(rpc.setModelRole).toHaveBeenCalledWith("default", "anthropic/claude-opus-5");
		expect(FIRST_RUN_STEP_PREF in prefs).toBe(false);
		const toasts = useToastStore.getState().toasts;
		expect(toasts.map(toast => toast.title)).toContain(translate("setup.ready.title"));
		expect(toasts.map(toast => toast.message).join("\n")).toContain("Claude Opus 5");
	});

	it("picks the model for a provider that connected somewhere else meanwhile", async () => {
		catalog = { ...catalog, providers: [acme], models: [opus] };
		useSessionStore.getState().setStatus("ready", "/tmp/project");
		useFirstRunStore.getState().setPhase("connect", null);
		await mount(<FirstRunSetup />);
		await settle();

		expect(document.querySelector("[data-first-run-step]")).toBeNull();
		expect(rpc.setModelRole).toHaveBeenCalledWith("default", "acme/acme-opus-5");
		expect(useToastStore.getState().toasts.map(toast => toast.title)).toContain(translate("setup.ready.title"));
	});

	it("opens the model step when no model can be picked", async () => {
		await openConnectStep();
		await signInToClaude({ providers: [claudeConnected], models: [] });

		expect(document.querySelector('[data-first-run-step="model"]')).not.toBeNull();
		expect(rpc.setModel).not.toHaveBeenCalled();
		expect(useToastStore.getState().toasts).toEqual([]);
		expect(button(translate("setup.model.back"))).toBeDefined();
	});

	it("Back from the fallback model step returns to the provider list and stays there", async () => {
		await openConnectStep();
		await signInToClaude({ providers: [claudeConnected], models: [] });
		expect(document.querySelector('[data-first-run-step="model"]')).not.toBeNull();

		await act(async () => button(translate("setup.model.back"))?.click());
		await settle();

		expect(document.querySelector('[data-first-run-step="connect"]')).not.toBeNull();
		expect(useFirstRunStore.getState().phase).toBe("connect");
		expect(rpc.setModel).not.toHaveBeenCalled();
	});

	it("opens the model step with the save error when the default cannot be saved", async () => {
		rpc.setModel.mockImplementationOnce(async () => ({
			type: "response",
			command: "set_model",
			success: false,
			error: "config.yml is read-only",
		}));
		await openConnectStep();
		await signInToClaude({ providers: [claudeConnected], models: [claude] });

		expect(document.querySelector('[data-first-run-step="model"]')).not.toBeNull();
		expect(text()).toContain(translate("setup.model.saveFailed"));
		expect(text()).toContain("config.yml is read-only");
		expect(text()).toContain("Claude Opus 5");
		expect(useToastStore.getState().toasts).toEqual([]);
	});

	it("shows one muted line under the title, with no step list, subtitle or key-hint row", async () => {
		await openConnectStep();
		const region = document.querySelector('[data-first-run-step="connect"]');
		expect(region?.querySelector("h1")?.textContent).toBe(translate("setup.title"));
		expect(region?.textContent).toContain(translate("setup.connect.description"));
		expect(region?.querySelector("ol")).toBeNull();
		// The only headings under the title are the provider picker's groups, never a step subtitle.
		const headings = Array.from(region?.querySelectorAll("h2") ?? []).map(heading => heading.textContent);
		expect(headings).toEqual([translate("providers.featured.title")]);
		expect(region?.querySelector("kbd")).toBeNull();
		expect(button(translate("setup.later"))).toBeDefined();
	});

	it("keeps the custom endpoint to one line: the description is behind the info glyph, not a paragraph", async () => {
		await openConnectStep();
		expect(document.querySelector("[data-setting-info]")).not.toBeNull();
		const description = Array.from(document.querySelectorAll("*")).find(
			element => element.children.length === 0 && element.textContent === translate("setup.custom.description"),
		);
		expect(description?.className).toContain("sr-only");
		expect(button(translate("providerList.addCustom"))).toBeDefined();
	});
});

describe("FirstRunSetup resume and keys", () => {
	it("resumes the model step reached before a relaunch once a provider can serve", async () => {
		catalog = { ...catalog, providers: [acme], models: [opus] };
		prefs[FIRST_RUN_STEP_PREF] = "model";
		useSessionStore.getState().setStatus("ready", "/tmp/project");
		await mount(
			<>
				<FirstRunGate />
				<FirstRunSetup />
			</>,
		);
		expect(useFirstRunStore.getState().phase).toBe("model");
		expect(document.querySelector('[data-first-run-step="model"]')).not.toBeNull();
		// Resuming is not a fresh default pick.
		expect(rpc.setModel).not.toHaveBeenCalled();
	});

	it("forgets a saved GitHub step an older version left, and opens no step", async () => {
		catalog = { ...catalog, providers: [acme], models: [opus] };
		prefs[FIRST_RUN_STEP_PREF] = "github";
		useSessionStore.getState().setStatus("ready", "/tmp/project");
		await mount(
			<>
				<FirstRunGate />
				<FirstRunSetup />
			</>,
		);
		expect(useFirstRunStore.getState().phase).toBe("idle");
		expect(document.querySelector("[data-first-run-step]")).toBeNull();
		expect(FIRST_RUN_STEP_PREF in prefs).toBe(false);
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

	it("answers Add custom endpoint at once while the provider options load, then shows the form", async () => {
		catalog = { ...catalog, providers: [anthropic], models: [] };
		const options = Promise.withResolvers<CustomProvidersConfig>();
		listProviders.mockImplementationOnce(() => options.promise);
		useSessionStore.getState().setStatus("ready", "/tmp/project");
		useFirstRunStore.getState().setPhase("connect", null);
		await mount(<FirstRunSetup />);

		await act(async () => button(translate("providerList.addCustom"))?.click());
		expect(document.querySelector('[data-testid="first-run-custom-pending"]')).not.toBeNull();
		expect(button(translate("providerCfg.form.add"))).toBeUndefined();

		await act(async () => options.resolve({ providers: [], options: fixtureProviderOptions }));
		expect(document.querySelector('[data-testid="first-run-custom-pending"]')).toBeNull();
		expect(button(translate("providerCfg.form.add"))).toBeDefined();
	});

	it("says so, with a Retry, when the provider options cannot be read", async () => {
		catalog = { ...catalog, providers: [anthropic], models: [] };
		listProviders.mockRejectedValueOnce(new Error("models.yml unreadable"));
		useSessionStore.getState().setStatus("ready", "/tmp/project");
		useFirstRunStore.getState().setPhase("connect", null);
		await mount(<FirstRunSetup />);

		await act(async () => button(translate("providerList.addCustom"))?.click());
		const pending = document.querySelector('[data-testid="first-run-custom-pending"]');
		expect(pending?.textContent).toContain(translate("setup.configReadFailed"));

		// Back leaves the pending state for the provider list.
		await act(async () => button(translate("setup.model.back"))?.click());
		expect(document.querySelector('[data-testid="first-run-custom-pending"]')).toBeNull();
		expect(button(translate("providerList.addCustom"))).toBeDefined();

		await act(async () => button(translate("providerList.addCustom"))?.click());
		await act(async () => button(translate("common.retry"))?.click());
		expect(button(translate("providerCfg.form.add"))).toBeDefined();
	});
});
