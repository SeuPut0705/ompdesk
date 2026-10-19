/**
 * ModelSetupEntry: the last setup's stamp reads as a bare time on the day it was made and carries its date on any
 * later day; Undo restores only the roles nobody changed since and removes the record; "set up again?" shows
 * only when the connected models or accounts differ from what the last apply saw, and only opens the dialog.
 * linkedom harness per AGENTS.md (never mock.module).
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelSetupFacts } from "../../../../../resources/gui-bridge/model-setup-contracts";
import { setupSignature } from "../../../../shared/role-plan";
import type { ModelRoleEntry } from "../../../../shared/rpc-types";
import { I18nProvider, translate } from "../../../lib/i18n";
import { useSessionStore } from "../../../stores/session";
import { useToastStore } from "../../../stores/toast";
import { useUiStore } from "../../../stores/ui";
import { MODEL_SETUP_PREFS_KEY, planRoleInputs } from "./model-setup-logic";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

// Loaded after the linkedom globals exist: react-dom reads `window`/`document` at import time.
const { createRoot } = await import("react-dom/client");
const { ModelSetupEntry } = await import("./ModelSetupEntry");

const NOW = new Date(2026, 9, 14, 15, 0);

const POOL: ModelRoleEntry["candidates"] = [
	{ provider: "anthropic", id: "opus", name: "Opus", kind: "chat" },
	{ provider: "anthropic", id: "haiku", name: "Haiku", kind: "chat" },
];
const ROLES: ModelRoleEntry[] = [
	{ id: "default", name: "Default", section: "chat", source: "settings", model: "anthropic/opus", candidates: POOL },
	{ id: "smol", name: "Fast", section: "chat", source: "settings", model: "anthropic/haiku", candidates: POOL },
	{
		id: "slow",
		name: "Thinking",
		section: "chat",
		source: "settings",
		model: "anthropic/opus:high",
		candidates: POOL,
	},
];
const FACTS: ModelSetupFacts = {
	providers: { anthropic: { billing: "subscription", basis: "oauth" } },
	models: {},
	roles: {},
	judgePins: [],
};
const SIGNATURE = setupSignature(planRoleInputs(ROLES), FACTS);

let root: Root | undefined;
let container: InstanceType<typeof HTMLElement> | undefined;

function install(record: unknown, roles: ModelRoleEntry[] = ROLES) {
	const rpc = {
		getModelRoles: vi.fn(async () => ({ success: true, data: { roles } })),
		getModelSetupFacts: vi.fn(async () => ({ success: true, data: FACTS })),
		setModelRole: vi.fn(async (_role: string, _model: string | null) => ({ success: true })),
	};
	const set = vi.fn(async (_key: string, _value: unknown) => {});
	Object.assign(window, {
		omp: {
			rpc,
			prefs: {
				get: vi.fn(async (key: string) => (key === MODEL_SETUP_PREFS_KEY ? { local: record } : undefined)),
				set,
			},
		},
	});
	return { rpc, set };
}

async function mount(): Promise<string> {
	useSessionStore.getState().setStatus("ready", "/repo");
	container = document.createElement("div");
	document.body.appendChild(container);
	const mountRoot = createRoot(container);
	root = mountRoot;
	await act(async () => {
		mountRoot.render(
			<I18nProvider>
				<ModelSetupEntry />
			</I18nProvider>,
		);
	});
	await act(async () => {});
	return container.textContent ?? "";
}

async function click(target: Element): Promise<void> {
	const event = new Event("click", { bubbles: true, cancelable: true });
	// linkedom's Event has a getter-only eventPhase React writes to.
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	await act(async () => {
		target.dispatchEvent(event);
	});
}

function button(label: string): Element {
	const found = [...document.querySelectorAll("button")].find(
		candidate => (candidate.textContent ?? "").trim() === label,
	);
	if (!found) throw new Error(`no button "${label}"`);
	return found;
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	container?.remove();
	container = undefined;
	delete (window as unknown as { omp?: unknown }).omp;
	useSessionStore.getState().reset();
	useToastStore.setState({ toasts: [] });
	useUiStore.getState().closeModelSetup();
	vi.useRealTimers();
});

const applied = (at: number) => ({
	at,
	values: { smol: "anthropic/haiku", slow: "anthropic/opus" },
	before: { smol: null, slow: "anthropic/haiku" },
});

describe("ModelSetupEntry", () => {
	it("shows only the time for a setup made today", async () => {
		install({ applied: applied(new Date(2026, 9, 14, 10, 37).getTime()), signature: SIGNATURE });
		expect(await mount()).toContain("Last setup: 10:37");
	});

	it("adds the date for a setup from an earlier day", async () => {
		install({ applied: applied(new Date(2026, 9, 12, 10, 37).getTime()), signature: SIGNATURE });
		expect(await mount()).toMatch(/Last setup: Oct 12, 10:37/);
	});

	it("adds the year for a setup from an earlier year", async () => {
		install({ applied: applied(new Date(2025, 11, 30, 9, 5).getTime()), signature: SIGNATURE });
		expect(await mount()).toMatch(/Last setup: Dec 30, 2025, 09:05/);
	});

	it("shows no date, Undo or offer before any setup", async () => {
		install(undefined);
		const text = await mount();
		expect(text).not.toContain("Last setup");
		expect(text).not.toContain(translate("modelSetup.undo"));
		expect(text).not.toContain(translate("modelSetup.entryOffer"));
	});

	it("undoes only the roles that still hold what the setup wrote, names the others and removes the record", async () => {
		// slow was changed by hand since the setup (it holds opus:high, the setup wrote opus... then the person set haiku).
		const roles = ROLES.map(role => (role.id === "slow" ? { ...role, model: "anthropic/haiku" } : role));
		const harness = install({ applied: applied(1), signature: SIGNATURE }, roles);
		await mount();

		await click(button(translate("modelSetup.undo")));

		expect(harness.rpc.setModelRole.mock.calls).toEqual([["smol", null]]);
		const stored = harness.set.mock.calls.find(([key]) => key === MODEL_SETUP_PREFS_KEY)?.[1];
		expect(stored).toEqual({});
		const last = useToastStore.getState().toasts.at(-1);
		expect(last?.variant).toBe("success");
		expect(last?.message).toContain(translate("modelSetup.undo.done", { count: 1 }));
		expect(last?.message).toContain(translate("modelSetup.undo.skipped", { roles: "Thinking" }));
		// The record is gone: no Undo any more.
		expect(container?.textContent).not.toContain("Last setup");
	});

	it("restores every written role when none was touched", async () => {
		const harness = install({ applied: applied(1), signature: SIGNATURE });
		await mount();
		await click(button(translate("modelSetup.undo")));
		// slow holds opus:high, the same model the setup wrote (opus) under a thinking suffix.
		expect(harness.rpc.setModelRole.mock.calls).toEqual([
			["smol", null],
			["slow", "anthropic/haiku"],
		]);
	});

	it("offers to set up again only when the models or accounts differ from the last apply, and never changes anything", async () => {
		const quiet = install({ applied: applied(1), signature: SIGNATURE });
		expect(await mount()).not.toContain(translate("modelSetup.entryOffer"));
		expect(quiet.rpc.getModelSetupFacts).toHaveBeenCalledTimes(1);
		await act(async () => root?.unmount());
		container?.remove();

		// A new account appeared since: the signature differs.
		const changed = install({ applied: applied(1), signature: "an older signature" });
		expect(await mount()).toContain(translate("modelSetup.entryOffer"));
		expect(changed.rpc.setModelRole).not.toHaveBeenCalled();
		expect(changed.set).not.toHaveBeenCalled();
		expect(useToastStore.getState().toasts).toHaveLength(0);
		expect(useUiStore.getState().modelSetupOpen).toBe(false);

		await click(button(translate("modelSetup.entryOffer")));
		expect(useUiStore.getState().modelSetupOpen).toBe(true);
	});

	it("reads an old proposal record as no setup", async () => {
		install({ savedAt: 1, researchModel: "a/b", models: [], plan: {}, dropped: [] });
		const text = await mount();
		expect(text).not.toContain("Last setup");
		expect(text).not.toContain(translate("modelSetup.entryOffer"));
	});
});
