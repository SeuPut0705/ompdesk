/**
 * This machine's account-rotation pref (src/shared/account-rotation.ts) as
 * LocalMachine serves it: a change is stored, then pushed to every live omp
 * this computer runs — its own tabs and the ones it hosts for paired devices.
 * Tabs on a paired host are left alone; they follow the host's own pref.
 */
import { ACCOUNT_ROTATION_PREF } from "../shared/account-rotation";
import type { AccountRotationDeps } from "./machine-services";
import type { SidecarLike } from "./sidecar-pool";

export interface AccountRotationWiring {
	prefs: { get(key: string): unknown; set(key: string, value: unknown): void };
	/** Every tab of this computer's windows, local and remote (SidecarPool.allSidecars). */
	tabs: () => Iterable<Pick<SidecarLike, "device" | "syncAccountRotation">>;
	/** The tabs this computer runs for paired devices (RemoteDevices.hostAccountRotationChanged). */
	hostedTabsChanged: () => void;
	/** The gui-bridge probe verdict for this computer's omp; null before one answered. */
	evenSupported: () => Promise<boolean | null>;
}

export function accountRotationDeps(wiring: AccountRotationWiring): AccountRotationDeps {
	return {
		read: () => wiring.prefs.get(ACCOUNT_ROTATION_PREF),
		write: mode => {
			wiring.prefs.set(ACCOUNT_ROTATION_PREF, mode);
			for (const tab of wiring.tabs()) if (!tab.device) tab.syncAccountRotation();
			wiring.hostedTabsChanged();
		},
		evenSupported: wiring.evenSupported,
	};
}
