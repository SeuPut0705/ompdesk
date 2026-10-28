/**
 * Keeps the system tray in sync: derives a TrayState snapshot (run status,
 * project name, UI language) from the live stores and pushes it to the main
 * process on every change. Main updates the hover text and rebuilds the menu
 * only when something a user can read changed.
 */

import { useEffect } from "react";
import type { TrayState } from "../../shared/ipc-types";
import { type Attention, sessionWorking } from "../lib/attention";
import { basename } from "../lib/format";
import { useLang } from "../lib/i18n";
import { isTabFailed } from "../lib/tab-signal";
import { useSessionStore } from "../stores/session";
import { useSessionAttention } from "./use-session-attention";

/** What the tray says of the focused session. A session another omp still holds is a wait that ends by itself, not an error. */
export function trayStatusOf(state: {
	status: string;
	sessionHeld: boolean;
	attention: Attention | null;
	working: boolean;
}): TrayState["status"] {
	if (isTabFailed(state)) return "error";
	return state.attention?.kind ?? (state.working ? "streaming" : "idle");
}

export function useTraySync(): void {
	const { lang } = useLang();
	const cwd = useSessionStore(s => s.cwd);
	const working = useSessionStore(sessionWorking);
	const attention = useSessionAttention();
	const status = useSessionStore(s => s.status);
	const sessionHeld = useSessionStore(s => s.sidecarHeld);

	useEffect(() => {
		window.omp.tray.pushState({
			status: trayStatusOf({ status, sessionHeld, attention, working }),
			language: lang,
			projectName: cwd ? basename(cwd) || cwd : "OMPdesk",
		});
	}, [lang, cwd, working, attention, status, sessionHeld]);
}
