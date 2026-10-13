import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureProviderOptions } from "../../../../../e2e/models-config-fixture";
import type { ProviderAccount, ProviderInfo, ProvidersResult, RpcResponse } from "../../../../shared/rpc-types";
import { I18nProvider, translate } from "../../../lib/i18n";
import { useModelStore } from "../../../stores/model";
import { useSessionStore } from "../../../stores/session";
import { useToastStore } from "../../../stores/toast";
import { routeCommands } from "../../../test-support/route-commands";
import { AGENT_ACCOUNT_POOLS_PATH } from "./account-pools";
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

const WORK = "email:work@example.com|org:org-1";
const HOME = "email:home@example.com";

const claude: ProviderInfo = {
	id: "anthropic",
	name: "Anthropic",
	authenticated: true,
	authKind: "oauth",
	loginAvailable: true,
	disabled: false,
	modelCount: 3,
};

function account(credentialId: number, label: string, identityKey?: string | null): ProviderAccount {
	return {
		credentialId,
		label,
		detail: `oauth #${credentialId}`,
		type: "oauth",
		inUse: false,
		state: "healthy",
		limits: [],
		...(identityKey !== undefined ? { identityKey } : {}),
	};
}

const ok = (command: string, data?: unknown): RpcResponse => ({ type: "response", command, success: true, data });

const providersResult: ProvidersResult = {
	providers: [claude],
	models: [],
	discoveryStates: [],
	refreshPending: false,
	generation: 1,
};
const getProviders = vi.fn(async () => ok("get_providers", providersResult));
const getProviderAccounts = vi.fn(async (): Promise<RpcResponse> => ok("get_provider_accounts"));
const getSettings = vi.fn(async (): Promise<RpcResponse> => ok("get_settings"));
const setSetting = vi.fn(async (): Promise<RpcResponse> => ok("set_setting"));
const getAgentDefinitions = vi.fn(async () =>
	ok("get_agent_definitions", {
		agents: [
			{ name: "task", description: "General task agent", source: "bundled" },
			{ name: "scout", description: "Read-only scout", source: "bundled" },
		],
	}),
);
const writeText = vi.fn(async (_text: string) => {});

Object.assign(window as unknown as Record<string, unknown>, {
	omp: {
		rpc: routeCommands({ getProviders, getProviderAccounts, getSettings, setSetting, getAgentDefinitions }),
		models: { listProviders: vi.fn(async () => ({ providers: [], options: fixtureProviderOptions })) },
		ui: { respondExtensionUi: vi.fn() },
		system: { openExternal: vi.fn(async () => {}) },
		accountRotation: { get: vi.fn(async () => ({ mode: "quota", evenSupported: true })), set: vi.fn(async () => {}) },
	},
});
Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

/** Bridge result on an omp with account pools: identity keys plus the pool provider id. */
function accountsWithKeys(list: ProviderAccount[]): RpcResponse {
	return ok("get_provider_accounts", { providerId: "anthropic", credentialProvider: "anthropic", accounts: list });
}

function settingsWith(globalValue: unknown, layers: string[] = globalValue === undefined ? [] : ["global"]) {
	return ok("get_settings", {
		values: { [AGENT_ACCOUNT_POOLS_PATH]: globalValue ?? {} },
		provenance: {
			[AGENT_ACCOUNT_POOLS_PATH]: globalValue === undefined ? { layers } : { layers, globalValue },
		},
	});
}

const roots: Root[] = [];
const text = () => document.body.textContent ?? "";

function button(name: string): HTMLButtonElement | undefined {
	return Array.from(document.body.querySelectorAll("button")).find(
		candidate => (candidate.textContent ?? "").trim() === name || candidate.getAttribute("aria-label") === name,
	) as HTMLButtonElement | undefined;
}

/** The pool editor's row for `agent` (its button carries the name as its title). */
function agentRow(agent: string): HTMLButtonElement | null {
	return document.body.querySelector(`button[aria-expanded][title="${agent}"]`) as HTMLButtonElement | null;
}

/** The checkbox labelled `label` inside the expanded region of `agent`'s row. */
function checkbox(agent: string, label: string): HTMLInputElement | undefined {
	const region = document.getElementById(agentRow(agent)?.getAttribute("aria-controls") ?? "");
	const match = Array.from(region?.querySelectorAll("label") ?? []).find(
		candidate => (candidate.textContent ?? "").trim() === label,
	);
	return match?.querySelector("input") as HTMLInputElement | undefined;
}

/** Linkedom has no checkbox activation behavior: call React's own handler with the new state. */
async function setChecked(input: HTMLInputElement | undefined, checked: boolean): Promise<void> {
	if (!input) throw new Error("checkbox not found");
	const record = input as unknown as Record<string, unknown>;
	const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
	const props = propsKey ? (record[propsKey] as { onChange?: (event: object) => void } | undefined) : undefined;
	await act(async () => props?.onChange?.({ target: { checked }, currentTarget: { checked } }));
}

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(): Promise<void> {
	useSessionStore.setState({ status: "ready" });
	const root = createRoot(document.body as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<ProvidersSection />
			</I18nProvider>,
		);
	});
	await flush();
	await flush();
	roots.push(root);
}

beforeEach(() => {
	getAgentDefinitions.mockClear();
	writeText.mockClear();
	setSetting.mockReset();
	setSetting.mockResolvedValue(ok("set_setting"));
});

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots.length = 0;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useModelStore.getState().reset();
	useSessionStore.getState().reset();
	useToastStore.setState({ toasts: [] });
	getSettings.mockReset();
	getProviderAccounts.mockReset();
});

describe("Copy identity key", () => {
	it("copies the account's token-free identity key", async () => {
		getProviderAccounts.mockResolvedValue(accountsWithKeys([account(7, "work@example.com", WORK)]));
		getSettings.mockResolvedValue(settingsWith(undefined));
		await mount();
		await act(async () => document.body.querySelector<HTMLButtonElement>("button[aria-expanded]")?.click());

		await act(async () => button(translate("providers.accounts.copyKey", { account: "work@example.com" }))?.click());
		await flush();
		expect(writeText).toHaveBeenCalledWith(WORK);
		expect(useToastStore.getState().toasts.map(toast => toast.message)).toContain(
			translate("providers.accounts.keyCopied"),
		);
	});

	it("keeps the pool editor reachable even before an account reports an identity key", async () => {
		getProviderAccounts.mockResolvedValue(
			ok("get_provider_accounts", { providerId: "anthropic", accounts: [account(7, "work@example.com")] }),
		);
		getSettings.mockResolvedValue(settingsWith(undefined));
		await mount();
		await act(async () => document.body.querySelector<HTMLButtonElement>("button[aria-expanded]")?.click());

		expect(text()).toContain("work@example.com");
		expect(button(translate("providers.accounts.copyKey", { account: "work@example.com" }))).toBeUndefined();
		expect(text()).toContain(translate("accountPools.title"));
		expect(getSettings).toHaveBeenCalledWith([AGENT_ACCOUNT_POOLS_PATH]);
	});
});

describe("AccountPoolsEditor", () => {
	const both = [account(7, "work@example.com", WORK), account(9, "home@example.com", HOME)];

	it("keeps an unset stock pool reachable in its custom editor", async () => {
		getProviderAccounts.mockResolvedValue(accountsWithKeys(both));
		getSettings.mockResolvedValue(ok("get_settings", { values: {}, provenance: {} }));
		await mount();
		expect(getSettings).toHaveBeenCalledWith([AGENT_ACCOUNT_POOLS_PATH]);
		expect(text()).toContain(translate("accountPools.title"));
	});

	it("lists every agent and checks the accounts its saved pool names", async () => {
		getProviderAccounts.mockResolvedValue(accountsWithKeys([...both, account(11, "nokey@example.com", null)]));
		getSettings.mockResolvedValue(
			settingsWith({ task: { anthropic: [WORK, "email:gone@example.com"] }, reviewer: { anthropic: [HOME] } }),
		);
		await mount();

		expect(text()).toContain(translate("accountPools.title"));
		expect(agentRow("scout")?.parentElement?.parentElement?.textContent).toContain(
			translate("accountPools.unrestricted"),
		);
		// Saved for an agent the workspace no longer defines: still listed, flagged.
		expect(agentRow("reviewer")?.textContent).toContain(translate("accountPools.agentMissing"));
		expect(agentRow("task")?.parentElement?.parentElement?.textContent).toContain(
			translate("accountPools.restricted", { count: 2 }),
		);

		await act(async () => agentRow("task")?.click());
		expect(checkbox("task", "work@example.com")?.checked).toBe(true);
		expect(checkbox("task", "home@example.com")?.checked).toBe(false);
		// A key no signed-in account has stays listed and checked until unchecked.
		expect(checkbox("task", translate("accountPools.signedOut", { key: "email:gone@example.com" }))?.checked).toBe(
			true,
		);
		const noKey = checkbox("task", translate("accountPools.noIdentity", { account: "nokey@example.com" }));
		expect(noKey?.disabled).toBe(true);
	});

	it("writes the pool through set_setting and clears it once nothing is checked", async () => {
		getProviderAccounts.mockResolvedValue(accountsWithKeys(both));
		getSettings.mockResolvedValue(settingsWith({ task: { anthropic: [WORK] } }));
		await mount();

		await act(async () => agentRow("scout")?.click());
		await setChecked(checkbox("scout", "home@example.com"), true);
		expect(setSetting).toHaveBeenLastCalledWith(AGENT_ACCOUNT_POOLS_PATH, {
			task: { anthropic: [WORK] },
			scout: { anthropic: [HOME] },
		});
		expect(checkbox("scout", "home@example.com")?.checked).toBe(true);

		await setChecked(checkbox("scout", "home@example.com"), false);
		expect(setSetting).toHaveBeenLastCalledWith(AGENT_ACCOUNT_POOLS_PATH, { task: { anthropic: [WORK] } });

		await act(async () => agentRow("task")?.click());
		await setChecked(checkbox("task", "work@example.com"), false);
		// No agent left: the override is removed from config.yml rather than saved as `{}`.
		expect(setSetting).toHaveBeenLastCalledWith(AGENT_ACCOUNT_POOLS_PATH, undefined);
	});

	it("edits the global layer and says when a project value overrides it", async () => {
		getProviderAccounts.mockResolvedValue(accountsWithKeys(both));
		getSettings.mockResolvedValue(
			ok("get_settings", {
				values: { [AGENT_ACCOUNT_POOLS_PATH]: { task: { anthropic: [HOME] } } },
				provenance: { [AGENT_ACCOUNT_POOLS_PATH]: { layers: ["project"] } },
			}),
		);
		await mount();
		expect(text()).toContain(translate("accountPools.overridden"));
		await act(async () => agentRow("task")?.click());
		expect(checkbox("task", "home@example.com")?.checked).toBe(false);
		await setChecked(checkbox("task", "work@example.com"), true);
		expect(setSetting).toHaveBeenLastCalledWith(AGENT_ACCOUNT_POOLS_PATH, { task: { anthropic: [WORK] } });
	});

	it("restores the previous pool when the write fails", async () => {
		getProviderAccounts.mockResolvedValue(accountsWithKeys(both));
		getSettings.mockResolvedValue(settingsWith(undefined));
		setSetting.mockResolvedValue({ type: "response", command: "set_setting", success: false, error: "invalid" });
		await mount();
		await act(async () => agentRow("task")?.click());
		await setChecked(checkbox("task", "work@example.com"), true);
		expect(checkbox("task", "work@example.com")?.checked).toBe(false);
		expect(useToastStore.getState().toasts.map(toast => toast.title)).toContain(translate("accountPools.saveFailed"));
	});

	it("offers recovery in the sole editor for a map it cannot read", async () => {
		getProviderAccounts.mockResolvedValue(accountsWithKeys(both));
		getSettings.mockResolvedValue(settingsWith({ task: ["anthropic"] }));
		await mount();
		expect(text()).toContain(translate("accountPools.unreadable"));
		expect(agentRow("task")).toBeNull();
		const reset = Array.from(document.body.querySelectorAll("button")).find(
			button => button.textContent === translate("common.reset"),
		);
		expect(reset).toBeDefined();
		await act(async () => reset?.click());
		expect(setSetting).toHaveBeenCalledWith(AGENT_ACCOUNT_POOLS_PATH, undefined);
	});
});
