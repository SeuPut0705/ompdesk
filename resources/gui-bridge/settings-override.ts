/**
 * A stock setting's runtime override handle (not persisted; `clearOverride` gives the configured value back), read
 * through `config/registry` `lookup` so no stock module is imported by path.
 */
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";

export interface OverridableSetting {
	override(scope: object, value: unknown): void;
	clearOverride(scope: object): void;
}

export function overridable(id: string): OverridableSetting {
	const setting: unknown = lookup(id);
	if (
		!setting ||
		typeof setting !== "object" ||
		!("override" in setting) ||
		typeof setting.override !== "function" ||
		!("clearOverride" in setting) ||
		typeof setting.clearOverride !== "function"
	) {
		throw new Error(`omp has no overridable ${id} setting`);
	}
	return setting as OverridableSetting;
}
