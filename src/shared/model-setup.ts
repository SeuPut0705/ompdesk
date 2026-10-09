/**
 * Model setup assistant: one research run on the focused tab's machine reads
 * public benchmarks for the models the user picked and proposes a model per
 * role plus whether to turn the advisor on. This module is the contract both
 * sides share — the request (validated on the machine that runs it), the
 * research prompt, and the parser that turns the model's reply into a plan
 * limited to the picked models and the known roles.
 */
import { z } from "zod";
import { codedError } from "./ipc-error-codes";

/** The research run's whole budget, cancel and timeout included. */
export const MODEL_SETUP_TIMEOUT_MS = 10 * 60_000;

export const ADVISOR_ROLE = "advisor";
/** At most this many models are researched at once (prompt size and research effort). */
export const MODEL_SETUP_MAX_MODELS = 12;

export interface ModelSetupModel {
	/** `provider/id`, the value a role is set to. */
	selector: string;
	provider: string;
	name?: string;
	contextWindow?: number;
	/** $ per 1M tokens. */
	cost?: { input?: number; output?: number };
	/** The catalog's intelligence score, when it has one. */
	intelligence?: number;
}

export interface ModelSetupRole {
	id: string;
	name: string;
}

export interface ModelSetupRequest {
	/** The model that does the research (`provider/id`). */
	researchModel: string;
	/** The current default model, so the advisor can come from another vendor. */
	defaultModel?: string;
	models: ModelSetupModel[];
	roles: ModelSetupRole[];
	/** English name of the language reasons and notes are written in. */
	language?: string;
}

export interface ModelSetupAssignment {
	role: string;
	model: string;
	reason: string;
}

export interface ModelSetupPlan {
	assignments: ModelSetupAssignment[];
	advisor: { enable: boolean; reason: string };
	sources: Array<{ title: string; url: string }>;
	notes?: string;
}

/** The tool call the research run is on, for the progress line. */
export interface ModelSetupActivity {
	tool: string;
	detail?: string;
}

export interface ModelSetupStatus {
	running: boolean;
	startedAt?: number;
	activity?: ModelSetupActivity;
}

const SELECTOR = /^[^\s/-][^\s/]*\/\S+$/;
const Selector = z.string().max(200).regex(SELECTOR, "Invalid model selector");
const RoleId = z
	.string()
	.max(64)
	.regex(/^[A-Za-z0-9_.-]+$/, "Invalid role id");
const OptionalNumber = z.number().finite().nonnegative().optional();

export const ModelSetupRequestSchema: z.ZodType<ModelSetupRequest> = z.object({
	researchModel: Selector,
	defaultModel: Selector.optional(),
	models: z
		.array(
			z.object({
				selector: Selector,
				provider: z.string().min(1).max(100),
				name: z.string().max(200).optional(),
				contextWindow: OptionalNumber,
				cost: z.object({ input: OptionalNumber, output: OptionalNumber }).optional(),
				intelligence: z.number().finite().optional(),
			}),
		)
		.min(1)
		.max(MODEL_SETUP_MAX_MODELS),
	roles: z
		.array(z.object({ id: RoleId, name: z.string().max(100) }))
		.min(1)
		.max(40),
	language: z
		.string()
		.max(40)
		.regex(/^[\p{L} ()-]+$/u)
		.optional(),
});

const Source = z.object({ title: z.string(), url: z.string().url() });

/** A stored plan (prefs) or a repaired research reply. */
export const ModelSetupPlanSchema: z.ZodType<ModelSetupPlan> = z.object({
	assignments: z.array(z.object({ role: z.string(), model: z.string(), reason: z.string() })),
	advisor: z.object({ enable: z.boolean(), reason: z.string() }),
	sources: z.array(Source),
	notes: z.string().optional(),
});

/**
 * What each built-in role does in stock omp. The assistant assigns only these:
 * a custom role (`modelRoles.<name>` the user added, e.g. for their own
 * agents) has a purpose OMPdesk cannot know, so its model stays the user's.
 */
const ROLE_PURPOSES: Record<string, string> = {
	default:
		"The main model: it answers every conversation turn and does the coding work unless another role takes over.",
	smol: "Fast, cheap model for lightweight work (quick lookups, small edits, the model `prewalk` hands implementation to). Speed and price matter more than depth.",
	slow: "Thinking model for hard reasoning and thorough analysis when the user switches to it. When no advisor model is set, the advisor uses this role's model.",
	vision: "Reads images when the active model cannot; needs image input.",
	plan: "Architect model for plan mode: explores and writes the implementation plan before any edit.",
	commit: "Writes commit messages and changelog entries (`omp commit`). Short, cheap output is enough.",
	tiny: "Smallest, cheapest model for trivial background tasks such as session titles. Falls back to the Fast role.",
	memory: "Summarizes and consolidates memories between sessions. Falls back to the Tiny role.",
	task: "Runs subagents spawned by the task tool; they do delegated coding work in parallel.",
	[ADVISOR_ROLE]:
		"Second-opinion reviewer: passively reviews every turn of the main agent and injects notes (concerns, blockers). Ideally a strong model from a different vendor than the default model, so it catches different mistakes. It only runs while the advisor is enabled.",
};

/** Whether the model setup assistant proposes a model for `role`. */
export function isSetupRole(role: string): boolean {
	return Object.hasOwn(ROLE_PURPOSES, role);
}

function formatTokens(value: number): string {
	return value >= 1_000_000
		? `${Number((value / 1_000_000).toFixed(2))}M`
		: value >= 1_000
			? `${Math.round(value / 1_000)}K`
			: String(value);
}

function describeModel(model: ModelSetupModel): string {
	const facts = [`provider ${model.provider}`];
	if (model.name && model.name !== model.selector.slice(model.selector.indexOf("/") + 1))
		facts.push(`name "${model.name}"`);
	if (model.contextWindow) facts.push(`context window ${formatTokens(model.contextWindow)} tokens`);
	if (model.cost?.input !== undefined && model.cost.output !== undefined)
		facts.push(`$${model.cost.input} input / $${model.cost.output} output per 1M tokens`);
	if (model.intelligence !== undefined) facts.push(`catalog intelligence score ${Math.round(model.intelligence)}`);
	return `- ${model.selector} (${facts.join("; ")})`;
}

function describeRole(role: ModelSetupRole): string {
	return `- ${role.id} (${role.name}): ${ROLE_PURPOSES[role.id] ?? role.name}`;
}

/** The research prompt: exactly the picked models and the known roles, and the reply contract. */
export function buildModelSetupPrompt(request: ModelSetupRequest): string {
	const language = request.language ?? "English";
	return [
		"You are choosing which model omp (a coding agent) uses for each of its model roles, for the user of OMPdesk.",
		"",
		"## Candidate models",
		"Use only these models, written exactly as listed (`provider/id`):",
		...request.models.map(describeModel),
		"",
		request.defaultModel
			? `The user's current default model is ${request.defaultModel}.`
			: "The user has no default model set.",
		"",
		"## Roles",
		...request.roles.map(describeRole),
		"",
		"## Task",
		"1. Research current public benchmarks and comparisons for exactly these models: use web_search, then read the most relevant pages. Prefer recent, reputable sources (vendor model cards, independent leaderboards such as coding and agentic benchmarks, price and speed comparisons). Do not research other models.",
		"2. For each role, pick the candidate that best fits its purpose, weighing capability, speed and price. Leave a role out when no candidate fits it; an omitted role keeps its current model.",
		"3. Decide whether the advisor should be enabled: it is worth it when a strong candidate from a different vendor than the default model is available.",
		"",
		"## Reply",
		"Reply with ONLY one JSON object: no prose before or after it, no code fence. Shape:",
		'{"assignments":[{"role":"<role id>","model":"<provider/id>","reason":"<one sentence>"}],"advisor":{"enable":<true or false>,"reason":"<one sentence>"},"sources":[{"title":"<page title>","url":"<https URL>"}],"notes":"<optional, one or two sentences>"}',
		`- "role" is one of: ${request.roles.map(role => role.id).join(", ")}.`,
		`- "model" is one of: ${request.models.map(model => model.selector).join(", ")}.`,
		'- "sources" lists the pages you actually used.',
		`- Write every "reason" and "notes" in ${language}.`,
	].join("\n");
}

const RawPlan = z.object({
	assignments: z.array(z.unknown()),
	advisor: z.unknown().optional(),
	sources: z.unknown().optional(),
	notes: z.unknown().optional(),
});
const RawAssignment = z.object({
	role: z.string(),
	model: z.string(),
	reason: z.string().optional(),
});
const RawAdvisor = z.object({ enable: z.boolean(), reason: z.string().optional() });

/** End index (exclusive) of the balanced JSON object starting at `start`, or -1. */
function objectEnd(text: string, start: number): number {
	let depth = 0;
	let inString = false;
	for (let index = start; index < text.length; index++) {
		const char = text[index];
		if (inString) {
			if (char === "\\") index++;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === "{") depth++;
		else if (char === "}") {
			depth--;
			if (depth === 0) return index + 1;
		}
	}
	return -1;
}

/** Every top-level JSON object in `text` that looks like a plan, in order. */
function planCandidates(text: string): Array<z.infer<typeof RawPlan>> {
	const found: Array<z.infer<typeof RawPlan>> = [];
	let index = text.indexOf("{");
	while (index !== -1) {
		const end = objectEnd(text, index);
		if (end === -1) break;
		let next = text.indexOf("{", index + 1);
		try {
			const parsed = RawPlan.safeParse(JSON.parse(text.slice(index, end)));
			if (parsed.success) {
				found.push(parsed.data);
				next = text.indexOf("{", end);
			}
		} catch {
			// Not JSON here; try the next brace.
		}
		index = next;
	}
	return found;
}

/** The picked model a reply's `model` names: exact, case-folded, without a `:thinking` suffix, or by unique id. */
function repairModel(value: string, selectors: readonly string[]): string | undefined {
	const wanted = value.trim();
	if (selectors.includes(wanted)) return wanted;
	const folded = wanted.toLowerCase();
	const base = folded.replace(/:[a-z]+$/, "");
	const exact = selectors.find(selector => {
		const candidate = selector.toLowerCase();
		return candidate === folded || candidate === base;
	});
	if (exact) return exact;
	const id = base.slice(base.indexOf("/") + 1);
	const byId = selectors.filter(selector => selector.toLowerCase().slice(selector.indexOf("/") + 1) === id);
	return byId.length === 1 ? byId[0] : undefined;
}

function evaluate(
	raw: z.infer<typeof RawPlan>,
	request: ModelSetupRequest,
): { plan: ModelSetupPlan; dropped: string[] } {
	const selectors = request.models.map(model => model.selector);
	const roleIds = new Map(request.roles.map(role => [role.id.toLowerCase(), role.id]));
	const dropped: string[] = [];
	const assignments: ModelSetupAssignment[] = [];
	for (const entry of raw.assignments) {
		const parsed = RawAssignment.safeParse(entry);
		if (!parsed.success) {
			dropped.push(`malformed assignment ${JSON.stringify(entry)}`);
			continue;
		}
		const role = roleIds.get(parsed.data.role.trim().toLowerCase());
		if (!role) {
			dropped.push(`unknown role "${parsed.data.role}"`);
			continue;
		}
		const model = repairModel(parsed.data.model, selectors);
		if (!model) {
			dropped.push(`${role}: "${parsed.data.model}" is not one of the selected models`);
			continue;
		}
		if (assignments.some(existing => existing.role === role)) {
			dropped.push(`${role}: duplicate assignment`);
			continue;
		}
		assignments.push({ role, model, reason: parsed.data.reason?.trim() ?? "" });
	}
	const advisorParsed = RawAdvisor.safeParse(raw.advisor);
	const advisor = advisorParsed.success
		? { enable: advisorParsed.data.enable, reason: advisorParsed.data.reason?.trim() ?? "" }
		: { enable: assignments.some(entry => entry.role === ADVISOR_ROLE), reason: "" };
	if (!advisorParsed.success) dropped.push("advisor decision missing or malformed");
	const sources = (Array.isArray(raw.sources) ? raw.sources : []).flatMap(entry => {
		const parsed = Source.safeParse(entry);
		if (!parsed.success || !/^https?:\/\//i.test(parsed.data.url)) return [];
		return [{ title: parsed.data.title.trim() || parsed.data.url, url: parsed.data.url }];
	});
	const notes = typeof raw.notes === "string" && raw.notes.trim() ? raw.notes.trim() : undefined;
	return { plan: { assignments, advisor, sources, ...(notes ? { notes } : {}) }, dropped };
}

/**
 * The plan in a research reply. The reply may wrap the JSON in prose or a
 * code fence; the last object that yields a valid assignment wins (an echo of
 * the requested shape earlier in the text yields none). Assignments naming an
 * unknown role or a model outside the picked ones are repaired or dropped
 * (`dropped` says which). Throws `model_setup_no_plan` when nothing is valid.
 */
export function parseModelSetupPlan(
	text: string,
	request: ModelSetupRequest,
): { plan: ModelSetupPlan; dropped: string[] } {
	const candidates = planCandidates(text);
	for (let index = candidates.length - 1; index >= 0; index--) {
		const result = evaluate(candidates[index], request);
		if (result.plan.assignments.length > 0) return result;
	}
	if (candidates.length === 0)
		throw codedError("model_setup_no_plan", "The research reply contained no plan JSON object");
	const reasons = evaluate(candidates[candidates.length - 1], request).dropped;
	throw codedError(
		"model_setup_no_plan",
		`The research reply proposed no valid assignment${reasons.length ? `: ${reasons.join("; ")}` : ""}`,
	);
}
