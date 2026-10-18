/**
 * The web page's live runtime, for UI that is not `window.omp` (the sheets and the host folder browser that
 * register hooks, the Settings page of a device, the connection banner): the connection state and the
 * calls only a web page has. `web-boot.ts` sets it before the app loads; a desktop window never does.
 */
import type { WebFeatures } from "../../shared/web-protocol";
import type { HostActions } from "./host-hooks";
import type { ReloadReason } from "./reload-reason";
import type { WsConnectionState } from "./ws-transport";

export interface WebRuntime {
	host: HostActions;
	connectionState(): WsConnectionState;
	onConnectionState(listener: (state: WsConnectionState) => void): () => void;
	/** What the host offered in its last `hello`; null before the first one. */
	features(): WebFeatures | null;
	/** Raise a native-menu action on the page (the More sheet and the command palette). */
	emitMenuAction(action: string, payload?: Record<string, unknown>): void;
	/**
	 * After a reconnect that missed events the page catches up in place (resync-page.ts); a view holding a snapshot
	 * of its own (one the missed pushes would have replaced) reads it again here. Returns the unsubscribe.
	 */
	onResynced(listener: () => void): () => void;
	/**
	 * Load the page again, saying why in the host's runtime log (reload-reason.ts): a new build's waiting worker takes
	 * over first, so the reload lands on the new build.
	 */
	reload(reason: ReloadReason): void;
	/** Show or request notification permission, for the Settings page of a device. */
	requestNotifications(): Promise<NotificationPermission | "unsupported">;
}

let runtime: WebRuntime | null = null;

export function setWebRuntime(next: WebRuntime): void {
	runtime = next;
}

/** The runtime of a web page; null in the desktop app. */
export function webRuntime(): WebRuntime | null {
	return runtime;
}
