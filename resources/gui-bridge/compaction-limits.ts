/**
 * Per-model compaction points (`compaction.modelThresholds`, omp 18.8.5+):
 * where auto-compaction triggers for each catalog model and for the model each
 * role resolves to, computed by stock's own `/models` hub code
 * (`describeModelCompactionPoint`, `resolveRoleAssignments` over
 * `createModelBrowserSource`). Writes go through the generic `settings_set`.
 *
 * The omp modules are imported only once `guard` has seen them (feature
 * `compactionLimits`, optional in capabilities.ts): an older omp lacks them, and
 * a static import would fail this area at load on every start. Literal
 * specifiers, so omp maps them onto its loaded singletons (see health.ts).
 */
import type { Model } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { guard } from "./health";
import type { BridgeMethods } from "./types";

async function compactionPoints(session: AgentSession) {
	const [{ describeModelCompactionPoint }, { createModelBrowserSource }, { resolveRoleAssignments }] =
		await Promise.all([
			import("@oh-my-pi/pi-coding-agent/session/model-compaction-threshold"),
			import("@oh-my-pi/pi-coding-agent/modes/model-browser-source"),
			import("@oh-my-pi/pi-tui/overlays/model-browser"),
		]);

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
		compaction_points: async (_params, env) => compactionPoints(env.session()),
	}),
};
