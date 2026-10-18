/** Prefs key; built-in pstack pack (`resources/omp-builtin/pstack`) loads unless stored `false`. */
export const PSTACK_PREF = "pstack";

export function pstackEnabled(value: unknown): boolean {
	return value !== false;
}
