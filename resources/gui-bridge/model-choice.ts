/**
 * The model the person chose for this session while a temporary switch of stock's runs it. A retry fallback (and
 * stock's other stand-ins: Fireworks Fast's degrade, a context promotion) changes the live model and journals an
 * ephemeral model change; stock starts the session on its own model again (`getRestorableSessionModels`, what every
 * restart, relaunch, resume and fork opens on) and, under `retry.fallbackRevertPolicy: cooldown-expiry`, goes back to
 * it at the first prompt after the primary's wait. That model, not the live one, is the person's choice: main's
 * `get_state` (src/main/local/composer.ts) carries it as `chosenModel` for the composer's model chip.
 *
 * Stock internals load only after `guard` checks the modelChoice feature.
 */
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { guard } from "./health";
import type { BridgeMethods } from "./types";

/** `chosen` is null while the live model is the session's own. */
export interface ModelChoice {
	chosen: { provider: string; id: string; name?: string } | null;
}

/** The selector a restart would open on, per journal and leaf: `get_state` asks on every hydrate and liveness probe. */
const restorable = new WeakMap<object, { leaf: string | null; selector: string | undefined }>();

export const methods: BridgeMethods = {
	...guard("modelChoice", {
		model_choice: async (_params, env): Promise<ModelChoice> => {
			const session = env.session() as AgentSession;
			const journal = session.sessionManager;
			const role = journal.getLastModelChangeRole();
			// The newest model change is the session's own (a pick, its start): nothing stands in for it.
			if (role === journal.getLastModelChangeRole({ skipEphemeral: true })) return { chosen: null };
			const leaf = journal.getLeafId();
			let known = restorable.get(journal);
			if (known?.leaf !== leaf) {
				const { getRestorableSessionModels } = await import("@oh-my-pi/pi-coding-agent/session/session-context");
				known = { leaf, selector: getRestorableSessionModels(journal.buildSessionContext().models, role)[0] };
				restorable.set(journal, known);
			}
			if (!known.selector) return { chosen: null };
			const { resolveSessionModelSelector } = await import("@oh-my-pi/pi-coding-agent/config/model-resolver");
			const own = resolveSessionModelSelector(session.modelRegistry, known.selector)?.model;
			const live = session.model;
			if (!own || (live && own.provider === live.provider && own.id === live.id)) return { chosen: null };
			return { chosen: { provider: own.provider, id: own.id, name: own.name } };
		},
	}),
};
