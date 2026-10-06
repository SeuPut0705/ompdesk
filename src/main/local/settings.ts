/**
 * Settings, model catalog, providers, usage and model roles. Stock omp has no
 * RPC for any of these (its `get_available_models` lacks discovery state), so
 * each one is answered by the gui-bridge's `settings` methods over the live
 * session, keeping the fork's wire shapes.
 */
import type { LocalHandler } from "./types";

export const handlers: Record<string, LocalHandler> = {
	get_settings_schema: (_command, ctx) => ctx.bridge.request("settings_schema"),
	get_settings: (command, ctx) => ctx.bridge.request("settings_get", { paths: command.paths }),
	set_setting: (command, ctx) => ctx.bridge.request("settings_set", { path: command.path, value: command.value }),
	get_available_models: (command, ctx) =>
		ctx.bridge.request("models_catalog", { forceRefresh: command.forceRefresh === true }),
	get_providers: (command, ctx) => ctx.bridge.request("providers", { forceRefresh: command.forceRefresh === true }),
	logout: (command, ctx) => ctx.bridge.request("provider_logout", { providerId: command.providerId }),
	get_usage: (_command, ctx) => ctx.bridge.request("usage"),
	get_model_roles: (_command, ctx) => ctx.bridge.request("model_roles"),
	set_model_role: (command, ctx) =>
		ctx.bridge.request("model_role_set", { role: command.role, modelId: command.modelId ?? null }),
	get_model_role_metadata: (_command, ctx) => ctx.bridge.request("model_role_metadata"),
};
