/**
 * Delegation strength, pure half (modes/delegation.ts wires it to stock omp;
 * values in delegation-contracts.ts). A strength is held per Settings scope as
 * stock runtime overrides (`Setting.override`, never persisted), so the omp CLI
 * and config.yml keep the user's own values:
 *
 * - Switching strengths clears the previous strength's overrides first, so a
 *   setting the next one leaves alone falls back to the user's value.
 * - `default` holds nothing.
 * - The user's own Settings write of one of the held settings releases the
 *   whole strength (`releaseDelegationFor`), so that write takes effect instead
 *   of hiding under an override; the chip then reads `default`.
 *
 * No omp imports (not even types), no Bun globals: the GUI's vitest exercises
 * this file directly (src/main/bridge-delegation.test.ts).
 */
import {
	DELEGATION_PRESETS,
	type DelegationMode,
	type DelegationPreset,
	type DelegationSettingId,
} from "./delegation-contracts";

/** The stock `Setting` handle members used here (`lookup("task.eager")`). */
export interface DelegationSetting {
	id: string;
	override(scope: object, value: unknown): void;
	clearOverride(scope: object): void;
}

export type DelegationHandles = (id: DelegationSettingId) => DelegationSetting | undefined;

/** `value` as a handle, or undefined when this omp lacks a member it needs. */
export function asDelegationSetting(value: unknown): DelegationSetting | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = value as Partial<Record<keyof DelegationSetting, unknown>>;
	if (typeof candidate.id !== "string") return undefined;
	if (typeof candidate.override !== "function" || typeof candidate.clearOverride !== "function") return undefined;
	return value as DelegationSetting;
}

/** Per Settings scope, the strength whose overrides are held. */
const held = new WeakMap<object, Exclude<DelegationMode, "default">>();

export function heldDelegation(scope: object): DelegationMode {
	return held.get(scope) ?? "default";
}

function presetEntries(preset: DelegationPreset): [DelegationSettingId, string | number][] {
	return Object.entries(preset) as [DelegationSettingId, string | number][];
}

/** Resolve every handle `mode` and the held strength touch, or throw naming the missing one. */
function resolveHandles(
	handles: DelegationHandles,
	ids: readonly DelegationSettingId[],
): Map<string, DelegationSetting> {
	const resolved = new Map<string, DelegationSetting>();
	for (const id of ids) {
		const handle = handles(id);
		if (!handle) throw new Error(`This omp has no ${id} setting, so the delegation strength cannot change`);
		resolved.set(id, handle);
	}
	return resolved;
}

/** Hold `mode` on `scope` (dropping the previous strength); returns the strength now held. */
export function applyDelegation(handles: DelegationHandles, scope: object, mode: DelegationMode): DelegationMode {
	const previous = held.get(scope);
	const previousEntries = previous ? presetEntries(DELEGATION_PRESETS[previous]) : [];
	const nextEntries = mode === "default" ? [] : presetEntries(DELEGATION_PRESETS[mode]);
	const resolved = resolveHandles(
		handles,
		[...previousEntries, ...nextEntries].map(([id]) => id),
	);
	for (const [id] of previousEntries) resolved.get(id)?.clearOverride(scope);
	held.delete(scope);
	for (const [id, value] of nextEntries) resolved.get(id)?.override(scope, value);
	if (mode !== "default") held.set(scope, mode);
	return mode;
}

/** The user wrote `settingId` through Settings: drop the held strength if it sets that id. */
export function releaseDelegationFor(settingId: string, scope: object, handles: DelegationHandles): boolean {
	const mode = held.get(scope);
	if (!mode || !Object.hasOwn(DELEGATION_PRESETS[mode], settingId)) return false;
	applyDelegation(handles, scope, "default");
	return true;
}
