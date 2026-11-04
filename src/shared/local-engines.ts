/**
 * Local inference engines OMPdesk looks for on loopback and lists the models of by itself (main:
 * `local-engines.ts`; renderer: the one switch under Settings › Models & accounts). Dependency-free: both sides import it.
 */

/** Boolean pref; never stored = on. */
export const LOCAL_ENGINE_DETECT_PREF = "localEngineDetect";
/** Pref holding `LocalEnginesLedger`: what the detector wrote and what the person removed. */
export const LOCAL_ENGINES_LEDGER_PREF = "localEngines";

/** One engine: `id` is the models.yml provider id it is registered under. */
export interface LocalEngineSpec {
	id: string;
	name: string;
	/** OpenAI-compatible root, `/models` is read below it. */
	baseUrl: string;
}

// FreeToken: https://github.com/FlashML-org/FreeToken, colibri: https://github.com/JustVugg/colibri
export const LOCAL_ENGINES: readonly LocalEngineSpec[] = [
	{ id: "freetoken", name: "FreeToken", baseUrl: "http://127.0.0.1:1919/v1" },
	{ id: "colibri", name: "colibri", baseUrl: "http://127.0.0.1:8000/v1" },
];

/**
 * `registered`: entries the detector wrote and still owns. `removed`: automatic entries the person deleted (UI or a
 * hand edit of models.yml), never made again until the switch is turned off and on.
 */
export interface LocalEnginesLedger {
	registered: string[];
	removed: string[];
}

/** The detection switch of one computer, as `LOCAL_ENGINES_GET|SET` and `host.localEngines.*` answer. */
export interface LocalEngineDetectState {
	enabled: boolean;
}

/** A stored ledger read back: anything unexpected is dropped, never thrown on. */
export function parseLocalEnginesLedger(value: unknown): LocalEnginesLedger {
	if (typeof value !== "object" || value === null) return { registered: [], removed: [] };
	const strings = (list: unknown): string[] =>
		Array.isArray(list) ? [...new Set(list.filter((item): item is string => typeof item === "string"))] : [];
	const record = value as Record<string, unknown>;
	return { registered: strings(record.registered), removed: strings(record.removed) };
}

export function localEngineDetectEnabled(value: unknown): boolean {
	return value !== false;
}
