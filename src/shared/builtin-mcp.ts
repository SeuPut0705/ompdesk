import reaConfig from "../../resources/omp-builtin/rea/rea-config.json" with { type: "json" };

/** OMPdesk-only MCP preference; stock omp config is never modified. */
export const REA_PREF = "builtinMcp.rea";
export const REA_VERSION = reaConfig.version;
export const REA_CURATED_TOOL_COUNT = reaConfig.curatedTools.length;
export const REA_MOUNTED_TOOL_COUNT = REA_CURATED_TOOL_COUNT + 2;
export const REA_NODE_REQUIREMENT = "^22.19.0 || ^24.11.0 || >=26.0.0";
export type ReaUnavailable = "node-missing" | "npx-missing" | "node-version" | "node-failed" | "npx-failed";
export interface BuiltinReaState {
	enabled: boolean;
	available: boolean;
	nodeVersion?: string;
	reason?: ReaUnavailable;
}
export function reaEnabled(value: unknown): boolean {
	return value !== false;
}
/** REA's engines range, checked before omp starts (stock cannot gate this app-only root). */
export function reaNodeSupported(version: string): boolean {
	const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
	if (!match) return false;
	const major = Number(match[1]);
	const minor = Number(match[2]);
	return major >= 26 || (major === 22 && minor >= 19) || (major === 24 && minor >= 11);
}
export function reaExtensionArgs(root: string, state: BuiltinReaState): string[] {
	return state.enabled && state.available ? ["-e", root] : [];
}
