/**
 * The model setup assistant's pure parts: which models it offers (the chat
 * candidates the roles RPC returns, i.e. what the connected accounts serve,
 * enriched from the catalog), what it preselects, which roles it researches,
 * which proposed assignments actually change a role, and the last proposal
 * kept in prefs per device.
 */
import { z } from "zod";
import {
	ADVISOR_ROLE,
	MODEL_SETUP_MAX_MODELS,
	type ModelSetupModel,
	type ModelSetupPlan,
	ModelSetupPlanSchema,
	type ModelSetupRole,
} from "../../../../shared/model-setup";
import type { ModelInfo, ModelRoleEntry } from "../../../../shared/rpc-types";

export interface SetupModelOption extends ModelSetupModel {
	/** Display name; the selector when the catalog has none. */
	label: string;
}

export interface SetupProviderGroup {
	provider: string;
	models: SetupModelOption[];
}

const THINKING_SUFFIX = /:(?:off|minimal|low|medium|high|xhigh|max|auto)$/;

/** A role value without its `:thinking` suffix, so `p/m:high` and the proposal `p/m` compare equal. */
export function baseSelector(value: string | undefined): string | undefined {
	return value?.trim().replace(THINKING_SUFFIX, "") || undefined;
}

/**
 * Every chat model the connected accounts serve: the `default` role's
 * candidate pool (backend-filtered to available chat models), with context
 * window, price and intelligence from the catalog when it has them.
 */
export function setupModelOptions(roles: readonly ModelRoleEntry[], catalog: readonly ModelInfo[]): SetupModelOption[] {
	const pool = roles.find(role => role.id === "default")?.candidates ?? roles.flatMap(role => role.candidates);
	const seen = new Set<string>();
	const options: SetupModelOption[] = [];
	for (const candidate of pool) {
		if (candidate.kind !== "chat") continue;
		const selector = `${candidate.provider}/${candidate.id}`;
		if (seen.has(selector)) continue;
		seen.add(selector);
		const info = catalog.find(model => model.provider === candidate.provider && model.id === candidate.id);
		const cost = info?.cost;
		options.push({
			selector,
			provider: candidate.provider,
			label: candidate.name || candidate.id,
			...(candidate.name && candidate.name !== candidate.id ? { name: candidate.name } : {}),
			...(typeof info?.contextWindow === "number" ? { contextWindow: info.contextWindow } : {}),
			...(typeof cost?.input === "number" && typeof cost.output === "number"
				? { cost: { input: cost.input, output: cost.output } }
				: {}),
			...(typeof info?.int === "number" && Number.isFinite(info.int) ? { intelligence: info.int } : {}),
		});
	}
	return options;
}

export function groupByProvider(options: readonly SetupModelOption[]): SetupProviderGroup[] {
	const groups = new Map<string, SetupModelOption[]>();
	for (const option of options) groups.set(option.provider, [...(groups.get(option.provider) ?? []), option]);
	return [...groups].map(([provider, models]) => ({ provider, models }));
}

/** Higher first: the catalog's intelligence score, then output price, then context window. */
function strength(a: SetupModelOption, b: SetupModelOption): number {
	return (
		(b.intelligence ?? -1) - (a.intelligence ?? -1) ||
		(b.cost?.output ?? -1) - (a.cost?.output ?? -1) ||
		(b.contextWindow ?? -1) - (a.contextWindow ?? -1)
	);
}

/** The current default model among the options: the `default` role, else the session's model. */
export function currentDefaultModel(
	roles: readonly ModelRoleEntry[],
	options: readonly SetupModelOption[],
	activeModel: ModelInfo | null,
): string | undefined {
	const configured = baseSelector(roles.find(role => role.id === "default")?.model);
	const active = activeModel ? `${activeModel.provider}/${activeModel.id}` : undefined;
	return [configured, active].find(selector => options.some(option => option.selector === selector));
}

/** The current default model plus the strongest model of every other connected provider. */
export function defaultSelection(options: readonly SetupModelOption[], defaultModel: string | undefined): string[] {
	const defaultProvider = options.find(option => option.selector === defaultModel)?.provider;
	const picks = defaultModel && defaultProvider ? [defaultModel] : [];
	for (const group of groupByProvider(options)) {
		if (group.provider === defaultProvider) continue;
		const strongest = [...group.models].sort(strength)[0];
		if (strongest) picks.push(strongest.selector);
	}
	return picks.slice(0, MODEL_SETUP_MAX_MODELS);
}

/** The roles the research assigns: the visible chat roles (kind roles such as image or speech need other models). */
export function setupRoles(roles: readonly ModelRoleEntry[]): ModelSetupRole[] {
	return roles.filter(role => role.section === "chat" && !role.hidden).map(role => ({ id: role.id, name: role.name }));
}

/** The assignments that change a role; one already on that model (any thinking suffix) is not written. */
export function changedAssignments(
	drafts: Readonly<Record<string, string>>,
	roles: readonly ModelRoleEntry[],
): Array<{ role: string; model: string }> {
	return Object.entries(drafts).flatMap(([role, model]) =>
		baseSelector(roles.find(entry => entry.id === role)?.model) === model ? [] : [{ role, model }],
	);
}

/**
 * The model the advisor runs on: its own role, else — like stock's
 * `ROLE_CONFIGURED_FALLBACK` — the Thinking role when that one is set.
 */
export function effectiveAdvisorModel(
	roles: readonly ModelRoleEntry[],
): { model: string; via: typeof ADVISOR_ROLE | "slow" } | undefined {
	const own = roles.find(role => role.id === ADVISOR_ROLE)?.model?.trim();
	if (own) return { model: own, via: ADVISOR_ROLE };
	const slow = roles.find(role => role.id === "slow")?.model?.trim();
	return slow ? { model: slow, via: "slow" } : undefined;
}

export const MODEL_SETUP_PREFS_KEY = "modelSetup";
/** Prefs key of this computer's own machine; a paired host's proposal is kept under its device id. */
const LOCAL_DEVICE = "local";

const StoredProposal = z.object({
	savedAt: z.number(),
	researchModel: z.string(),
	models: z.array(z.string()),
	plan: ModelSetupPlanSchema,
	dropped: z.array(z.string()),
});
export type StoredProposal = z.infer<typeof StoredProposal>;
const StoredProposals = z.record(z.unknown());

async function readProposals(): Promise<Record<string, unknown>> {
	const parsed = StoredProposals.safeParse(await window.omp.prefs.get(MODEL_SETUP_PREFS_KEY));
	return parsed.success ? parsed.data : {};
}

/** The last proposal for the machine `device` names (absent = this computer), if one is stored and readable. */
export async function loadLastProposal(device: string | undefined): Promise<StoredProposal | undefined> {
	const parsed = StoredProposal.safeParse((await readProposals())[device ?? LOCAL_DEVICE]);
	return parsed.success ? parsed.data : undefined;
}

export async function saveLastProposal(device: string | undefined, proposal: StoredProposal): Promise<void> {
	await window.omp.prefs.set(MODEL_SETUP_PREFS_KEY, {
		...(await readProposals()),
		[device ?? LOCAL_DEVICE]: proposal,
	});
}

/** The editable table's starting point: one model per proposed role. */
export function draftsOf(plan: ModelSetupPlan): Record<string, string> {
	return Object.fromEntries(plan.assignments.map(entry => [entry.role, entry.model]));
}
