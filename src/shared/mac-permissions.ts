/**
 * The two macOS permissions computer use needs (main: src/main/mac-permissions.ts; Settings › Agent behavior ›
 * Computer use and the transcript's fix line read them). macOS attributes agent-desktop, and stock's built-in computer
 * use inside omp, to OMPdesk (TCC's responsible process), so OMPdesk's own grant is what both engines get. An app can
 * never grant them: OMPdesk asks macOS, which adds OMPdesk to the list and shows its prompt; the person turns it on.
 */

export const MAC_PERMISSIONS = ["accessibility", "screen"] as const;
export type MacPermission = (typeof MAC_PERMISSIONS)[number];

/** Whether each is granted to OMPdesk now. `null` where macOS permissions do not exist (Windows). */
export type MacPermissionStatus = Readonly<Record<MacPermission, boolean>>;

export function isMacPermission(value: unknown): value is MacPermission {
	return typeof value === "string" && (MAC_PERMISSIONS as readonly string[]).includes(value);
}
