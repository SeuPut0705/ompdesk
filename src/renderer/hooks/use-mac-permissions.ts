/**
 * The macOS permissions computer use needs, as the computer this window talks to has them (src/shared/mac-permissions.ts;
 * a phone page reads its host's). Read when mounted and again whenever the window regains focus: the person turns the
 * switch on in System Settings and comes back, so no polling. `undefined` while the first read is out, `null` off macOS.
 */
import { useCallback, useEffect, useState } from "react";
import type { MacPermission, MacPermissionStatus } from "../../shared/mac-permissions";

export interface MacPermissionsView {
	status: MacPermissionStatus | null | undefined;
	/** The permission whose request is out, so its button shows work. */
	asking: MacPermission | null;
	/** Ask macOS for it and open its pane; rejects with the request's error. */
	request(permission: MacPermission): Promise<void>;
}

export function useMacPermissions(): MacPermissionsView {
	const [status, setStatus] = useState<MacPermissionStatus | null | undefined>(undefined);
	const [asking, setAsking] = useState<MacPermission | null>(null);

	useEffect(() => {
		let live = true;
		const read = () => {
			window.omp.prefs
				.macPermissionsStatus()
				.then(next => {
					if (live) setStatus(next);
				})
				// What was read stays; the next focus reads again.
				.catch(() => {});
		};
		read();
		window.addEventListener("focus", read);
		return () => {
			live = false;
			window.removeEventListener("focus", read);
		};
	}, []);

	const request = useCallback(async (permission: MacPermission) => {
		setAsking(permission);
		try {
			setStatus(await window.omp.prefs.requestMacPermission(permission));
		} finally {
			setAsking(null);
		}
	}, []);

	return { status, asking, request };
}
