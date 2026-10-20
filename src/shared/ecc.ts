/** Prefs key; built-in ECC pack (`resources/omp-builtin/ecc`) loads unless stored `false`. */
export const ECC_PREF = "ecc";

export function eccEnabled(value: unknown): boolean {
	return value !== false;
}
