/**
 * Keeps the system tray in sync: derives a TrayState snapshot (run status,
 * project name, UI language) from the focused session's summary and pushes it
 * to the main process on every change. Main updates the hover text and rebuilds
 * the menu only when something a user can read changed.
 */

import { useEffect } from "react";
import type { TrayState } from "../../shared/ipc-types";
import type { Attention } from "../lib/attention";
import { basename } from "../lib/format";
import { useLang } from "../lib/i18n";
import type { SessionRun } from "../lib/session-run";
import { useSessionStore } from "../stores/session";
import { useSessionAttention } from "./use-session-attention";
import { useFocusedRun } from "./use-tab-run";

/**
 * What the tray says of the focused session, by its sidebar row's rule (`sessionRun`): a failed omp, else what it
 * needs from the person, else its work. A session another omp still holds is a wait that ends by itself, not an error.
 */
export function trayStatusOf(
	run: Pick<SessionRun, "failed" | "running">,
	attention: Attention | null,
): TrayState["status"] {
	if (run.failed) return "error";
	return attention?.kind ?? (run.running ? "streaming" : "idle");
}

export function useTraySync(): void {
	const { lang } = useLang();
	const cwd = useSessionStore(s => s.cwd);
	const { failed, running } = useFocusedRun().run;
	const attention = useSessionAttention();

	useEffect(() => {
		window.omp.tray.pushState({
			status: trayStatusOf({ failed, running }, attention),
			language: lang,
			projectName: cwd ? basename(cwd) || cwd : "OMPdesk",
		});
	}, [lang, cwd, failed, running, attention]);
}
