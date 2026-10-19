/**
 * Settings › Models & accounts › Model roles, grouped by purpose: every row
 * says when the role is used, which model it really runs on (stock's own
 * resolution, empty-role fallbacks included), the account state of that
 * model's provider with its live quota and the thinking level. Only stock's
 * built-in roles are listed; OMPdesk offers no custom roles. linkedom harness
 * per AGENTS.md; stores reset in afterEach.
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ROLE_GROUPS } from "../../../../resources/gui-bridge/model-role-contracts";
import type { ModelRoleEntry, ProviderInfo } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { en } from "../../locales/en";
import { ko } from "../../locales/ko";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { useUiStore } from "../../stores/ui";

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
const { ModelRolesSection } = await import("./ModelRolesSection");

let root: Root;

const chat = [
	{ provider: "anthropic", id: "sonnet", name: "Claude Sonnet", kind: "chat" as const },
	{ provider: "openai", id: "gpt", name: "GPT", kind: "chat" as const },
];

function role(id: string, name: string, extra: Partial<ModelRoleEntry> = {}): ModelRoleEntry {
	return {
		id,
		name,
		section: "chat",
		source: "default",
		candidates: chat,
		...extra,
	};
}

// Deliberately not in display order: the section orders rows by purpose.
const ROLES: ModelRoleEntry[] = [
	role("image", "Image generation", {
		section: "kind",
		candidates: [{ provider: "openai", id: "dalle", name: "DALL·E", kind: "image" }],
		effective: { model: "openai/dalle", name: "DALL·E", source: "fallback" },
	}),
	role("memory", "Memory"),
	role("tiny", "Tiny", {
		effective: { model: "openai/gpt", name: "GPT", source: "fallback", via: "smol" },
	}),
	role("plan", "Architect", { effective: { model: "anthropic/sonnet", name: "Claude Sonnet", source: "session" } }),
	role("smol", "Fast", {
		model: "openai/gpt",
		effective: { model: "openai/gpt", name: "GPT", source: "configured" },
	}),
	role("default", "Default", {
		model: "anthropic/sonnet",
		effective: { model: "anthropic/sonnet", name: "Claude Sonnet", source: "configured", thinkingLevel: "high" },
	}),
	role("slow", "Thinking", {
		model: "anthropic/gone",
		effective: { source: "none", unavailable: true },
	}),
	role("task", "Subtask", { effective: { model: "anthropic/sonnet", name: "Claude Sonnet", source: "session" } }),
];

const PROVIDERS: ProviderInfo[] = [
	{
		id: "anthropic",
		name: "Anthropic",
		authenticated: true,
		authKind: "oauth",
		loginAvailable: true,
		disabled: false,
		modelCount: 3,
	},
	{ id: "openai", name: "OpenAI", authenticated: false, loginAvailable: true, disabled: false, modelCount: 5 },
	{ id: "typesafe", name: "TypeSafe", authenticated: false, loginAvailable: true, disabled: false, modelCount: 2 },
	{
		id: "openrouter",
		name: "OpenRouter",
		authenticated: false,
		loginAvailable: true,
		disabled: false,
		modelCount: 900,
	},
];

const USAGE = {
	reports: [
		{
			provider: "anthropic",
			fetchedAt: 1,
			active: true,
			limits: [
				{ id: "anthropic:5h", label: "Claude 5 Hour", usedFraction: 0.42 },
				{ id: "anthropic:7d", label: "Claude 7 Day", usedFraction: 0.1 },
			],
		},
	],
	session: {},
};

const ok = (data: unknown) => ({ success: true, data });

function installRpc(extra: Record<string, unknown> = {}, roles: ModelRoleEntry[] = ROLES) {
	const rpc = {
		getModelRoles: vi.fn(async () => ok({ roles })),
		setModelRole: vi.fn(async () => ({ success: true })),
		getUsage: vi.fn(async () => ok(USAGE)),
		...extra,
	};
	(window as unknown as { omp?: unknown }).omp = { rpc, events: { onConfigUpdate: () => () => {} } };
	return rpc;
}

async function mount(element: ReactElement = <ModelRolesSection />): Promise<void> {
	useSessionStore.getState().setStatus("ready", "/repo");
	useModelStore.setState({ providers: PROVIDERS });
	root = createRoot(document.body as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
	await act(async () => {});
}

const row = (id: string) => document.body.querySelector<HTMLElement>(`#model-role-${id}`);
const rowText = (id: string) => row(id)?.textContent ?? "";

function button(label: string | RegExp, within: ParentNode = document.body): HTMLButtonElement | undefined {
	return [...within.querySelectorAll("button")].find(candidate => {
		const text = (candidate.getAttribute("aria-label") ?? candidate.textContent ?? "").trim();
		return typeof label === "string" ? text === label : label.test(text);
	}) as HTMLButtonElement | undefined;
}

afterEach(async () => {
	await act(async () => root?.unmount());
	delete (window as unknown as { omp?: unknown }).omp;
	useSessionStore.getState().reset();
	useModelStore.setState({ providers: [] });
	useUiStore.setState({ providerFocus: null, destination: "session", settingsTab: "general" });
	vi.restoreAllMocks();
});

describe("Model roles grouped by purpose", () => {
	it("lists stock's roles under Conversation, Agent work and Input & output, in that order, with no custom roles", async () => {
		installRpc();
		await mount();

		const headings = [...document.body.querySelectorAll("h5")].map(heading => heading.textContent);
		expect(headings).toEqual(["Conversation", "Agent work", "Input & output"]);
		expect(button("Add role")).toBeUndefined();
		const order = [...document.body.querySelectorAll("[data-setting-row]")].map(element =>
			element.id.replace("model-role-", ""),
		);
		expect(order).toEqual(["default", "slow", "smol", "plan", "task", "tiny", "image"]);
		// Stock keeps the memory role; OMPdesk does not list it (ai-memory replaced stock's memory backends).
		expect(order).not.toContain("memory");
	});

	it("has a localized when-used line for every built-in role in English and Korean", () => {
		for (const id of ROLE_GROUPS.flatMap(group => group.roles)) {
			for (const [lang, messages] of [
				["en", en],
				["ko", ko],
			] as const) {
				const key = `modelRoles.use.${id}`;
				const text = (messages as Record<string, string>)[key];
				expect(text?.length, `${lang} ${key}`).toBeGreaterThan(10);
			}
		}
		// Every built-in names what an empty role falls back to.
		for (const id of ROLE_GROUPS.flatMap(group => group.roles))
			expect((en as Record<string, string>)[`modelRoles.fallback.${id}`], id).toBeTruthy();
	});

	it("shows when a role is used, the model it runs on and where an empty role's model comes from", async () => {
		installRpc();
		await mount();

		expect(rowText("plan")).toContain(translate("modelRoles.use.plan"));
		expect(rowText("smol")).toContain("Quick, cheap work");
		// Configured: the model alone.
		expect(rowText("smol")).toContain("GPT");
		// Empty Tiny: stock follows Fast, and the row says so beside the model it ends up on.
		expect(rowText("tiny")).toContain("GPT");
		expect(rowText("tiny")).toContain("from Fast");
		expect(rowText("tiny")).toContain(translate("modelRoles.fallback.tiny"));
		// Empty Plan keeps the session's model.
		expect(rowText("plan")).toContain("Claude Sonnet");
		expect(rowText("plan")).toContain("session model");
		// A role whose model is gone says so instead of looking empty.
		expect(rowText("slow")).toContain("Not available");
	});

	it("shows the account state of the effective model's provider with its live quota", async () => {
		const { getUsage } = installRpc();
		await mount();

		expect(getUsage).toHaveBeenCalled();
		// Anthropic: signed in, 42% of the tightest limit (5 hours) used.
		expect(rowText("default")).toContain("Signed in");
		expect(rowText("default")).toContain("42% used");
		// OpenAI is not signed in and has no quota to show.
		expect(rowText("smol")).toContain("Not signed in");
		expect(rowText("smol")).not.toContain("% used");
	});

	it("shows the thinking level a role names, or that the session's applies", async () => {
		installRpc();
		await mount();

		expect(rowText("default")).toContain(`Thinking: ${translate("input.thinking.name.high")}`);
		expect(rowText("smol")).toContain("Thinking: follows session");
	});

	it("names the auto level the advisor is written with instead of printing it raw", async () => {
		installRpc({}, [
			...ROLES,
			role("advisor", "Advisor", {
				model: "anthropic/sonnet",
				effective: {
					model: "anthropic/sonnet",
					name: "Claude Sonnet",
					source: "configured",
					thinkingLevel: "auto",
				},
			}),
		]);
		await mount();

		expect(rowText("advisor")).toContain(`Thinking: ${translate("input.thinking.name.auto")}`);
	});

	it("keeps the picker on stock's candidate pool for the role", async () => {
		installRpc();
		await mount();

		const trigger = button("Model for Image generation");
		await act(async () => trigger?.click());
		const options = [...document.body.querySelectorAll('[role="option"]')].map(option => option.textContent ?? "");
		expect(options.join(" ")).toContain("openai/dalle");
		expect(options.join(" ")).not.toContain("anthropic/sonnet");
	});

	describe("the judge role's link to the small decisions it makes", () => {
		it("opens Smart automation's judge row from the judge role only", async () => {
			installRpc({}, [...ROLES, role("judge", "Judge", { section: "kind" })]);
			await mount();

			expect(row("judge")?.querySelectorAll("[data-judge-assist-link]")).toHaveLength(1);
			expect(document.body.querySelectorAll("[data-judge-assist-link]")).toHaveLength(1);
			expect(rowText("judge")).toContain(translate("modelRoles.judgeSmallDecisions"));
			expect(row("image")?.querySelector("[data-judge-assist-link]")).toBeNull();

			await act(async () => row("judge")?.querySelector<HTMLElement>("[data-judge-assist-link]")?.click());
			expect(useUiStore.getState().destination).toBe("settings");
			expect(useUiStore.getState().settingsTab).toBe("agent:setting-gui-judgeAssist");
		});
	});

	describe("a stock-preferred model the role cannot use for want of a key", () => {
		const SKIPPED = {
			name: "Jev 1.14",
			model: "typesafe/jev-1.14",
			kind: "judge",
			providers: ["typesafe", "openrouter"],
		};
		const judge = (extra: Partial<ModelRoleEntry["effective"]> = {}) =>
			role("judge", "Judge", {
				section: "kind",
				effective: { model: "openai/gpt", name: "GPT", source: "fallback", ...extra },
			});

		it("shows one muted line naming the model and each provider that would lift the skip, as links to their cards", async () => {
			installRpc({}, [...ROLES, judge({ skipped: SKIPPED })]);
			await mount();

			const hint = row("judge")?.querySelector<HTMLElement>("[data-role-skipped]");
			expect(hint?.dataset.roleSkipped).toBe("typesafe/jev-1.14");
			expect(hint?.textContent).toContain("Jev 1.14 needs a key from TypeSafe or OpenRouter");
			expect(
				[...(hint?.querySelectorAll("button[data-provider-link]") ?? [])].map(link => link.textContent),
			).toEqual(["TypeSafe", "OpenRouter"]);
			// The benefit is behind the (i), never in the line: a native judge is cheaper; stock claims nothing about speed.
			expect(hint?.textContent).toContain(translate("modelRoles.skipped.infoJudge"));
			expect(hint?.textContent).toContain("GPT answers instead");
			expect(hint?.querySelectorAll("[data-setting-info]")).toHaveLength(1);
			// No other row carries it.
			expect(document.body.querySelectorAll("[data-role-skipped]")).toHaveLength(1);
		});

		it("opens that provider's card in Providers & accounts from its link", async () => {
			installRpc({}, [...ROLES, judge({ skipped: SKIPPED })]);
			await mount();

			await act(async () => button("OpenRouter", row("judge") ?? document.body)?.click());

			expect(useUiStore.getState().providerFocus).toEqual({ id: "openrouter" });
			expect(useUiStore.getState().destination).toBe("settings");
			expect(useUiStore.getState().settingsTab).toBe("models");
		});

		it("shows nothing when the bridge reports no skipped model, and no link for a provider the list does not know", async () => {
			installRpc({}, [...ROLES, judge()]);
			await mount();
			expect(document.body.querySelector("[data-role-skipped]")).toBeNull();
			await act(async () => root.unmount());

			installRpc({}, [...ROLES, judge({ skipped: { ...SKIPPED, providers: ["typesafe", "elsewhere"] } })]);
			await mount();
			const hint = row("judge")?.querySelector<HTMLElement>("[data-role-skipped]");
			expect(hint?.textContent).toContain("Jev 1.14 needs a key from TypeSafe or elsewhere");
			expect(
				[...(hint?.querySelectorAll("button[data-provider-link]") ?? [])].map(link => link.textContent),
			).toEqual(["TypeSafe"]);
		});

		it("has the line and its tooltips in English and Korean with every slot the row fills", () => {
			for (const messages of [en, ko] as const) {
				const text = messages as Record<string, string>;
				expect(text["modelRoles.skipped"]).toContain("{model}");
				expect(text["modelRoles.skipped"]).toContain("{providers}");
				expect(text["modelRoles.skipped.info"]).toContain("{model}");
				expect(text["modelRoles.skipped.info"]).toContain("{using}");
				expect(text["modelRoles.skipped.open"]).toContain("{provider}");
				expect(text["modelRoles.skipped.infoJudge"]?.length).toBeGreaterThan(10);
			}
		});
	});
});
