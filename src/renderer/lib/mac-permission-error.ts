/**
 * Stock's built-in computer use (pi-natives, through the `computer` tool or the eval prelude) failing for a missing
 * macOS permission: "<Screen Recording|Accessibility> permission is not granted to the app that launched omp; …"
 * (omp 18.13), or an older "macOS Accessibility permission is required for native input". The step then shows the
 * same fix as agent-desktop's `PERM_DENIED` (components/chat/MacPermissionFix.tsx).
 */
const MISSING_PERMISSION =
	/\b(?:Screen Recording|Screen & System Audio Recording|Accessibility) permission (?:is not granted|is required)\b/;

export function needsMacPermission(text: string): boolean {
	return MISSING_PERMISSION.test(text);
}
