/**
 * Dependency-free contracts of the automatic session titles, shared by main, the renderer and the
 * packaged bridge (modes/auto-title.ts, rules in auto-title-core.ts).
 *
 * Stock names a session from its first message only in the interactive TUI (`autoTitle` is a session
 * option that `main.ts` sets for the TUI alone, and it sets `PI_NO_TITLE` for `--mode rpc-ui`), so a
 * GUI session stayed "New session" until the user typed a name. The bridge runs stock's own title
 * machinery (`AgentSession.generateTitle` / `renameTitle`, the title model role) from its session
 * events instead.
 */

/** prefs keys (electron-store `prefs`); both default on. */
export const AUTO_TITLE_PREF = "autoTitle";
export const AUTO_TITLE_EVOLVE_PREF = "autoTitleEvolve";

/** Spawn env: JSON of {@link AutoTitleSettings}. */
export const AUTO_TITLE_ENV = "OMP_GUI_AUTO_TITLE";

export interface AutoTitleSettings {
	/** Name an unnamed session from its first message and keep the name current while it stays automatic. */
	enabled: boolean;
	/** Sub-switch: re-title as the work moves on. Only effective while `enabled` is on. */
	evolve: boolean;
	/**
	 * The user's own environment asked stock for no automatic titles (`PI_NO_TITLE`). Stock's `rpc-ui` mode
	 * sets `PI_NO_TITLE` itself, so the bridge cannot read the user's choice from its process: main reads it
	 * from the environment it hands to omp and passes it here.
	 */
	suppressed: boolean;
}

export const DEFAULT_AUTO_TITLE: AutoTitleSettings = { enabled: true, evolve: true, suppressed: false };

/** Re-titling counts only under the main switch. */
export function evolveEffective(settings: AutoTitleSettings): boolean {
	return settings.enabled && !settings.suppressed && settings.evolve;
}

/** A first title counts unless the user's environment asked for none. */
export function titleEffective(settings: AutoTitleSettings): boolean {
	return settings.enabled && !settings.suppressed;
}

/** Two stored prefs (anything not a boolean reads as the default, on) → settings. */
export function autoTitleFromPrefs(enabled: unknown, evolve: unknown, suppressed = false): AutoTitleSettings {
	return {
		enabled: typeof enabled === "boolean" ? enabled : DEFAULT_AUTO_TITLE.enabled,
		evolve: typeof evolve === "boolean" ? evolve : DEFAULT_AUTO_TITLE.evolve,
		suppressed,
	};
}

/** Untrusted JSON (env value, bridge params) → settings; a missing or malformed value reads as the default (on). */
export function normalizeAutoTitle(raw: unknown): AutoTitleSettings {
	if (typeof raw !== "object" || raw === null) return { ...DEFAULT_AUTO_TITLE };
	const { enabled, evolve, suppressed } = raw as Record<string, unknown>;
	return autoTitleFromPrefs(enabled, evolve, suppressed === true);
}

/** `OMP_GUI_AUTO_TITLE` → settings. */
export function parseAutoTitleEnv(raw: string | undefined): AutoTitleSettings {
	if (!raw) return { ...DEFAULT_AUTO_TITLE };
	try {
		return normalizeAutoTitle(JSON.parse(raw));
	} catch {
		return { ...DEFAULT_AUTO_TITLE };
	}
}

/**
 * Whether the environment omp is started with asks stock for no automatic titles (`PI_NO_TITLE`). The launch
 * profile cannot: `--no-title` is a code-controlled flag (`DENYLISTED_FLAGS` in src/shared/launch-profile.ts).
 */
export function titleSuppressedByEnv(env: Readonly<Record<string, string | undefined>>): boolean {
	const flag = env.PI_NO_TITLE;
	return flag !== undefined && flag !== "" && flag !== "0";
}

/**
 * The `trigger` the bridge stamps on every `title_change` entry it writes. It is how a title stays
 * automatic after the user's own name had made stock's `titleSource` "user" (see `titleIsAuto`).
 */
export const TITLE_TRIGGER = "ompdesk-auto";

/** Why a regeneration produced no title (the renderer words it). */
export type TitleRegenerateFailure =
	/** The conversation names no task yet (empty, greetings only) or the title model returned nothing. */
	| "none"
	/** A newer rename (or a session switch) replaced the request. */
	| "superseded";

/** `regenerate_title` result: the title (already saved), or why there is none. */
export type TitleRegenerateResult = { title: string } | { title: null; reason: TitleRegenerateFailure };
