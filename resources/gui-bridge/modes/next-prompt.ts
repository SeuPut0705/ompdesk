/**
 * Built-in prompt suggestions: the guarded bridge methods and the extension hooks. The engine
 * (../next-prompt-engine.ts) holds the behaviour; this file puts it behind the compatibility guard, so a
 * missing stock internal refuses the methods with `unsupported_omp` (capabilities.ts `nextPrompt`), and
 * names the stock modules the engine calls.
 */
import { guard } from "../health";
import { handlers, install, type NextPromptStock, setNextPromptStockLoader } from "../next-prompt-engine";
import type { BridgeMethods } from "../types";

export { install };

setNextPromptStockLoader(async () => {
	const [ai, roles, resolver, input] = await Promise.all([
		import("@oh-my-pi/pi-ai"),
		import("@oh-my-pi/pi-coding-agent/config/model-roles"),
		import("@oh-my-pi/pi-coding-agent/config/model-resolver"),
		import("@oh-my-pi/pi-coding-agent/modes/controllers/input-controller"),
	]);
	return {
		completeSimple: ai.completeSimple as unknown as NextPromptStock["completeSimple"],
		roleCandidatePool: roles.roleCandidatePool as unknown as NextPromptStock["roleCandidatePool"],
		resolveRoleChain: resolver.resolveRoleChain as unknown as NextPromptStock["resolveRoleChain"],
		shouldSkipHistory: input.shouldSkipHistory,
	};
});

export const methods: BridgeMethods = guard("nextPrompt", handlers);
