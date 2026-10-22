/**
 * Per-model compaction points (`compaction.modelThresholds`, omp 18.8.5+):
 * where auto-compaction triggers for each catalog model and for the model each
 * role resolves to, computed by stock's own `/models` hub code
 * (`describeModelCompactionPoint`, `resolveRoleAssignments` over
 * `createModelBrowserSource`). Writes go through the generic `settings_set`.
 *
 * Stock internals load only after `guard` checks the compactionLimits feature.
 * Deferral keeps incompatible modules from failing the entire area at startup.
 * Literal specifiers resolve onto omp's loaded singletons (see health.ts).
 */
import type { Model } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { guard } from "./health";
import type { BridgeMethods } from "./types";

/**
 * `selector` (`provider/id`) answers that one model and no roles: the context ring and the compaction-point row
 * show the session model's point alone, and the whole table (every available model, every role's resolved model)
 * was 62 KB a read, sent to a paired device on each tab hydration.
 */
async function compactionPoints(session: AgentSession, selector?: string) {
	const { describeModelCompactionPoint } = await import(
		"@oh-my-pi/pi-coding-agent/session/model-compaction-threshold"
	);

	/** Wire shape: `src/shared/rpc-types.ts` CompactionPoint. */
	const point = (model: Model) => {
		const { tokens, percent, source, draft } = describeModelCompactionPoint(session.settings, model);
		return {
			...(tokens !== undefined ? { tokens } : {}),
			...(percent !== undefined ? { percent } : {}),
			source,
			...(draft !== undefined ? { draft } : {}),
		};
	};

	if (selector !== undefined) {
		return {
			models: session
				.getAvailableModels()
				.filter(model => `${model.provider}/${model.id}` === selector)
				.map(model => ({ selector, point: point(model) })),
			roles: [],
		};
	}

	const [{ createModelBrowserSource }, { resolveRoleAssignments }] = await Promise.all([
		import("@oh-my-pi/pi-coding-agent/modes/model-browser-source"),
		import("@oh-my-pi/pi-tui/overlays/model-browser"),
	]);
	// The models the hub's Roles view shows: configured values over the whole
	// catalog, auto picks over the usable models.
	const registry = session.modelRegistry;
	let available: Model[];
	try {
		available = registry.getAvailable("all");
	} catch {
		// Stock's hub treats a failing auth read the same way: no auto-selected roles.
		available = [];
	}
	const assignments = resolveRoleAssignments(
		createModelBrowserSource(session.settings),
		registry.getAll("all"),
		available,
	);

	return {
		models: session.getAvailableModels().map(model => ({
			selector: `${model.provider}/${model.id}`,
			point: point(model),
		})),
		roles: Object.entries(assignments).flatMap(([role, assignment]) =>
			assignment
				? [
						{
							role,
							selector: `${assignment.model.provider}/${assignment.model.id}`,
							autoSelected: assignment.autoSelected,
							point: point(assignment.model),
						},
					]
				: [],
		),
	};
}

export const methods: BridgeMethods = {
	...guard("compactionLimits", {
		compaction_points: async (params, env) =>
			compactionPoints(
				env.session(),
				typeof (params as { selector?: unknown } | undefined)?.selector === "string"
					? (params as { selector: string }).selector
					: undefined,
			),
		compaction_limits: async params => {
			// Defer internals until guard succeeds so missing modules cannot break bridge startup.
			const { parseCompactionPointInput, validateModelCompactionThresholds, formatCompactionPointInput } =
				await import("@oh-my-pi/pi-coding-agent/config/compaction-threshold");
			const input = params as { values?: unknown; key?: string; input?: string };
			if (input.input !== undefined) {
				let value: number | string | null;
				try {
					value = parseCompactionPointInput(input.input);
				} catch (error) {
					return { ok: false, limitError: String(error).includes("percentage must") ? "percent" : "invalid" };
				}
				if (value === null) return { ok: false, limitError: "invalid" };
				if (!input.key) return { ok: false, modelError: "empty" };
				try {
					validateModelCompactionThresholds({ [input.key]: value });
				} catch (error) {
					return { ok: false, modelError: String(error).includes("last character") ? "star" : "shape" };
				}
				return { ok: true, value };
			}
			const thresholds = validateModelCompactionThresholds(input.values);
			const values = input.values as Record<string, number | string>;
			return {
				rows: Object.entries(thresholds)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([key, threshold]) => ({ key, value: values[key], text: formatCompactionPointInput(threshold) })),
			};
		},
	}),
};
