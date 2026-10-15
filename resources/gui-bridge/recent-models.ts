/**
 * Recently used models for the model picker's Recent group: stock's own
 * most-recently-used order (`AgentStorage` `model_usage`, recorded on every
 * model switch and cycle), read through the model hub's source exactly as
 * stock's `/models` hub reads it. Selectors are `provider/id`, newest first.
 *
 * Stock internals load only after `guard` checks the recentModels feature.
 */
import { guard } from "./health";
import type { BridgeMethods } from "./types";

export const methods: BridgeMethods = {
	...guard("recentModels", {
		recent_models: async (_params, env) => {
			const { createModelBrowserSource } = await import("@oh-my-pi/pi-coding-agent/modes/model-browser-source");
			return { selectors: [...createModelBrowserSource(env.session().settings).mruOrder] };
		},
	}),
};
