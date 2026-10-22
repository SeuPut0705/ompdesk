/**
 * The model setup assistant's pure parts: which models the picker offers, what the planner is fed (roles, facts,
 * quota headroom), the reason sentences behind each row's ⓘ, the research request and its cost estimate, how a
 * research plan overlays the rules' rows, and the apply record kept in prefs per device (what was written, what
 * each role held before, and the signature "new models or accounts since" is judged against).
 */
import { z } from "zod";
import type { Billing, BillingBasis, ModelSetupFacts } from "../../../../../resources/gui-bridge/model-setup-contracts";
import {
	ADVISOR_ROLE,
	type ModelSetupModel,
	type ModelSetupPlan,
	type ModelSetupRequest,
	type ModelSetupRole,
} from "../../../../shared/model-setup";
import {
	baseSelector,
	billingOf,
	fullAutoAllows,
	type PlanMode,
	type PlanReason,
	type PlanRoleInput,
	type PlanRow,
} from "../../../../shared/role-plan";
import type { ModelInfo, ModelRoleEntry, UsageReport } from "../../../../shared/rpc-types";
import { formatPricePerMillion } from "../../../lib/format";

export interface SetupModelOption {
	/** `provider/id`, the value a role is set to. */
	selector: string;
	provider: string;
	/** Display name; the id when stock has none. */
	label: string;
	/** `chat`, or `judge` for a judge-kind model of the judge role's pool. */
	kind: string;
	billing: Billing;
	contextWindow?: number;
}

export interface SetupProviderGroup {
	provider: string;
	models: SetupModelOption[];
}

/** The chat models of the default role's pool plus the judge-kind models of the judge role's, each with its billing class. */
export function setupModelOptions(roles: readonly ModelRoleEntry[], facts: ModelSetupFacts): SetupModelOption[] {
	const chatPool = roles.find(role => role.id === "default")?.candidates ?? roles.flatMap(role => role.candidates);
	const judgePool = roles
		.find(role => role.id === "judge")
		?.candidates.filter(candidate => candidate.kind === "judge");
	const seen = new Set<string>();
	const options: SetupModelOption[] = [];
	for (const candidate of [...chatPool.filter(entry => entry.kind === "chat"), ...(judgePool ?? [])]) {
		const selector = `${candidate.provider}/${candidate.id}`;
		const model = facts.models[selector];
		// A model the facts do not describe cannot be planned.
		if (!model || seen.has(selector)) continue;
		seen.add(selector);
		options.push({
			selector,
			provider: candidate.provider,
			label: candidate.name || candidate.id,
			kind: candidate.kind,
			billing: billingOf(facts, selector),
			...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
		});
	}
	return options;
}

export function groupByProvider(options: readonly SetupModelOption[]): SetupProviderGroup[] {
	const groups = new Map<string, SetupModelOption[]>();
	for (const option of options) groups.set(option.provider, [...(groups.get(option.provider) ?? []), option]);
	return [...groups].map(([provider, models]) => ({ provider, models }));
}

/** The current default model among the options: the `default` role, else the session's model. */
export function currentDefaultModel(
	roles: readonly ModelRoleEntry[],
	options: readonly Pick<SetupModelOption, "selector">[],
	activeModel: ModelInfo | null,
): string | undefined {
	const configured = baseSelector(roles.find(role => role.id === "default")?.model);
	const active = activeModel ? `${activeModel.provider}/${activeModel.id}` : undefined;
	return [configured, active].find(selector => options.some(option => option.selector === selector));
}

/** `get_model_roles` as the planner reads it, whatever roles it lists (stock's or OMPdesk's). */
export function planRoleInputs(roles: readonly ModelRoleEntry[]): PlanRoleInput[] {
	return roles.map(role => ({
		id: role.id,
		section: role.section,
		...(role.hidden ? { hidden: true } : {}),
		candidates: role.candidates.map(candidate => `${candidate.provider}/${candidate.id}`),
		...(role.model ? { current: role.model } : {}),
		...(role.defaults ? { defaults: role.defaults } : {}),
		...(role.effective?.model ? { effective: role.effective.model } : {}),
	}));
}

/**
 * Provider → how much of its roomiest account's tightest window is left (0–1): per report the minimum over its
 * limits of the remaining fraction, then the maximum over the provider's reports. A limited report (its reset is
 * still ahead) and a limit with no fraction count for nothing; a provider none of whose reports say is absent.
 */
export function usageHeadroom(reports: readonly UsageReport[] | null, now: number): Record<string, number> {
	const headroom: Record<string, number> = {};
	for (const report of reports ?? []) {
		if (report.resetAt !== undefined && report.resetAt > now) continue;
		const fractions = report.limits.flatMap(limit => {
			const remaining =
				limit.remainingFraction ?? (limit.usedFraction !== undefined ? 1 - limit.usedFraction : undefined);
			return remaining === undefined ? [] : [Math.min(1, Math.max(0, remaining))];
		});
		if (fractions.length === 0) continue;
		headroom[report.provider] = Math.max(headroom[report.provider] ?? 0, Math.min(...fractions));
	}
	return headroom;
}

/** The distinct models a plan chose, in row order: the picker's prefill of the second mode. */
export function distinctModels(rows: readonly PlanRow[]): string[] {
	return [...new Set(rows.flatMap(row => (row.model ? [row.model] : [])))];
}

/** A row the apply can write: it names a model, the role is not on it already and its chain does not already give it. */
export function writable(row: PlanRow): boolean {
	return row.model !== null && !row.follows && baseSelector(row.current) !== row.model;
}

// ── Reason sentences (behind each row's ⓘ) ─────────────────────────────────────────────────────────────────────

type Translate = (key: string, params?: Record<string, string | number>) => string;

const KNOWN_BASES: readonly BillingBasis[] = [
	"oauth",
	"oauth-and-key",
	"api-key",
	"env",
	"config",
	"runtime",
	"custom-endpoint",
	"base-url-changed",
	"local-keyless",
	"unknown",
];

/** "int 70 of 85, $1.2/M output vs $5/M": the numbers of a rule's sentence that the facts have. */
function factsLine(t: Translate, reason: PlanReason): string {
	const parts: string[] = [];
	if (reason.int !== undefined) {
		parts.push(
			reason.topInt !== undefined
				? t("modelSetup.reason.facts.score", { int: Math.round(reason.int), top: Math.round(reason.topInt) })
				: t("modelSetup.reason.facts.scoreOnly", { int: Math.round(reason.int) }),
		);
	}
	if (reason.outputPrice !== undefined) {
		parts.push(
			reason.comparePrice !== undefined
				? t("modelSetup.reason.facts.priceVs", {
						out: formatPricePerMillion(reason.outputPrice),
						cmp: formatPricePerMillion(reason.comparePrice),
					})
				: t("modelSetup.reason.facts.price", { out: formatPricePerMillion(reason.outputPrice) }),
		);
	}
	return parts.join(", ");
}

/**
 * The sentence a row's ⓘ shows, from the planner's facts: the rule and its numbers, the provider's billing (and
 * in the picked mode why it has that class), the quota left when reported, and for the advisor whether its vendor
 * differs from the default's. `keepsDefault`: the default row's model is the one the role already runs on.
 */
export function reasonText(
	t: Translate,
	row: PlanRow,
	options: { mode: PlanMode; keepsDefault: boolean; research?: string },
): string {
	const follows = row.follows ? t("modelSetup.reason.follows") : "";
	if (options.research !== undefined) {
		return [
			options.research || t("modelSetup.reason.research"),
			billingSentence(t, row.reason, options.mode),
			follows,
		]
			.filter(Boolean)
			.join(" ");
	}
	const { reason } = row;
	const facts = factsLine(t, reason);
	const withFacts = (key: string) => (facts ? `${t(key)}: ${facts}.` : `${t(key)}.`);
	let main: string;
	switch (reason.rule) {
		case "default":
			main = options.keepsDefault
				? `${t("modelSetup.reason.default.keep")}.`
				: withFacts("modelSetup.reason.default.strongest");
			break;
		case "strong":
			main = withFacts("modelSetup.reason.strong");
			break;
		case "advisor":
			main = withFacts(reason.crossVendor ? "modelSetup.reason.advisor.cross" : "modelSetup.reason.advisor.same");
			break;
		case "cheap":
			main = withFacts("modelSetup.reason.cheap");
			break;
		case "task":
			main = withFacts("modelSetup.reason.task");
			break;
		case "vision":
			main = withFacts("modelSetup.reason.vision");
			break;
		case "chat":
			main = withFacts("modelSetup.reason.chat");
			break;
		case "stock":
			return t("modelSetup.reason.stock");
		case "no-candidate":
			return t(options.mode === "full" ? "modelSetup.reason.none.full" : "modelSetup.reason.none.picked");
	}
	const headroom =
		reason.headroom !== undefined
			? t("modelSetup.reason.headroom", { percent: Math.round(reason.headroom * 100) })
			: "";
	return [main, billingSentence(t, reason, options.mode), headroom, follows].filter(Boolean).join(" ");
}

/** "Subscription." / "Metered: billed through an API key." (the basis only in the picked mode, where metered is allowed). */
function billingSentence(t: Translate, reason: PlanReason, mode: PlanMode): string {
	if (!reason.billing) return "";
	const label = t(`modelSetup.reason.billing.${reason.billing}`);
	if (mode === "full") return `${label}.`;
	const basis = reason.basis && KNOWN_BASES.includes(reason.basis) ? reason.basis : "unknown";
	return `${label}: ${t(`modelSetup.reason.basis.${basis}`)}.`;
}

// ── Research ("Find more evidence") ────────────────────────────────────────────────────────────────────────────

/** What one research run reads and writes, for the cost shown before it starts. */
export const RESEARCH_INPUT_TOKENS = 100_000;
export const RESEARCH_OUTPUT_TOKENS = 5_000;
export const RESEARCH_MINUTES = 1;

/** The research's billing class and, when the model's list prices are known, its cost in USD. */
export function researchEstimate(facts: ModelSetupFacts, selector: string): { billing: Billing; usd?: number } {
	const model = facts.models[selector];
	const billing = billingOf(facts, selector);
	if (model?.inputPrice === undefined || model.outputPrice === undefined) return { billing };
	return {
		billing,
		usd: (RESEARCH_INPUT_TOKENS * model.inputPrice + RESEARCH_OUTPUT_TOKENS * model.outputPrice) / 1_000_000,
	};
}

/** The models the research may assign: full = non-metered chat models, picked = the picked ones. */
export function researchPool(
	options: readonly SetupModelOption[],
	facts: ModelSetupFacts,
	mode: PlanMode,
	picked: readonly string[],
): string[] {
	return options
		.filter(option => option.kind === "chat")
		.filter(option => (mode === "full" ? fullAutoAllows(facts, option.selector) : picked.includes(option.selector)))
		.map(option => option.selector);
}

/** The research run's request: the pool's models, the chat roles of `get_model_roles`, the model that researches. */
export function researchRequest(input: {
	researchModel: string;
	defaultModel?: string;
	pool: readonly string[];
	facts: ModelSetupFacts;
	roles: readonly ModelRoleEntry[];
	rows: readonly PlanRow[];
	language: string;
}): ModelSetupRequest {
	const models = input.pool.flatMap((selector): ModelSetupModel[] => {
		const model = input.facts.models[selector];
		if (!model) return [];
		const cost = {
			...(model.inputPrice !== undefined ? { input: model.inputPrice } : {}),
			...(model.outputPrice !== undefined ? { output: model.outputPrice } : {}),
		};
		return [
			{
				selector,
				provider: model.provider,
				...(model.name && model.name !== model.id ? { name: model.name } : {}),
				...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
				...(Object.keys(cost).length > 0 ? { cost } : {}),
				...(model.int !== undefined ? { intelligence: model.int } : {}),
			},
		];
	});
	const rows = new Set(input.rows.map(row => row.role));
	const roles: ModelSetupRole[] = input.roles
		.filter(role => role.section === "chat" && rows.has(role.id))
		.map(role => ({ id: role.id, name: role.name, section: role.section }));
	return {
		researchModel: input.researchModel,
		...(input.defaultModel ? { defaultModel: input.defaultModel } : {}),
		models,
		roles,
		language: input.language,
	};
}

/** A planned row, with the research's reason when its plan named the row's model. */
export interface ProposalRow extends PlanRow {
	research?: string;
}

/**
 * The rules' rows with the research plan laid over them: an assignment replaces its row's model only when the
 * model is in the research pool and a candidate of that role (a role takes no other), and carries the research's
 * reason. Manual and stock rows keep their state; ticking follows the usual default for the new model.
 */
export function withResearch(
	rows: readonly PlanRow[],
	plan: ModelSetupPlan | undefined,
	pool: ReadonlySet<string>,
	roles: readonly PlanRoleInput[],
): ProposalRow[] {
	return rows.map(row => {
		const assignment = plan?.assignments.find(entry => entry.role === row.role);
		const candidates = roles.find(role => role.id === row.role)?.candidates ?? [];
		if (
			!assignment ||
			row.reason.rule === "stock" ||
			!pool.has(assignment.model) ||
			!candidates.includes(assignment.model)
		) {
			return row;
		}
		const role = roles.find(entry => entry.id === row.role);
		const follows = role?.current === undefined && baseSelector(role?.effective) === assignment.model;
		return {
			...row,
			model: assignment.model,
			follows,
			checked: !row.manual && !follows && assignment.model !== baseSelector(row.current),
			research: assignment.reason,
		};
	});
}

// ── The model the advisor runs on (Settings › Agent behavior's advisor row) ────────────────────────────────────

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

// ── Facts and the apply record ─────────────────────────────────────────────────────────────────────────────────

const OptionalNumber = z.number().optional();
const FactsSchema = z.object({
	providers: z.record(
		z.object({
			billing: z.enum(["subscription", "free", "metered"]),
			// A basis a newer bridge adds still reads: the reason text falls back to "unknown".
			basis: z.string().transform(value => value as BillingBasis),
		}),
	),
	models: z.record(
		z.object({
			provider: z.string(),
			id: z.string(),
			name: z.string(),
			kind: z.string(),
			family: z.string().optional(),
			int: OptionalNumber,
			tps: OptionalNumber,
			contextWindow: OptionalNumber,
			inputPrice: OptionalNumber,
			outputPrice: OptionalNumber,
			image: z.boolean(),
		}),
	),
	roles: z.record(z.object({ persisted: z.string().optional() })),
	judgePins: z.array(z.string()),
});

/** `get_model_setup_facts`' data, or undefined when it is not the contract's shape. */
export function parseSetupFacts(data: unknown): ModelSetupFacts | undefined {
	const parsed = FactsSchema.safeParse(data);
	return parsed.success ? (parsed.data as ModelSetupFacts) : undefined;
}

export const MODEL_SETUP_PREFS_KEY = "modelSetup";
/** Prefs key of this computer's own machine; a paired host's record is kept under its device id. */
const LOCAL_DEVICE = "local";

const AppliedSchema = z.object({
	at: z.number(),
	/** Role → the model OMPdesk wrote. */
	values: z.record(z.string()),
	/** Role → what it held before (null: nothing set). */
	before: z.record(z.string().nullable()),
});
export type AppliedSetup = z.infer<typeof AppliedSchema>;

const SetupRecordSchema = z.object({
	applied: AppliedSchema.optional(),
	/** `setupSignature` at the last apply: what "new models or accounts" is judged against. */
	signature: z.string().optional(),
});
export type SetupRecord = z.infer<typeof SetupRecordSchema>;
const Records = z.record(z.unknown());

async function readRecords(): Promise<Record<string, unknown>> {
	const parsed = Records.safeParse(await window.omp.prefs.get(MODEL_SETUP_PREFS_KEY));
	return parsed.success ? parsed.data : {};
}

/** The apply record of the machine `device` names (absent = this computer). An old or unreadable one reads as nothing. */
export async function loadSetupRecord(device: string | undefined): Promise<SetupRecord | undefined> {
	const parsed = SetupRecordSchema.safeParse((await readRecords())[device ?? LOCAL_DEVICE]);
	if (!parsed.success || (parsed.data.applied === undefined && parsed.data.signature === undefined)) return undefined;
	return parsed.data;
}

/** Stores `record` for the machine; undefined removes it. Other machines' records stay. */
export async function saveSetupRecord(device: string | undefined, record: SetupRecord | undefined): Promise<void> {
	const { [device ?? LOCAL_DEVICE]: _replaced, ...others } = await readRecords();
	await window.omp.prefs.set(MODEL_SETUP_PREFS_KEY, record ? { ...others, [device ?? LOCAL_DEVICE]: record } : others);
}

/**
 * The record after writing `writes`. A role an earlier apply wrote and nobody changed since stays in it (its
 * original `before` too, so Undo returns it to where it was before any setup); a role changed by hand since drops
 * out; the written roles' `before` is what they hold now.
 */
export function mergeApplied(
	previous: AppliedSetup | undefined,
	roles: readonly Pick<ModelRoleEntry, "id" | "model">[],
	writes: readonly { role: string; model: string }[],
	at: number,
): AppliedSetup {
	const values: Record<string, string> = {};
	const before: Record<string, string | null> = {};
	const stillOurs = (role: string) => {
		const written = previous?.values[role];
		return (
			written !== undefined && baseSelector(roles.find(entry => entry.id === role)?.model) === baseSelector(written)
		);
	};
	for (const role of Object.keys(previous?.values ?? {})) {
		if (!stillOurs(role)) continue;
		values[role] = previous?.values[role] ?? "";
		before[role] = previous?.before[role] ?? null;
	}
	for (const write of writes) {
		values[write.role] = write.model;
		if (!stillOurs(write.role)) before[write.role] = roles.find(entry => entry.id === write.role)?.model ?? null;
	}
	return { at, values, before };
}

/**
 * What Undo does against the roles as they are now: each role OMPdesk wrote and that still holds that model
 * (thinking suffix aside) goes back to what it held; a role changed by hand since, or gone, is left and named.
 */
export function undoSteps(
	applied: AppliedSetup,
	roles: readonly Pick<ModelRoleEntry, "id" | "model">[],
): { restore: Array<{ role: string; model: string | null }>; skipped: string[] } {
	const restore: Array<{ role: string; model: string | null }> = [];
	const skipped: string[] = [];
	for (const [role, value] of Object.entries(applied.values)) {
		const current = roles.find(entry => entry.id === role);
		if (current && baseSelector(current.model) === baseSelector(value)) {
			restore.push({ role, model: applied.before[role] ?? null });
		} else {
			skipped.push(role);
		}
	}
	return { restore, skipped };
}

/** Whether the setup would see something new since the last apply: a record with a signature that differs from now. */
export function offersNewSetup(record: SetupRecord | undefined, signature: string): boolean {
	return record?.signature !== undefined && record.signature !== signature;
}
