/**
 * ModelSetupDialog contract: pick → research → review, the default
 * preselection (current default model plus the strongest model of every other
 * connected provider), Apply writing only the roles that change and
 * `advisor.enabled` only when the switch moved, a stored proposal reopening on
 * the review step, and Cancel during the research aborting the run.
 * linkedom harness per AGENTS.md; stores reset in afterEach (never mock.module).
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IpcModelSetupRunResult } from "../../../../shared/ipc-types";
import type { ModelSetupPlan, ModelSetupRequest } from "../../../../shared/model-setup";
import type { ModelInfo, ModelRoleEntry } from "../../../../shared/rpc-types";
import { I18nProvider, translate } from "../../../lib/i18n";
import { useModelStore } from "../../../stores/model";
import { useSessionStore } from "../../../stores/session";
import { useToastStore } from "../../../stores/toast";
import { useUiStore } from "../../../stores/ui";
import { routeCommands } from "../../../test-support/route-commands";
import { MODEL_SETUP_PREFS_KEY } from "./model-setup-logic";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	requestAnimationFrame: (callback: () => void) => {
		callback();
		return 0;
	},
	IS_REACT_ACT_ENVIRONMENT: true,
});

// Loaded after the linkedom globals exist: react-dom reads `window`/`document` at import time.
const { createRoot } = await import("react-dom/client");
const { ModelSetupDialog } = await import("./ModelSetupDialog");

type TestElement = InstanceType<typeof HTMLElement>;

const CHAT_POOL: ModelRoleEntry["candidates"] = [
	{ provider: "anthropic", id: "opus", name: "Opus", kind: "chat" },
	{ provider: "anthropic", id: "haiku", name: "Haiku", kind: "chat" },
	{ provider: "openai", id: "gpt-mini", name: "GPT mini", kind: "chat" },
	{ provider: "openai", id: "gpt-5", name: "GPT-5", kind: "chat" },
	{ provider: "google", id: "gemini", name: "Gemini", kind: "chat" },
	{ provider: "openai", id: "dalle", name: "DALL·E", kind: "image" },
];

const ROLES: ModelRoleEntry[] = [
	{
		id: "default",
		name: "Default",
		section: "chat",
		source: "settings",
		model: "anthropic/opus:high",
		candidates: CHAT_POOL,
	},
	{ id: "smol", name: "Fast", section: "chat", source: "settings", model: "anthropic/haiku", candidates: CHAT_POOL },
	{ id: "slow", name: "Thinking", section: "chat", source: "default", candidates: CHAT_POOL },
	{ id: "advisor", name: "Advisor", section: "chat", source: "default", candidates: CHAT_POOL },
	{ id: "secret", name: "Hidden", section: "chat", source: "default", hidden: true, candidates: [] },
	{ id: "image", name: "Image generation", section: "kind", source: "default", candidates: [CHAT_POOL[5]] },
] as ModelRoleEntry[];

/** gpt-5 outranks gpt-mini on the catalog's intelligence score despite coming later in the pool. */
const CATALOG: ModelInfo[] = [
	{
		provider: "anthropic",
		id: "opus",
		name: "Opus",
		int: 80,
		contextWindow: 200_000,
		cost: { input: 15, output: 75 },
	},
	{ provider: "openai", id: "gpt-mini", name: "GPT mini", int: 40, contextWindow: 400_000 },
	{ provider: "openai", id: "gpt-5", name: "GPT-5", int: 70, contextWindow: 400_000 },
] as ModelInfo[];

const PLAN: ModelSetupPlan = {
	assignments: [
		{ role: "default", model: "anthropic/opus", reason: "Strongest coder." },
		{ role: "smol", model: "google/gemini", reason: "Cheap and fast." },
		{ role: "slow", model: "openai/gpt-5", reason: "Best reasoning." },
		{ role: "advisor", model: "openai/gpt-5", reason: "Another vendor." },
	],
	advisor: { enable: true, reason: "A second vendor catches mistakes." },
	sources: [{ title: "Leaderboard", url: "https://example.com/board" }],
};

type RunResearch = (request: ModelSetupRequest, device?: string) => Promise<IpcModelSetupRunResult>;

function install({ advisorEnabled = false, stored }: { advisorEnabled?: boolean; stored?: unknown } = {}) {
	let pending = Promise.withResolvers<IpcModelSetupRunResult>();
	const rpc = routeCommands({
		getModelRoles: vi.fn(async () => ({ success: true, data: { roles: ROLES } })),
		getSettings: vi.fn(async () => ({ success: true, data: { values: { "advisor.enabled": advisorEnabled } } })),
		getAvailableModels: vi.fn(async () => ({
			type: "response",
			command: "get_available_models",
			success: true,
			data: { models: CATALOG, discoveryStates: [], refreshPending: false, generation: 1 },
		})),
		setModelRole: vi.fn(async () => ({ success: true })),
		setSetting: vi.fn(async () => ({ success: true, data: { advisorEnabled: true, advisorActive: true } })),
	});
	const run = vi.fn<RunResearch>(() => {
		pending = Promise.withResolvers<IpcModelSetupRunResult>();
		return pending.promise;
	});
	const abort = vi.fn(async () => true);
	const prefsSet = vi.fn<(key: string, value: unknown) => Promise<void>>(async () => {});
	(window as unknown as { omp?: unknown }).omp = {
		rpc,
		prefs: {
			get: vi.fn(async (key: string) => (key === MODEL_SETUP_PREFS_KEY ? stored : undefined)),
			set: prefsSet,
		},
		modelSetup: { run, abort, status: vi.fn(async () => ({ running: true })) },
		system: { openExternal: vi.fn(async () => {}) },
	};
	/** Settle the pending research run. */
	const finish = (result: IpcModelSetupRunResult) => pending.resolve(result);
	return { rpc, run, abort, prefsSet, finish };
}

let root: Root | undefined;
let container: TestElement | undefined;

async function mount(): Promise<void> {
	useSessionStore.getState().setStatus("ready", "/repo");
	useUiStore.getState().openModelSetup();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<ModelSetupDialog />
			</I18nProvider>,
		);
	});
	// Flush the parallel open reads and the re-render they cause.
	await act(async () => {});
}

function step(): string | null {
	return document.querySelector("[data-model-setup-step]")?.getAttribute("data-model-setup-step") ?? null;
}

function checkedModels(): string[] {
	return [...document.querySelectorAll("input[data-model-setup-model]")]
		.filter(input => (input as unknown as { checked: boolean }).checked)
		.map(input => input.getAttribute("data-model-setup-model") ?? "");
}

function button(label: string): TestElement {
	const found = [...document.querySelectorAll("button")].find(
		candidate => (candidate.textContent ?? "").trim() === label,
	);
	if (!found) throw new Error(`no button "${label}"`);
	return found as unknown as TestElement;
}

async function click(target: TestElement): Promise<void> {
	const event = new Event("click", { bubbles: true, cancelable: true });
	// linkedom's Event has a getter-only eventPhase React writes to.
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	await act(async () => {
		target.dispatchEvent(event);
	});
}

/** Drive a controlled <select>'s React onChange with a new value. */
async function choose(select: TestElement, value: string): Promise<void> {
	const record = select as unknown as Record<string, unknown>;
	const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
	const props = propsKey ? (record[propsKey] as { onChange?: (event: object) => void }) : undefined;
	if (!props?.onChange) throw new Error("select has no onChange");
	await act(async () => props.onChange?.({ target: { value }, currentTarget: { value } }));
}

function roleSelect(role: string): TestElement {
	const select = document.querySelector(`tr[data-model-setup-role="${role}"] select`);
	if (!select) throw new Error(`no select for role ${role}`);
	return select as unknown as TestElement;
}

async function researchToReview(harness: { finish: (result: IpcModelSetupRunResult) => void }): Promise<void> {
	await click(button(translate("modelSetup.pick.start")));
	expect(step()).toBe("research");
	await act(async () => {
		harness.finish({ success: true, plan: PLAN, dropped: ['unknown role "reviewer"'] });
	});
	await act(async () => {});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	container?.remove();
	container = undefined;
	delete (window as unknown as { omp?: unknown }).omp;
	useSessionStore.getState().reset();
	useModelStore.getState().reset();
	useToastStore.setState({ toasts: [] });
	useUiStore.getState().closeModelSetup();
	vi.restoreAllMocks();
});

describe("ModelSetupDialog", () => {
	it("preselects the default model plus the strongest model of every other provider", async () => {
		const harness = install();
		await mount();

		expect(step()).toBe("pick");
		expect(harness.rpc.getModelRoles).toHaveBeenCalledTimes(1);
		// The thinking suffix is dropped; gpt-5 beats gpt-mini on intelligence; image models are not offered.
		expect(checkedModels().sort()).toEqual(["anthropic/opus", "google/gemini", "openai/gpt-5"]);
		expect(document.querySelector('input[data-model-setup-model="openai/dalle"]')).toBeNull();
		expect(document.body.textContent).toContain(translate("modelSetup.pick.count", { count: 3, max: 12 }));
		const research = document.querySelector("select") as unknown as { value: string } | null;
		expect(research?.value).toBe("anthropic/opus");
	});

	it("runs pick → research → review and applies only the changed roles plus the advisor switch", async () => {
		const harness = install();
		await mount();
		await researchToReview(harness);

		const request = harness.run.mock.calls[0]?.[0];
		expect(request?.researchModel).toBe("anthropic/opus");
		expect(request?.defaultModel).toBe("anthropic/opus");
		expect(request?.models.map(model => model.selector).sort()).toEqual([
			"anthropic/opus",
			"google/gemini",
			"openai/gpt-5",
		]);
		// Visible chat roles only: no hidden role, no image role.
		expect(request?.roles.map(role => role.id)).toEqual(["default", "smol", "slow", "advisor"]);

		expect(step()).toBe("review");
		expect(document.body.textContent).toContain(translate("modelSetup.review.dropped", { count: 1 }));
		// The proposal is stored for this computer.
		const stored = harness.prefsSet.mock.calls.find(([key]) => key === MODEL_SETUP_PREFS_KEY)?.[1] as
			| Record<string, { plan: ModelSetupPlan }>
			| undefined;
		expect(stored?.local?.plan).toEqual(PLAN);
		// default already runs anthropic/opus (with a thinking suffix): marked unchanged.
		expect(document.querySelector('tr[data-model-setup-role="default"]')?.textContent).toContain(
			translate("modelSetup.review.unchanged"),
		);
		// The table only offers the researched models.
		const offered = [...roleSelect("slow").querySelectorAll("option")].map(option => option.getAttribute("value"));
		expect(offered.sort()).toEqual(["anthropic/opus", "google/gemini", "openai/gpt-5"]);

		await choose(roleSelect("slow"), "google/gemini");
		await click(button(translate("modelSetup.review.apply")));

		expect(harness.rpc.setModelRole.mock.calls).toEqual([
			["smol", "google/gemini"],
			["slow", "google/gemini"],
			["advisor", "openai/gpt-5"],
		]);
		expect(harness.rpc.setSetting.mock.calls).toEqual([["advisor.enabled", true]]);
		const last = useToastStore.getState().toasts.at(-1);
		expect(last?.variant).toBe("success");
		expect(last?.message).toContain(translate("modelSetup.apply.done", { count: 3 }));
		expect(last?.message).toContain(translate("modelSetup.apply.advisorOn"));
		expect(useUiStore.getState().modelSetupOpen).toBe(false);
	});

	it("leaves advisor.enabled alone when the switch matches the current setting", async () => {
		const harness = install({ advisorEnabled: true });
		await mount();
		await researchToReview(harness);

		await click(button(translate("modelSetup.review.apply")));

		expect(harness.rpc.setModelRole).toHaveBeenCalledTimes(3);
		expect(harness.rpc.setModelRole).not.toHaveBeenCalledWith("default", expect.anything());
		expect(harness.rpc.setSetting).not.toHaveBeenCalled();
		expect(useToastStore.getState().toasts.at(-1)?.message).toBe(translate("modelSetup.apply.done", { count: 3 }));
	});

	it("writes advisor.enabled=false when the user turns the proposed advisor off", async () => {
		const harness = install({ advisorEnabled: true });
		await mount();
		await researchToReview(harness);

		const advisorSwitch = document.querySelector('[role="switch"]') as unknown as TestElement;
		expect(advisorSwitch.getAttribute("aria-checked")).toBe("true");
		await click(advisorSwitch);
		await click(button(translate("modelSetup.review.apply")));

		expect(harness.rpc.setSetting.mock.calls).toEqual([["advisor.enabled", false]]);
	});

	it("reopens a stored proposal on the review step and writes nothing when everything matches", async () => {
		const harness = install({
			advisorEnabled: true,
			stored: {
				local: {
					savedAt: Date.UTC(2026, 9, 1),
					researchModel: "anthropic/opus",
					models: ["anthropic/opus", "anthropic/haiku"],
					plan: {
						assignments: [
							{ role: "default", model: "anthropic/opus", reason: "Keep." },
							{ role: "smol", model: "anthropic/haiku", reason: "Keep." },
						],
						advisor: { enable: true, reason: "" },
						sources: [],
					},
					dropped: [],
				},
			},
		});
		await mount();

		expect(step()).toBe("review");
		expect(harness.run).not.toHaveBeenCalled();
		expect(document.querySelectorAll("tr[data-model-setup-role]")).toHaveLength(2);

		await click(button(translate("modelSetup.review.apply")));

		expect(harness.rpc.setModelRole).not.toHaveBeenCalled();
		expect(harness.rpc.setSetting).not.toHaveBeenCalled();
		const last = useToastStore.getState().toasts.at(-1);
		expect(last?.variant).toBe("info");
		expect(last?.message).toBe(translate("modelSetup.apply.nothing"));
	});

	it("cancel during the research aborts the run and returns to the picker", async () => {
		const harness = install();
		await mount();
		await click(button(translate("modelSetup.pick.start")));
		expect(step()).toBe("research");

		await click(button(translate("modelSetup.research.cancel")));
		expect(harness.abort).toHaveBeenCalledTimes(1);
		expect(harness.abort).toHaveBeenCalledWith(undefined);

		await act(async () => {
			harness.finish({ success: false, error: "cancelled", cancelled: true });
		});
		expect(step()).toBe("pick");
		expect(harness.rpc.setModelRole).not.toHaveBeenCalled();
		expect(harness.prefsSet.mock.calls.some(([key]) => key === MODEL_SETUP_PREFS_KEY)).toBe(false);
	});
});
