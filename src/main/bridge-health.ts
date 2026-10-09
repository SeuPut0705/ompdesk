/**
 * Startup compatibility self-check for the gui-bridge extension. omp internals
 * carry no semver, so after `omp update` a bridge method can lose what it
 * relies on. Once per omp version per app launch, the first sidecar whose
 * bridge connects is asked for `capabilities` (resources/gui-bridge/capabilities.ts);
 * missing features, or a bridge that never connected at all, become one warning
 * the renderer takes (BRIDGE_HEALTH_TAKE) and toasts in the UI language.
 */
import type { BridgeHealthWarning } from "../shared/ipc-types";
import type { BridgeClient } from "./local/types";

/** What a sidecar reports once its bridge connect settles (SidecarManager `bridge` event). */
export type BridgeConnectResult =
	| { connected: true; ompVersion: string; bridge: Pick<BridgeClient, "request"> }
	| { connected: false; ompVersion: string; error: string };

interface Capabilities {
	ompVersion?: unknown;
	unavailable?: unknown;
}

/**
 * Feature ids from a `capabilities` result; anything malformed reads as none.
 * `requiredOnly` drops `optional` features: ones only a newer omp has
 * (capabilities.ts FeatureRequirement.optional), which are no breakage.
 */
export function unavailableFeatures(result: unknown, { requiredOnly = false } = {}): string[] {
	const unavailable = (result as Capabilities | null)?.unavailable;
	if (!Array.isArray(unavailable)) return [];
	const features: string[] = [];
	for (const entry of unavailable) {
		if (typeof entry !== "object" || entry === null || !("feature" in entry)) continue;
		if (requiredOnly && "optional" in entry && entry.optional === true) continue;
		const feature = entry.feature;
		if (typeof feature === "string" && !features.includes(feature)) features.push(feature);
	}
	return features;
}

export class BridgeHealth {
	readonly #notify: () => void;
	/** `<kind>@<version>` already checked (or in flight) this launch. */
	readonly #seen = new Set<string>();
	/** Unavailable feature ids per omp version whose probe answered. */
	readonly #unavailable = new Map<string, readonly string[]>();
	#pending: BridgeHealthWarning[] = [];

	/** `notify` tells every window that warnings are waiting. */
	constructor(notify: () => void) {
		this.#notify = notify;
	}

	/** Settles once the probe (if any) is done; never rejects. */
	async observe(result: BridgeConnectResult): Promise<void> {
		if (!result.connected) {
			const key = `unavailable@${result.ompVersion}`;
			if (this.#seen.has(key)) return;
			this.#seen.add(key);
			this.#push({ kind: "unavailable", ompVersion: result.ompVersion, reason: result.error });
			return;
		}
		const key = `capabilities@${result.ompVersion}`;
		if (this.#seen.has(key)) return;
		this.#seen.add(key);
		let capabilities: unknown;
		try {
			capabilities = await result.bridge.request("capabilities");
		} catch (error) {
			// The next sidecar to connect retries; a dropped socket says nothing about omp.
			this.#seen.delete(key);
			console.warn(
				`[bridge-health] capabilities check failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		this.#unavailable.set(result.ompVersion, unavailableFeatures(capabilities));
		const features = unavailableFeatures(capabilities, { requiredOnly: true });
		if (features.length === 0) return;
		console.warn(
			`[bridge-health] omp ${result.ompVersion} lacks internals: ${JSON.stringify((capabilities as Capabilities).unavailable)}`,
		);
		const reported = (capabilities as Capabilities).ompVersion;
		this.#push({
			kind: "unsupported",
			ompVersion: typeof reported === "string" && reported ? reported : result.ompVersion,
			features,
		});
	}

	/**
	 * Whether omp `ompVersion` serves `feature` (capabilities.ts id), from this
	 * launch's probe; null before a sidecar of that version has answered one.
	 */
	supports(ompVersion: string, feature: string): boolean | null {
		const unavailable = this.#unavailable.get(ompVersion);
		return unavailable ? !unavailable.includes(feature) : null;
	}

	/** Hand every pending warning to the caller (one window), clearing them. */
	take(): BridgeHealthWarning[] {
		const pending = this.#pending;
		this.#pending = [];
		return pending;
	}

	#push(warning: BridgeHealthWarning): void {
		this.#pending.push(warning);
		this.#notify();
	}
}
