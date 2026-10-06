/**
 * Default-model choice. omp's RPC `set_model` is session-only, and with no
 * `modelRoles.default` every new session falls back to omp's catalog pick,
 * which prefers a known provider's catalog default — Apple's keyless
 * on-device model (8k context) beats a configured models.yml endpoint as soon
 * as Apple discovery is cached (launch 2+). The GUI therefore persists the
 * default the way omp's own setup wizard and `/model` picker do.
 */

import type { CustomProviderView } from "../../../shared/ipc-types";
import type { ModelInfo, ProviderInfo } from "../../../shared/rpc-types";
import { applyModelInfo } from "../../hooks/session-hydration";
import type { TabRpc } from "../../lib/tab-rpc";
import { canServe, modelSelector, pickDefaultModel, servingProviderIds } from "../settings/providers/provider-catalog";

/** The saved `modelRoles.default` selector, `null` when unset, `undefined` when it cannot be read. */
export async function readDefaultModelRole(tabRpc: TabRpc): Promise<string | null | undefined> {
	try {
		const response = await tabRpc.getModelRoles();
		if (!response.success) return undefined;
		const data: unknown = response.data;
		if (!data || typeof data !== "object" || !("roles" in data) || !Array.isArray(data.roles)) return undefined;
		for (const role of data.roles as unknown[]) {
			if (!role || typeof role !== "object" || !("id" in role) || role.id !== "default") continue;
			return "model" in role && typeof role.model === "string" && role.model ? role.model : null;
		}
		return null;
	} catch {
		return undefined;
	}
}

/** Switch the tab to `model` and save it as the default for new sessions. */
export async function applyDefaultModel(tabRpc: TabRpc, tabId: string | null, model: ModelInfo): Promise<void> {
	const switched = await tabRpc.setModel(model.provider, model.id);
	if (!switched.success) throw new Error(switched.error ?? "set_model failed");
	applyModelInfo(switched.data, tabId);
	await persistDefaultModel(tabRpc, model);
}

/** Save `model` as `modelRoles.default` (global config.yml), like omp's `/model`. */
export async function persistDefaultModel(tabRpc: TabRpc, model: Pick<ModelInfo, "provider" | "id">): Promise<void> {
	const saved = await tabRpc.setModelRole("default", modelSelector(model));
	if (!saved.success) throw new Error(saved.error ?? "set_model_role failed");
}

export interface ServingDefaultInput {
	providers: readonly ProviderInfo[];
	configs: readonly CustomProviderView[];
	models: readonly ModelInfo[];
	/** The tab's live model. */
	current: ModelInfo | null;
}

export type ServingDefaultOutcome =
	/** A saved default exists (the user's choice), or nothing can serve: nothing changed. */
	| { kind: "unchanged" }
	/** The live model can serve and is now the saved default. */
	| { kind: "kept"; model: ModelInfo }
	/** The live model could not serve; switched to `model` and saved it. */
	| { kind: "switched"; model: ModelInfo; from: ModelInfo | null };

/**
 * With no saved default, make the session start on a model that can serve:
 * keep the live one when it can (and pin it, so the next launch cannot flip),
 * otherwise switch to the best connected model. Never touches a default the
 * user saved.
 */
export async function ensureServingDefault(
	tabRpc: TabRpc,
	tabId: string | null,
	input: ServingDefaultInput,
): Promise<ServingDefaultOutcome> {
	const saved = await readDefaultModelRole(tabRpc);
	if (saved !== null) return { kind: "unchanged" };
	const serving = servingProviderIds(input.providers, input.configs);
	if (serving.size === 0) return { kind: "unchanged" };
	if (input.current && canServe(input.current, serving)) {
		await persistDefaultModel(tabRpc, input.current);
		return { kind: "kept", model: input.current };
	}
	const pick = pickDefaultModel(input.models, serving);
	if (!pick) return { kind: "unchanged" };
	await applyDefaultModel(tabRpc, tabId, pick);
	return { kind: "switched", model: pick, from: input.current };
}
