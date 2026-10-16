/**
 * Dependency-free delegation contracts shared by main, the renderer and the
 * packaged bridge. The composer's delegation chip names how readily the agent
 * hands work to subagents; each named strength is a set of stock `task.*`
 * settings (task/settings.ts) that modes/delegation.ts holds as runtime
 * overrides on the tab's omp, so nothing is written to config.yml. Stock's own
 * live listeners apply them: `task.eager` rebuilds the system prompt
 * (`cfgSystemPromptInputs`), `task.maxRecursionDepth` adds or removes the task
 * tool (`cfgSessionToolGates`), `task.maxConcurrency` is read per spawn.
 */

/** prefs key: the strength new and restarted tabs start with. */
export const DELEGATION_PREF = "delegationMode";

/** `default` holds nothing: the user's own omp settings apply. The rest go from none to the most. */
export const DELEGATION_MODES = ["default", "solo", "assisted", "collaborative", "swarm"] as const;
export type DelegationMode = (typeof DELEGATION_MODES)[number];

/** The stock settings a strength sets. */
export const DELEGATION_SETTING_IDS = ["task.eager", "task.maxConcurrency", "task.maxRecursionDepth"] as const;
export type DelegationSettingId = (typeof DELEGATION_SETTING_IDS)[number];

export type DelegationPreset = Readonly<Partial<Record<DelegationSettingId, string | number>>>;

export const DELEGATION_PRESETS: Readonly<Record<Exclude<DelegationMode, "default">, DelegationPreset>> = {
	/** No task tool at all (stock removes it at recursion depth 0). */
	solo: { "task.eager": "default", "task.maxRecursionDepth": 0 },
	/** The model's own delegation policy, two subagents at a time. */
	assisted: { "task.eager": "default", "task.maxConcurrency": 2 },
	/** Delegation guidance in the system prompt, eight at a time. */
	collaborative: { "task.eager": "preferred", "task.maxConcurrency": 8 },
	/** Guidance plus a first-turn delegation reminder, stock's ceiling of 32 at a time. */
	swarm: { "task.eager": "always", "task.maxConcurrency": 32 },
};

export function isDelegationMode(value: unknown): value is DelegationMode {
	return (DELEGATION_MODES as readonly unknown[]).includes(value);
}
