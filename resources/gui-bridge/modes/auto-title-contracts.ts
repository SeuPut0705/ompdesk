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

/**
 * The journal entry (stock `appendCustomEntry`) holding an automatic title the bridge generated while the session's
 * name is one the person typed: stock's name slot stays theirs, and the newest of these is shown beside it.
 */
export const AUTO_TITLE_ENTRY = "ompdesk.auto-title";

/** The slice of a journal entry the title rules read: stock's `title_change` and OMPdesk's {@link AUTO_TITLE_ENTRY}. */
export interface TitleJournalEntry {
	type: string;
	title?: string;
	source?: string;
	trigger?: string;
	customType?: string;
	data?: unknown;
}

/** A `title_change` that wrote an automatic title: stock's own, or the bridge's stamped one over a typed name. */
function automaticChange(entry: TitleJournalEntry): boolean {
	return entry.source === "auto" || entry.trigger === TITLE_TRIGGER;
}

/** The automatic title a journal entry holds: OMPdesk's entry beside a typed name, or an automatic `title_change`. */
function automaticTitleOf(entry: TitleJournalEntry): string | undefined {
	if (entry.type === "custom" && entry.customType === AUTO_TITLE_ENTRY) {
		const data = entry.data;
		return typeof data === "object" && data !== null && "title" in data && typeof data.title === "string"
			? data.title || undefined
			: undefined;
	}
	return entry.type === "title_change" && automaticChange(entry) ? entry.title || undefined : undefined;
}

/** Whether a journal entry holds an automatic title ({@link latestAutoTitle} reads the newest such entry). */
export function isAutomaticTitle(entry: TitleJournalEntry): boolean {
	return automaticTitleOf(entry) !== undefined;
}

/** The newest automatic title in the journal: OMPdesk's entry beside a typed name, or an automatic `title_change`. */
export function latestAutoTitle(entries: readonly TitleJournalEntry[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const title = entry && automaticTitleOf(entry);
		if (title) return title;
	}
	return undefined;
}

/** The name the person typed, when the session's newest `title_change` is one (not the bridge's stamped write). */
export function typedTitle(entries: readonly TitleJournalEntry[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "title_change") continue;
		return entry.title && !automaticChange(entry) ? entry.title : undefined;
	}
	return undefined;
}

/**
 * The automatic title every surface shows beside the session's name (`SessionInfo.autoTitle`): the newest automatic
 * title while the name is one the person typed and differs from it; undefined otherwise (no typed name: the name is
 * the automatic title itself).
 */
export function shownAutoTitle(entries: readonly TitleJournalEntry[]): string | undefined {
	const typed = typedTitle(entries);
	if (!typed) return undefined;
	const auto = latestAutoTitle(entries);
	return auto && auto.trim() !== typed.trim() ? auto : undefined;
}

/** Why a regeneration produced no title (the renderer words it). */
export type TitleRegenerateFailure =
	/** The conversation names no task yet (empty, greetings only) or the title model returned nothing. */
	| "none"
	/** A newer rename (or a session switch) replaced the request. */
	| "superseded";

/** `regenerate_title` result: the title (already saved), or why there is none. */
export type TitleRegenerateResult = { title: string } | { title: null; reason: TitleRegenerateFailure };
