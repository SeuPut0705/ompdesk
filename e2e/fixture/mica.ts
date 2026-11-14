/**
 * Whether a Windows build gets the Mica backdrop, as the shell decides it (`chrome_core/window.rs` `mica_supported`:
 * Windows 11 22H2, build 22621, and later): the specs read the window the shell made against it.
 */
export function micaSupported(platform: NodeJS.Platform, release: string): boolean {
	return platform === "win32" && Number(release.split(".")[2] ?? 0) >= 22621;
}
