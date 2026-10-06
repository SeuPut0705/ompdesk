/**
 * Shown when the user opens another session while the attached session is
 * streaming or compacting. Switching in place aborts the run server-side, so
 * the dialog steers to the parallel path — open the session in a new TAB
 * (its own pooled sidecar, same window) — while keeping open-in-new-window
 * and the destructive abort-and-switch one click away.
 */

import { useState } from "react";
import { switchSessionNow } from "../../hooks/use-session-switch";
import { useT } from "../../lib/i18n";
import { useTabsStore } from "../../stores/tabs";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Button, Modal } from "../common";

export function SessionSwitchDialog() {
	const t = useT();
	const session = useUiStore(s => s.sessionSwitchPrompt);
	const close = useUiStore(s => s.closeSessionSwitch);
	const [busy, setBusy] = useState<"new-tab" | "new-window" | "switch" | null>(null);

	const dismiss = () => {
		setBusy(null);
		close();
	};

	const openInNewTab = async () => {
		if (!session) return;
		setBusy("new-tab");
		try {
			// New tab owns a pooled sidecar bound to THIS window; the pending
			// session path is applied once that sidecar first reports ready.
			const tabId = await useTabsStore.getState().openTab({ cwd: session.cwd, sessionPath: session.path });
			if (tabId) dismiss();
		} finally {
			setBusy(null);
		}
	};

	const openInNewWindow = async () => {
		if (!session) return;
		setBusy("new-window");
		try {
			const ok = await window.omp.sessions.openInNewWindow({ sessionPath: session.path, cwd: session.cwd });
			if (!ok) {
				toast({ variant: "warning", message: t("sidebar.parallelCap") });
				return;
			}
			dismiss();
		} finally {
			setBusy(null);
		}
	};

	const switchAnyway = async () => {
		if (!session) return;
		setBusy("switch");
		try {
			if (await switchSessionNow(session)) dismiss();
		} finally {
			setBusy(null);
		}
	};

	const name = session?.title || session?.firstMessage || session?.id || "";

	return (
		<Modal open={session !== null} onClose={dismiss} title={t("sessionSwitch.title")} size="sm">
			<p className="text-omp-lg leading-relaxed text-(--omp-muted)">{t("sessionSwitch.body", { name })}</p>
			<div className="mt-5 flex flex-col gap-2">
				<Button
					variant="primary"
					loading={busy === "new-tab"}
					disabled={busy !== null}
					onClick={() => void openInNewTab()}
				>
					{t("sessionSwitch.openNewTab")}
				</Button>
				<Button
					variant="secondary"
					loading={busy === "new-window"}
					disabled={busy !== null}
					onClick={() => void openInNewWindow()}
				>
					{t("sessionSwitch.openNewWindow")}
				</Button>
				<Button
					variant="danger"
					loading={busy === "switch"}
					disabled={busy !== null}
					onClick={() => void switchAnyway()}
				>
					{t("sessionSwitch.switchAnyway")}
				</Button>
				<Button variant="ghost" disabled={busy !== null} onClick={dismiss}>
					{t("common.cancel")}
				</Button>
			</div>
		</Modal>
	);
}
