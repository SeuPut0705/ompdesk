/**
 * Tests for the model comparison section: the pure row-derivation
 * (buildModelRows) and cost-formatting contracts that drive the matrix, plus
 * mounted assertions on what a row is allowed to commit and the benchmark
 * hand-off.
 */

import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	ModelInfo,
	ModelRoleEntry,
	ProviderInfo,
	RpcCommand,
	RpcResponse,
	UsageReport,
} from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { useModelStore } from "../../stores/model";
import { useSessionStore } from "../../stores/session";
import { useToastStore } from "../../stores/toast";
import { buildModelRows, ModelCompareSection } from "./ModelCompareSection";

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
(globalThis as Record<string, unknown>).requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

function model(partial: ModelInfo): ModelInfo {
	return { ...partial };
}

function provider(partial: Partial<ProviderInfo> & { id: string }): ProviderInfo {
	return { name: partial.id, authenticated: true, loginAvailable: false, disabled: false, modelCount: 1, ...partial };
}

function role(partial: Partial<ModelRoleEntry> & { id: string }): ModelRoleEntry {
	return {
		name: partial.id,
		tag: partial.id.toUpperCase(),
		color: "default",
		source: "settings",
		section: "chat",
		candidates: [],
		...partial,
	};
}

function report(partial: Partial<UsageReport> & { provider: string }): UsageReport {
	return { fetchedAt: Date.now(), limits: [], ...partial };
}

describe("buildModelRows", () => {
	it("joins provider auth metadata and falls back to the provider id for the name", () => {
		const rows = buildModelRows({
			models: [model({ provider: "anthropic", id: "claude-opus" }), model({ provider: "local", id: "llama" })],
			providers: [provider({ id: "anthropic", name: "Anthropic", authenticated: true, authKind: "oauth" })],
			roles: [],
			usage: [],
		});
		expect(rows[0]).toMatchObject({
			providerName: "Anthropic",
			authKnown: true,
			authenticated: true,
			authKind: "oauth",
		});
		// Provider absent from get_providers: auth unknown, name falls back to id.
		expect(rows[1]).toMatchObject({ providerName: "local", authKnown: false, authenticated: false });
	});

	it("marks auth unknown for every row when the catalog generation carried no provider rows", () => {
		const rows = buildModelRows({
			models: [model({ provider: "openai", id: "gpt-5" })],
			providers: [],
			roles: null,
			usage: null,
		});
		expect(rows[0].authKnown).toBe(false);
		expect(rows[0].roles).toEqual([]);
		expect(rows[0].quota).toBeNull();
	});

	it("matches role assignments by exact provider/id key only", () => {
		const rows = buildModelRows({
			models: [
				model({ provider: "anthropic", id: "claude-opus" }),
				model({ provider: "openai", id: "claude-opus" }),
			],
			providers: [],
			roles: [
				role({ id: "default", model: "anthropic/claude-opus" }),
				role({ id: "smol", model: "claude-opus" }), // bare id — must not match
			],
			usage: null,
		});
		expect(rows[0].roles.map(r => r.id)).toEqual(["default"]);
		expect(rows[1].roles).toEqual([]);
	});

	it("picks the tightest bridge-normalized usage limit per provider, skipping limits without a fraction", () => {
		const usage = [
			report({
				provider: "anthropic",
				limits: [
					{ id: "weekly", label: "Weekly", usedFraction: 0.4 },
					{ id: "hourly", label: "Hourly", usedFraction: 0.9 },
				],
			}),
			report({
				provider: "openai",
				limits: [
					{ id: "req", label: "Requests", used: 30, limit: 60, usedFraction: 0.5 },
					{ id: "unknown", label: "Unknown", used: 99 },
				],
			}),
		];
		const rows = buildModelRows({
			models: [model({ provider: "anthropic", id: "a" }), model({ provider: "openai", id: "b" })],
			providers: [],
			roles: null,
			usage,
		});
		expect(rows[0].quota?.limit.id).toBe("hourly");
		expect(rows[0].quota?.fraction).toBe(0.9);
		expect(rows[1].quota?.limit.id).toBe("req");
		expect(rows[1].quota?.fraction).toBe(0.5);
	});

	it("shows the quota of the account the session uses, not whichever sign-in stock listed last", () => {
		const usage = [
			report({
				provider: "anthropic",
				credentialId: 1,
				active: true,
				limits: [{ id: "5h", label: "5h", usedFraction: 0.2 }],
			}),
			report({ provider: "anthropic", credentialId: 2, limits: [{ id: "5h", label: "5h", usedFraction: 1 }] }),
		];
		const rows = buildModelRows({
			models: [model({ provider: "anthropic", id: "a" })],
			providers: [],
			roles: null,
			usage,
		});
		expect(rows[0].quota?.fraction).toBe(0.2);
	});

	it("reads optional wire metadata defensively: missing cost/context become null, name equal to id is dropped", () => {
		const rows = buildModelRows({
			models: [
				model({
					provider: "p",
					id: "rich",
					name: "Rich Model",
					contextWindow: 200_000,
					cost: { input: 3, output: 15 },
				}),
				model({ provider: "p", id: "bare", name: "bare", contextWindow: null }),
			],
			providers: [],
			roles: null,
			usage: null,
		});
		expect(rows[0]).toMatchObject({ name: "Rich Model", contextWindow: 200_000, costIn: 3, costOut: 15 });
		expect(rows[1]).toMatchObject({ name: null, contextWindow: null, costIn: null, costOut: null });
	});
});

// ---------------------------------------------------------------------------
// What a row may commit. The matrix sets the session model with a single click
// anywhere on the row, so a provider that cannot serve — switched off, or
// known to hold no credential — must not be selectable, while a row whose auth
// merely failed to load stays usable: a degraded read is not evidence of no
// access.
// ---------------------------------------------------------------------------

function providerInfo(id: string, overrides: Partial<ProviderInfo> = {}): ProviderInfo {
	return { id, name: id, authenticated: true, loginAvailable: false, disabled: false, modelCount: 1, ...overrides };
}

function ok(command: string, data?: unknown): RpcResponse {
	return { type: "response", command, success: true, data };
}

const command = vi.fn(
	async (req: RpcCommand): Promise<RpcResponse> =>
		ok(
			req.type,
			req.type === "get_providers"
				? {
						providers: [
							providerInfo("serving"),
							providerInfo("noauth", { authenticated: false }),
							providerInfo("off", { disabled: true }),
						],
						// "unlisted" is deliberately absent from the provider rows above.
						models: [
							{ provider: "serving", id: "serving-model" },
							{ provider: "noauth", id: "noauth-model" },
							{ provider: "off", id: "off-model" },
							{ provider: "unlisted", id: "unlisted-model" },
							{ provider: "serving", id: "named-model", name: "Named Model" },
						],
						discoveryStates: [],
						refreshPending: false,
						generation: 1,
					}
				: undefined,
		),
);

const setModel = vi.fn(async (): Promise<RpcResponse> => ok("set_model"));

Object.assign(window as unknown as Record<string, unknown>, {
	omp: {
		rpc: {
			command,
			setModel,
			setModelRole: vi.fn(async (): Promise<RpcResponse> => ok("set_model_role")),
			getModelRoles: vi.fn(async (): Promise<RpcResponse> => ok("get_model_roles", { roles: [] })),
			getModelRoleMetadata: vi.fn(async (): Promise<RpcResponse> => ok("get_model_role_metadata", { roles: [] })),
			getUsage: vi.fn(async (): Promise<RpcResponse> => ok("get_usage", { reports: [] })),
		},
	},
});

const roots: Root[] = [];

async function mountMatrix(element: ReactElement = <ModelCompareSection onOpenBenchmark={() => {}} />): Promise<void> {
	useSessionStore.setState({ status: "ready" });
	const root = createRoot(document.body as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
	roots.push(root);
}

function rowFor(modelId: string): HTMLElement | undefined {
	return Array.from(document.body.querySelectorAll("tr")).find(tr => (tr.textContent ?? "").includes(modelId)) as
		| HTMLElement
		| undefined;
}

function buttonOfRow(row: HTMLElement): HTMLButtonElement | undefined {
	return Array.from(row.querySelectorAll("button")).find(
		button => (button.textContent ?? "").trim() === translate("modelCompare.use"),
	) as HTMLButtonElement | undefined;
}

afterEach(async () => {
	for (const root of roots) {
		await act(async () => {
			root.unmount();
		});
	}
	roots.length = 0;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useModelStore.getState().reset();
	useSessionStore.getState().reset();
	useToastStore.setState({ toasts: [] });
	command.mockClear();
	setModel.mockClear();
});

describe("ModelCompareSection row availability", () => {
	it("will not point the session at a provider that is off or signed out", async () => {
		await mountMatrix();

		for (const [modelId, reason] of [
			["noauth-model", "modelCompare.blockedNoAuth"],
			["off-model", "modelCompare.blockedDisabled"],
		] as const) {
			const row = rowFor(modelId);
			if (!row) throw new Error(`no row for ${modelId}`);
			expect(buttonOfRow(row)?.hasAttribute("disabled"), `${modelId} Use`).toBe(true);
			expect(row.getAttribute("title")).toBe(translate(reason));
			await act(async () => {
				row.click();
			});
		}

		expect(setModel).not.toHaveBeenCalled();
	});

	it("switches the session model when the row itself is clicked", async () => {
		await mountMatrix();
		const row = rowFor("serving-model");
		if (!row) throw new Error("no row for serving-model");

		await act(async () => {
			row.click();
		});

		expect(row.getAttribute("title")).toBe(translate("modelCompare.useHint"));
		expect(setModel).toHaveBeenCalledWith("serving", "serving-model");
	});

	it("keeps a row usable when the provider list simply did not describe it", async () => {
		await mountMatrix();
		const row = rowFor("unlisted-model");
		if (!row) throw new Error("no row for unlisted-model");

		expect(buttonOfRow(row)?.hasAttribute("disabled")).toBe(false);
		await act(async () => {
			row.click();
		});

		expect(setModel).toHaveBeenCalledWith("unlisted", "unlisted-model");
	});
});

describe("ModelCompareSection benchmark", () => {
	it("hands the live benchmark to the caller instead of opening it itself", async () => {
		const onOpenBenchmark = vi.fn();
		await mountMatrix(<ModelCompareSection onOpenBenchmark={onOpenBenchmark} />);
		const button = Array.from(document.body.querySelectorAll("button")).find(
			candidate => (candidate.textContent ?? "").trim() === translate("modelCompare.runBenchmark"),
		);
		if (!button) throw new Error("no benchmark button");

		await act(async () => {
			button.click();
		});

		expect(onOpenBenchmark).toHaveBeenCalledTimes(1);
	});

	it("shows a model by its display name with the id beside it", async () => {
		await mountMatrix();
		const row = rowFor("named-model");
		if (!row) throw new Error("no row for named-model");
		expect(row.textContent).toContain("Named Model");
	});
});
