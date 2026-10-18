import type { ReloadReason } from "../web/reload-reason";
import { webRuntime } from "../web/runtime";

/**
 * Load the window again because of `reason`. On a paired web page the reason reaches the host's runtime log and a
 * waiting new build takes over first (web-boot.ts `reload`); a desktop window just reloads.
 */
export function reloadPage(reason: ReloadReason): void {
	const web = webRuntime();
	if (web) web.reload(reason);
	else window.location.reload();
}
