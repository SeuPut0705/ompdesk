/**
 * Finds the local inference engines of `LOCAL_ENGINES` (FreeToken, colibri) on loopback and keeps a models.yml
 * provider for each one that answers, so its models are listed without the person adding anything. Stock omp
 * watches models.yml and reloads it live; this class only writes entries through the same writer every GUI edit
 * uses. The rules are one table (`engineAction`); a paired computer runs its own detector over its own file.
 *
 * Write order is chosen so a crash between the file and the ledger leaves the harmless state: a made entry is
 * written first (a crash leaves an entry nobody owns, which the person can delete), a removed entry leaves the
 * ledger first (a crash leaves an unowned entry, never a "the person deleted it" tombstone for an engine that
 * merely went away).
 */
import type { CustomProviderInput } from "../shared/ipc-types";
import { LOCAL_ENGINES, type LocalEngineSpec, type LocalEnginesLedger } from "../shared/local-engines";
import { type EngineAction, engineAction } from "./local-engines-core";

/** `fetch` of an engine's model list never waits longer than this. */
export const LOCAL_ENGINE_PROBE_TIMEOUT_MS = 2_000;
export const LOCAL_ENGINE_INTERVAL_MS = 60_000;

/** The engine table and the pause between passes of this launch. */
export interface LocalEngineSettings {
	engines: readonly LocalEngineSpec[];
	intervalMs: number;
}

function isEngineSpec(value: unknown): value is LocalEngineSpec {
	const record = value as Record<string, unknown>;
	return (
		typeof value === "object" &&
		value !== null &&
		["id", "name", "baseUrl"].every(key => typeof record[key] === "string")
	);
}

/**
 * Test seam, unpackaged launches only: `OMP_GUI_TEST_LOCAL_ENGINES` (a JSON array of `LocalEngineSpec`) replaces the
 * table so a spec can serve a fake engine on any loopback port, `OMP_GUI_TEST_LOCAL_ENGINE_INTERVAL_MS` the pause.
 */
export function localEngineSettings(env: NodeJS.ProcessEnv, packaged: boolean): LocalEngineSettings {
	if (packaged) return { engines: LOCAL_ENGINES, intervalMs: LOCAL_ENGINE_INTERVAL_MS };
	let engines: readonly LocalEngineSpec[] = LOCAL_ENGINES;
	try {
		const parsed: unknown = env.OMP_GUI_TEST_LOCAL_ENGINES ? JSON.parse(env.OMP_GUI_TEST_LOCAL_ENGINES) : null;
		if (Array.isArray(parsed) && parsed.every(isEngineSpec)) engines = parsed;
	} catch {
		// An unreadable table is no table: the real one stays.
	}
	const interval = Number(env.OMP_GUI_TEST_LOCAL_ENGINE_INTERVAL_MS);
	return { engines, intervalMs: Number.isFinite(interval) && interval > 0 ? interval : LOCAL_ENGINE_INTERVAL_MS };
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** True when `GET <baseUrl>/models` answers like an OpenAI model list. Any error, and any address off loopback, is down. */
export async function probeLocalEngine(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
	try {
		const url = new URL(`${baseUrl.replace(/\/+$/, "")}/models`);
		if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) return false;
		const response = await fetchImpl(url, { signal: AbortSignal.timeout(LOCAL_ENGINE_PROBE_TIMEOUT_MS) });
		if (!response.ok) return false;
		const body: unknown = await response.json();
		return typeof body === "object" && body !== null && "data" in body && Array.isArray(body.data);
	} catch {
		return false;
	}
}

/** The provider entry of one engine; its models come from stock's `/models` discovery. */
export function engineProviderInput(engine: LocalEngineSpec): CustomProviderInput {
	return {
		id: engine.id,
		api: "openai-completions",
		baseUrl: engine.baseUrl,
		auth: "none",
		discovery: { type: "openai-models-list" },
		models: [],
	};
}

export interface LocalEngineDetectorDeps {
	engines: readonly LocalEngineSpec[];
	ledger: { get(): LocalEnginesLedger; set(value: LocalEnginesLedger): void };
	/** The pref `LOCAL_ENGINE_DETECT_PREF`, read now. */
	enabled(): boolean;
	probe(baseUrl: string): Promise<boolean>;
	providers: {
		ids(): Promise<Set<string>>;
		upsert(input: CustomProviderInput): Promise<void>;
		delete(id: string): Promise<void>;
	};
	/** models.yml was changed by a pass: windows read the model list again. */
	changed(): void;
	/** A read or write failed; the next pass tries again. `engine` is absent when the file itself could not be read. */
	failed?(error: unknown, engine?: LocalEngineSpec): void;
	intervalMs: number;
}

export class LocalEngineDetector {
	readonly #deps: LocalEngineDetectorDeps;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#inflight: Promise<void> | null = null;
	#started = false;
	#disposed = false;

	constructor(deps: LocalEngineDetectorDeps) {
		this.#deps = deps;
	}

	/** One pass now, then one every `intervalMs` after the previous one ends. */
	start(): void {
		if (this.#started || this.#disposed) return;
		this.#started = true;
		void this.#run();
	}

	dispose(): void {
		this.#disposed = true;
		this.#clearTimer();
	}

	/** Single-flight: a pass already running is the answer to every caller. */
	tick(): Promise<void> {
		if (this.#disposed) return Promise.resolve();
		this.#inflight ??= this.#pass().finally(() => {
			this.#inflight = null;
		});
		return this.#inflight;
	}

	/**
	 * The switch, called after `LOCAL_ENGINE_DETECT_PREF` is stored. Off: the entries the detector wrote go and the
	 * timer stops. On: a pass runs now; an entry the person deleted stays deleted (the tombstones outlive the switch).
	 */
	async setEnabled(on: boolean): Promise<void> {
		if (this.#disposed) return;
		this.#clearTimer();
		// A pass begun under the old value skips its writes; wait so it cannot land after what follows.
		await this.#inflight;
		if (!on) {
			await this.#unregisterAll();
			return;
		}
		await this.#run();
	}

	#clearTimer(): void {
		clearTimeout(this.#timer ?? undefined);
		this.#timer = null;
	}

	/** A pass, then the next one's timer; at most one timer exists, whoever arms it. */
	#run(): Promise<void> {
		return this.tick()
			.catch(() => undefined)
			.finally(() => {
				if (this.#disposed || !this.#started || !this.#deps.enabled()) return;
				this.#clearTimer();
				this.#timer = setTimeout(() => {
					this.#timer = null;
					void this.#run();
				}, this.#deps.intervalMs);
				this.#timer.unref?.();
			});
	}

	#live(): boolean {
		return !this.#disposed && this.#deps.enabled();
	}

	async #pass(): Promise<void> {
		if (!this.#live()) return;
		const { engines, providers } = this.#deps;
		let present: Set<string>;
		let up: boolean[];
		try {
			[present, up] = await Promise.all([
				providers.ids(),
				Promise.all(engines.map(engine => this.#deps.probe(engine.baseUrl).catch(() => false))),
			]);
		} catch (error) {
			this.#deps.failed?.(error);
			return;
		}
		let wrote = false;
		for (const [index, engine] of engines.entries()) {
			// Re-read after the awaits: the switch may have turned off while the probes ran.
			if (!this.#live()) break;
			const ledger = this.#deps.ledger.get();
			const action = engineAction({
				up: up[index] ?? false,
				present: present.has(engine.id),
				registered: ledger.registered.includes(engine.id),
				removed: ledger.removed.includes(engine.id),
			});
			try {
				wrote = (await this.#apply(action, engine)) || wrote;
			} catch (error) {
				this.#deps.failed?.(error, engine);
			}
		}
		if (wrote) this.#deps.changed();
	}

	/** Applies one action; true when models.yml changed. */
	async #apply(action: EngineAction, engine: LocalEngineSpec): Promise<boolean> {
		switch (action) {
			case "register":
				await this.#deps.providers.upsert(engineProviderInput(engine));
				this.#edit(ledger => ({ ...ledger, registered: [...ledger.registered, engine.id] }));
				return true;
			case "tombstone":
				this.#edit(ledger => ({
					registered: ledger.registered.filter(id => id !== engine.id),
					removed: [...ledger.removed, engine.id],
				}));
				return false;
			case "unregister":
				await this.#release(engine.id);
				return true;
			case "none":
				return false;
		}
	}

	/** The ledger lets go of `id` first, then the entry goes; a failed delete gives it back. */
	async #release(id: string): Promise<void> {
		this.#edit(ledger => ({ ...ledger, registered: ledger.registered.filter(item => item !== id) }));
		try {
			await this.#deps.providers.delete(id);
		} catch (error) {
			this.#edit(ledger => ({ ...ledger, registered: [...ledger.registered, id] }));
			throw error;
		}
	}

	async #unregisterAll(): Promise<void> {
		let wrote = false;
		for (const id of [...this.#deps.ledger.get().registered]) {
			try {
				await this.#release(id);
				wrote = true;
			} catch (error) {
				this.#deps.failed?.(
					error,
					this.#deps.engines.find(engine => engine.id === id),
				);
			}
		}
		if (wrote) this.#deps.changed();
	}

	#edit(change: (ledger: LocalEnginesLedger) => LocalEnginesLedger): void {
		this.#deps.ledger.set(change(this.#deps.ledger.get()));
	}
}
