import type { CustomProviderOptions } from "../shared/ipc-types";
import { stockHelperRequest } from "./stock-helper";

export interface ModelsConfigMetadata extends CustomProviderOptions {
	builtinProviders: string[];
}

/** Main/renderer options are derived from the installed omp, never a checked-in roster. */
export async function modelsConfigMetadata(): Promise<ModelsConfigMetadata> {
	const value = await stockHelperRequest<ModelsConfigMetadata>("catalog.roster");
	for (const key of ["builtinProviders", "apis", "auth", "discovery", "thinkingModes", "efforts"] as const) {
		const options = value[key];
		if (!Array.isArray(options) || options.length === 0 || options.some(option => typeof option !== "string")) {
			throw new Error("Installed omp cannot determine models.yml provider roster or option vocabularies");
		}
	}
	return value;
}

export async function normalizeModelsConfig(
	config: unknown,
): Promise<{ config?: Record<string, unknown>; error?: string }> {
	return stockHelperRequest("models.validate", { config });
}
