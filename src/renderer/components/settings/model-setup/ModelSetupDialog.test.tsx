/**
 * ModelSetupDialog contract: full auto opens straight onto a zero-token proposal over subscription and free models,
 * a hand-set role is kept unticked, Apply writes only the ticked rows and stores the record Undo uses, picked mode
 * plans over the picked models (metered ones included), quota headroom steers the plan, and "Find more evidence"
 * shows its cost before the research runs and lays its picks over the rows.
 * linkedom harness per AGENTS.md; stores reset in afterEach (never mock.module).
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelSetupFacts } from "../../../../../resources/gui-bridge/model-setup-contracts";
import type { IpcModelSetupRunResult } from "../../../../shared/ipc-types";
import type { ModelSetupPlan, ModelSetupRequest, ModelSetupStatus } from "../../../../shared/model-setup";
import type { ModelRoleEntry, UsageReport } from "../../../../shared/rpc-types";
import { I18nProvider, translate } from "../../../lib/i18n";
import { useModelStore } from "../../../stores/model";
import { useSessionStore } from "../../../stores/session";
import { useToastStore } from "../../../stores/toast";
import { useUiStore } from "../../../stores/ui";
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

const POOL: ModelRoleEntry["candidates"] = [
	{ provider: "anthropic", id: "opus", name: "Opus", kind: "chat" },
	{ provider: "anthropic", id: "haiku", name: "Haiku", kind: "chat" },
	{ provider: "openai", id: "gpt-5", name: "GPT-5", kind: "chat" },
	{ provider: "openrouter", id: "deepseek", name: "DeepSeek", kind: "chat" },
];
const IMAGE = [{ provider: "openai", id: "dalle", name: "DALL·E", kind: "image" as const }];

const ROLES: ModelRoleEntry[] = [
	{
		id: "default",
		name: "Default",
		section: "chat",
		source: "settings",
		model: "anthropic/opus:high",
		candidates: POOL,
	},
	{ id: "smol", name: "Fast", section: "chat", source: "settings", model: "anthropic/opus", candidates: POOL },
	{ id: "slow", name: "Thinking", section: "chat", source: "default", candidates: POOL },
	{ id: "advisor", name: "Advisor", section: "chat", source: "default", candidates: POOL },
	{ id: "secret", name: "Hidden", section: "chat", source: "default", hidden: true, candidates: [] },
	{
		id: "image",
		name: "Image generation",
		section: "kind",
		source: "default",
		candidates: IMAGE,
		effective: { model: "openai/dalle", name: "DALL·E", source: "fallback" },
	},
];

const model = (
	provider: string,
	id: string,
	name: string,
	extra: Partial<ModelSetupFacts["models"][string]>,
): ModelSetupFacts["models"][string] => ({ provider, id, name, kind: "chat", image: false, ...extra });

/** smol is set by hand (config.yml holds a value no setup wrote); the plan wants haiku there. */
const FACTS: ModelSetupFacts = {
	providers: {
		anthropic: { billing: "subscription", basis: "oauth" },
		openai: { billing: "subscription", basis: "oauth" },
		openrouter: { billing: "metered", basis: "api-key" },
	},
	models: {
		"anthropic/opus": model("anthropic", "opus", "Opus", {
			int: 80,
			inputPrice: 5,
			outputPrice: 25,
			family: "claude",
			image: true,
		}),
		"anthropic/haiku": model("anthropic", "haiku", "Haiku", {
			int: 60,
			inputPrice: 1,
			outputPrice: 5,
			family: "claude",
		}),
		"openai/gpt-5": model("openai", "gpt-5", "GPT-5", { int: 78, inputPrice: 1.25, outputPrice: 10, family: "gpt" }),
		"openrouter/deepseek": model("openrouter", "deepseek", "DeepSeek", {
			int: 62,
			inputPrice: 0.3,
			outputPrice: 0.5,
			family: "deepseek",
		}),
		"openai/dalle": model("openai", "dalle", "DALL·E", { kind: "image" }),
	},
	roles: { default: { persisted: "anthropic/opus:high" }, smol: { persisted: "anthropic/opus" } },
	judgePins: [],
};

const PLAN: ModelSetupPlan = {
	assignments: [
		{ role: "slow", model: "openai/gpt-5", reason: "Best reasoning on public leaderboards." },
		{ role: "advisor", model: "openrouter/deepseek", reason: "Outside the full-auto pool." },
	],
	advisor: { enable: true, reason: "" },
	sources: [{ title: "Leaderboard", url: "https://example.com/board" }],
	notes: "Prices as of today.",
};

type RunResearch = (request: ModelSetupRequest, device?: string) => Promise<IpcModelSetupRunResult>;

function install({
	stored,
	reports = [],
	roles = ROLES,
}: {
	stored?: unknown;
	reports?: UsageReport[];
	roles?: ModelRoleEntry[];
} = {}) {
	let pending = Promise.withResolvers<IpcModelSetupRunResult>();
	const rpc = {
		getModelRoles: vi.fn(async () => ({ success: true, data: { roles } })),
		getModelSetupFacts: vi.fn(async () => ({ success: true, data: FACTS })),
		getUsage: vi.fn(async () => ({ success: true, data: { reports } })),
		setModelRole: vi.fn(
			async (_role: string, _model: string | null): Promise<{ success: boolean; error?: string }> => ({
				success: true,
			}),
		),
	};
	const run = vi.fn<RunResearch>(() => {
		pending = Promise.withResolvers<IpcModelSetupRunResult>();
		return pending.promise;
	});
	const abort = vi.fn(async () => true);
	const status = vi.fn<() => Promise<ModelSetupStatus>>(async () => ({ running: true }));
	const prefsSet = vi.fn<(key: string, value: unknown) => Promise<void>>(async () => {});
	(window as unknown as { omp?: unknown }).omp = {
		rpc,
		prefs: {
			get: vi.fn(async (key: string) => (key === MODEL_SETUP_PREFS_KEY ? stored : undefined)),
			set: prefsSet,
		},
		modelSetup: { run, abort, status },
		system: { openExternal: vi.fn(async () => {}) },
	};
	/** Settle the pending research run. */
	const finish = (result: IpcModelSetupRunResult) => pending.resolve(result);
	return { rpc, run, abort, prefsSet, finish, status };
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

function mode(): string | null {
	return document.querySelector("[data-model-setup-mode]")?.getAttribute("data-model-setup-mode") ?? null;
}

function row(role: string): TestElement {
	const found = document.querySelector(`[data-model-setup-role="${role}"]`);
	if (!found) throw new Error(`no row for role ${role}`);
	return found as unknown as TestElement;
}

const rowIds = () =>
	[...document.querySelectorAll("[data-model-setup-role]")].map(el => el.getAttribute("data-model-setup-role"));
const rowModel = (role: string) => row(role).querySelector("[data-model-setup-model]")?.textContent;
const rowState = (role: string) => row(role).getAttribute("data-model-setup-state");
const tickBox = (role: string) =>
	row(role).querySelector("input[data-model-setup-tick]") as unknown as { checked: boolean } | null;

function pickedModels(): string[] {
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

/** Drive a controlled checkbox's React onChange: linkedom does not toggle `checked` on a click. */
async function setChecked(input: TestElement | Element, checked: boolean): Promise<void> {
	const record = input as unknown as Record<string, unknown>;
	const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
	const props = propsKey ? (record[propsKey] as { onChange?: (event: object) => void }) : undefined;
	if (!props?.onChange) throw new Error("checkbox has no onChange");
	await act(async () => props.onChange?.({ target: { checked }, currentTarget: { checked } }));
}

const tick = (role: string, checked: boolean) => {
	const box = row(role).querySelector("input[data-model-setup-tick]");
	if (!box) throw new Error(`no checkbox on ${role}`);
	return setChecked(box, checked);
};

async function pickMode(): Promise<void> {
	await click(button(translate("modelSetup.mode.picked")));
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

describe("ModelSetupDialog full auto", () => {
	it("opens on its proposal with zero model calls and never proposes a metered model", async () => {
		const harness = install();
		await mount();

		expect(mode()).toBe("full");
		expect(harness.rpc.getModelRoles).toHaveBeenCalledTimes(1);
		expect(harness.rpc.getModelSetupFacts).toHaveBeenCalledTimes(1);
		expect(harness.run).not.toHaveBeenCalled();
		expect(harness.rpc.setModelRole).not.toHaveBeenCalled();
		// One row per visible role, in get_model_roles order (the hidden role is left out).
		expect(rowIds()).toEqual(["default", "smol", "slow", "advisor", "image"]);
		const models = rowIds().map(role => rowModel(role ?? ""));
		expect(models).toEqual(["Opus", "Haiku", "Opus", "GPT-5", "DALL·E"]);
		expect(document.body.textContent).not.toContain("DeepSeek");
	});

	it("groups the rows under their purpose headings", async () => {
		install();
		await mount();
		const groups = [...document.querySelectorAll("[data-model-setup-group]")].map(section => [
			section.getAttribute("data-model-setup-group"),
			[...section.querySelectorAll("[data-model-setup-role]")].map(el => el.getAttribute("data-model-setup-role")),
		]);
		expect(groups).toEqual([
			["conversation", ["default", "smol", "slow"]],
			["agent", ["advisor"]],
			["io", ["image"]],
		]);
		expect(document.querySelector('[data-model-setup-group="agent"] h3')?.textContent).toBe(
			translate("modelRoles.group.agent"),
		);
	});

	it("plans and lists a role this code has never heard of from its own chain, like OMPdesk's review", async () => {
		const review: ModelRoleEntry = {
			id: "review",
			name: "Review",
			section: "chat",
			source: "default",
			defaults: ["@review", "@advisor", "@slow", "@task"],
			candidates: POOL,
		};
		install({ roles: [...ROLES, review] });
		await mount();

		expect(rowIds()).toContain("review");
		// Its chain falls to the advisor: another family's strong model, never the default's.
		expect(rowModel("review")).toBe("GPT-5");
		expect(
			document.querySelector('[data-model-setup-group="agent"] [data-model-setup-role="review"]'),
		).not.toBeNull();
	});

	it("keeps a hand-set role unticked, leaves a stock role without a checkbox and marks a role already on its model", async () => {
		install();
		await mount();

		expect(rowState("default")).toBe("unchanged");
		expect(row("default").textContent).toContain(translate("modelSetup.row.unchanged"));
		expect(tickBox("default")?.checked).toBe(false);
		expect(rowState("smol")).toBe("manual");
		expect(row("smol").textContent).toContain(translate("modelSetup.row.manual"));
		expect(tickBox("smol")?.checked).toBe(false);
		expect(tickBox("slow")?.checked).toBe(true);
		expect(tickBox("advisor")?.checked).toBe(true);
		// The image role is stock's own: its current model, muted, no checkbox.
		expect(rowState("image")).toBe("stock");
		expect(tickBox("image")).toBeNull();
		expect(row("image").textContent).toContain(translate("modelSetup.row.stock"));
		expect(rowModel("image")).toBe("DALL·E");
	});

	it("says why behind the row's info glyph, never in a paragraph under the row", async () => {
		install();
		await mount();
		const advisor = row("advisor");
		expect(advisor.querySelector("[data-setting-info]")).not.toBeNull();
		expect(advisor.textContent).toContain("from a different vendor than your default");
		expect(advisor.textContent).toContain("int 78 of 80");
		expect(advisor.textContent).toContain("Subscription.");
		expect(advisor.querySelector("p")).toBeNull();
	});

	it("writes only the ticked rows, stores what it wrote and what each role held, and closes", async () => {
		const harness = install();
		await mount();

		await click(button(translate("modelSetup.review.apply")));

		expect(harness.rpc.setModelRole.mock.calls).toEqual([
			["slow", "anthropic/opus"],
			["advisor", "openai/gpt-5"],
		]);
		const stored = harness.prefsSet.mock.calls.find(([key]) => key === MODEL_SETUP_PREFS_KEY)?.[1] as
			| Record<string, { applied: { at: number; values: unknown; before: unknown }; signature: string }>
			| undefined;
		expect(stored?.local?.applied.values).toEqual({ slow: "anthropic/opus", advisor: "openai/gpt-5" });
		expect(stored?.local?.applied.before).toEqual({ slow: null, advisor: null });
		expect(typeof stored?.local?.applied.at).toBe("number");
		expect(stored?.local?.signature).toContain("default=");
		const last = useToastStore.getState().toasts.at(-1);
		expect(last?.variant).toBe("success");
		expect(last?.message).toBe(translate("modelSetup.apply.done", { count: 2 }));
		expect(useUiStore.getState().modelSetupOpen).toBe(false);
	});

	it("overwrites a hand-set role only when the person ticks it, remembering its value", async () => {
		const harness = install();
		await mount();

		await tick("smol", true);
		await tick("advisor", false);
		await click(button(translate("modelSetup.review.apply")));

		expect(harness.rpc.setModelRole.mock.calls).toEqual([
			["smol", "anthropic/haiku"],
			["slow", "anthropic/opus"],
		]);
		const stored = harness.prefsSet.mock.calls.find(([key]) => key === MODEL_SETUP_PREFS_KEY)?.[1] as
			| Record<string, { applied: { before: unknown } }>
			| undefined;
		expect(stored?.local?.applied.before).toEqual({ smol: "anthropic/opus", slow: null });
	});

	it("keeps only the roles that were written when some writes fail", async () => {
		const harness = install();
		harness.rpc.setModelRole.mockImplementation(async role =>
			role === "slow" ? { success: false, error: "no such model" } : { success: true },
		);
		await mount();

		await click(button(translate("modelSetup.review.apply")));

		const last = useToastStore.getState().toasts.at(-1);
		expect(last?.variant).toBe("error");
		expect(last?.message).toBe(translate("modelSetup.apply.partial", { count: 1, failed: 1 }));
		expect(last?.detail).toContain("slow: no such model");
		const writes = harness.prefsSet.mock.calls.filter(([key]) => key === MODEL_SETUP_PREFS_KEY);
		const final = writes.at(-1)?.[1] as Record<string, { applied: { values: unknown } }>;
		expect(final.local?.applied.values).toEqual({ advisor: "openai/gpt-5" });
		// The dialog stays open on the failure.
		expect(useUiStore.getState().modelSetupOpen).toBe(true);
	});

	it("shifts a role off a provider that is nearly out of quota when another qualifies", async () => {
		install({
			reports: [{ provider: "anthropic", fetchedAt: 0, limits: [{ id: "5h", label: "5h", usedFraction: 0.95 }] }],
		});
		await mount();
		// anthropic has 5 % left: the strong roles and the default move to the roomier subscription.
		expect(rowModel("slow")).toBe("GPT-5");
		expect(rowModel("default")).toBe("GPT-5");
		expect(row("slow").textContent).toContain("Subscription.");
	});

	it("reads a stored apply record: a role the last setup wrote is not shown as set by hand", async () => {
		install({
			stored: {
				local: {
					applied: { at: 1, values: { smol: "anthropic/opus" }, before: { smol: null } },
					signature: "old",
				},
			},
		});
		await mount();
		expect(rowState("smol")).toBe("plan");
		expect(tickBox("smol")?.checked).toBe(true);
	});

	it("treats an old proposal record as nothing", async () => {
		install({ stored: { local: { savedAt: 1, researchModel: "a/b", models: [], plan: {}, dropped: [] } } });
		await mount();
		expect(rowState("smol")).toBe("manual");
	});
});

describe("ModelSetupDialog picked mode", () => {
	it("prefills the checklist with the models full auto chose and marks metered ones", async () => {
		install();
		await mount();
		await pickMode();

		expect(mode()).toBe("picked");
		expect(pickedModels().sort()).toEqual(["anthropic/haiku", "anthropic/opus", "openai/gpt-5"]);
		// Every chat model of the default pool is listed; the image model is not.
		expect(document.querySelector('input[data-model-setup-model="openrouter/deepseek"]')).not.toBeNull();
		expect(document.querySelector('input[data-model-setup-model="openai/dalle"]')).toBeNull();
		const metered = document.querySelector('input[data-model-setup-model="openrouter/deepseek"]')?.closest("label");
		expect(metered?.textContent).toContain(translate("modelSetup.pick.metered"));
		const free = document.querySelector('input[data-model-setup-model="anthropic/opus"]')?.closest("label");
		expect(free?.textContent).not.toContain(translate("modelSetup.pick.metered"));
		expect(document.querySelector("[data-model-setup-count]")?.textContent).toBe(
			translate("modelSetup.pick.count", { count: 3 }),
		);
	});

	it("plans over a picked metered model and says it is metered", async () => {
		const harness = install();
		await mount();
		await pickMode();
		const deepseek = document.querySelector('input[data-model-setup-model="openrouter/deepseek"]');
		if (!deepseek) throw new Error("no deepseek checkbox");
		await setChecked(deepseek, true);

		// deepseek is the cheapest model within 70 % of the top intelligence.
		expect(rowModel("smol")).toBe("DeepSeek");
		expect(row("smol").textContent).toContain("Metered (billed per use): billed through a stored API key.");
		await tick("smol", true);
		await click(button(translate("modelSetup.review.apply")));
		expect(harness.rpc.setModelRole).toHaveBeenCalledWith("smol", "openrouter/deepseek");
	});

	it("has no count cap on the checklist", async () => {
		install();
		await mount();
		await pickMode();
		for (const input of document.querySelectorAll("input[data-model-setup-model]")) await setChecked(input, true);
		expect(pickedModels()).toHaveLength(4);
		expect(document.querySelector("[data-model-setup-count]")?.textContent).toBe(
			translate("modelSetup.pick.count", { count: 4 }),
		);
	});

	it("filters the checklist by name", async () => {
		install();
		await mount();
		await pickMode();
		const field = document.querySelector("input[type='search']");
		if (!field) throw new Error("no search field");
		const record = field as unknown as Record<string, unknown>;
		const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
		const props = propsKey ? (record[propsKey] as { onChange?: (event: object) => void }) : undefined;
		await act(async () => props?.onChange?.({ target: { value: "deep" }, currentTarget: { value: "deep" } }));
		expect(
			[...document.querySelectorAll("input[data-model-setup-model]")].map(input =>
				input.getAttribute("data-model-setup-model"),
			),
		).toEqual(["openrouter/deepseek"]);
	});
});

describe("ModelSetupDialog Find more evidence", () => {
	it("shows the cost and time before anything runs, then researches with the plan's default model", async () => {
		const harness = install();
		await mount();

		await click(button(translate("modelSetup.evidence.open")));
		expect(harness.run).not.toHaveBeenCalled();
		const confirm = document.querySelector("[data-model-setup-confirm]");
		expect(confirm?.textContent).toContain("Opus");
		expect(confirm?.textContent).toContain(translate("modelSetup.evidence.costSubscription"));
		expect(confirm?.textContent).toContain("about 1 min");

		await click(button(translate("modelSetup.evidence.run")));
		expect(harness.run).toHaveBeenCalledTimes(1);
		const request = harness.run.mock.calls[0]?.[0];
		expect(request?.researchModel).toBe("anthropic/opus");
		expect(request?.defaultModel).toBe("anthropic/opus");
		// Full auto researches over the non-metered chat models and the chat rows.
		expect(request?.models.map(entry => entry.selector).sort()).toEqual([
			"anthropic/haiku",
			"anthropic/opus",
			"openai/gpt-5",
		]);
		expect(request?.roles.map(entry => entry.id)).toEqual(["default", "smol", "slow", "advisor"]);
		expect(document.querySelector("[data-model-setup-activity]")?.textContent).toBe(
			translate("modelSetup.research.starting"),
		);

		await act(async () => {
			harness.finish({ success: true, plan: PLAN, dropped: ['unknown role "reviewer"'] });
		});
		await act(async () => {});
		// slow takes the research's pick with its reason; advisor's pick is outside the pool and is ignored.
		expect(rowModel("slow")).toBe("GPT-5");
		expect(row("slow").textContent).toContain("Best reasoning on public leaderboards.");
		expect(rowModel("advisor")).toBe("GPT-5");
		expect(row("advisor").textContent).not.toContain("Outside the full-auto pool.");
		expect(document.body.textContent).toContain("Leaderboard");
		expect(document.body.textContent).toContain(translate("modelSetup.review.dropped", { count: 1 }));
		expect(harness.rpc.setModelRole).not.toHaveBeenCalled();
	});

	it("says billed with a price when the research model is metered", async () => {
		install();
		await mount();
		await pickMode();
		const deepseek = document.querySelector('input[data-model-setup-model="openrouter/deepseek"]');
		if (!deepseek) throw new Error("no deepseek checkbox");
		// Only the metered model picked: it becomes the default row's model, so it researches.
		for (const input of document.querySelectorAll("input[data-model-setup-model]")) {
			await setChecked(input, input === deepseek);
		}
		await click(button(translate("modelSetup.evidence.open")));
		// (0.1M × $0.3 + 0.005M × $0.5) = $0.0325 → "$0.03".
		expect(document.querySelector("[data-model-setup-confirm]")?.textContent).toContain(
			translate("modelSetup.evidence.costBilled", { usd: "$0.03" }),
		);
	});

	it("cancel during the research aborts the run and leaves the proposal alone", async () => {
		const harness = install();
		await mount();
		await click(button(translate("modelSetup.evidence.open")));
		await click(button(translate("modelSetup.evidence.run")));

		await click(button(translate("modelSetup.research.cancel")));
		expect(harness.abort).toHaveBeenCalledTimes(1);
		expect(harness.abort).toHaveBeenCalledWith(undefined);
		await act(async () => {
			harness.finish({ success: false, error: "cancelled", cancelled: true });
		});
		expect(document.querySelector("[role='alert']")).toBeNull();
		expect(rowModel("slow")).toBe("Opus");
		expect(harness.rpc.setModelRole).not.toHaveBeenCalled();
		expect(harness.prefsSet.mock.calls.some(([key]) => key === MODEL_SETUP_PREFS_KEY)).toBe(false);
	});

	it("shows a failed run's error and keeps the rules' proposal", async () => {
		const harness = install();
		await mount();
		await click(button(translate("modelSetup.evidence.open")));
		await click(button(translate("modelSetup.evidence.run")));
		await act(async () => {
			harness.finish({ success: false, error: "omp exited" });
		});
		expect(document.querySelector("[role='alert']")?.textContent).toContain(translate("modelSetup.research.failed"));
		expect(rowModel("slow")).toBe("Opus");
	});

	it("shows the research run's latest tool call from its machine, polled each second", async () => {
		const harness = install();
		harness.status.mockResolvedValue({
			running: true,
			activity: { tool: "web_search", detail: "coding model leaderboard" },
		});
		await mount();
		await click(button(translate("modelSetup.evidence.open")));
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		try {
			await click(button(translate("modelSetup.evidence.run")));
			const line = () => document.querySelector("[data-model-setup-activity]")?.textContent;
			expect(line()).toBe(translate("modelSetup.research.starting"));
			await act(async () => {
				vi.advanceTimersByTime(1_000);
			});
			await act(async () => {});
			expect(line()).toBe(translate("modelSetup.research.searching", { detail: "coding model leaderboard" }));
		} finally {
			vi.useRealTimers();
		}
		await act(async () => harness.finish({ success: false, error: "cancelled", cancelled: true }));
	});
});
