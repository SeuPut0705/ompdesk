import { useCallback, useEffect, useRef, useState } from "react";
import { useSessionList } from "../../hooks/use-session-list";
import { useShellMode } from "../../hooks/use-shell-mode";
import { useT } from "../../lib/i18n";
import { hostOrderKey } from "../../lib/project-order";
import { sessionDisplayTitle } from "../../lib/session-title";
import { readTranscriptSnapshot } from "../../lib/transcript-snapshot";
import { useSidebarPrefs } from "../../stores/sidebar-prefs";
import { useTabsStore } from "../../stores/tabs";
import { toastError } from "../../stores/toast";
import type { MissingFolderRequest } from "../../stores/ui";
import { Banner, Button, PanelErrorBoundary, Sheet } from "../common";
import { SubagentTranscript } from "../panels/SubagentTranscript";
import type { SubagentTranscriptState } from "../panels/use-subagent-transcript";

/**
 * A stored session's transcript with no omp behind it (`sessions.messages`: this computer's journal, or the paired
 * host's). It paints the last transcript this computer kept of the session at once when it has one (the snapshot of a
 * tab that showed it; a first visit, or a host's session never opened here, shows the transcript's static skeleton) and
 * replaces it in place with the read.
 */
function useStoredTranscript(sessionPath: string, device: string | undefined): SubagentTranscriptState {
	const [state, setState] = useState(() => ({
		messages: readTranscriptSnapshot({ sessionPath, ...(device === undefined ? {} : { device }) })?.messages ?? [],
		loading: true,
		error: null as string | null,
	}));
	const generation = useRef(0);
	const load = useCallback(() => {
		const mine = ++generation.current;
		setState(prev => (prev.error === null ? prev : { ...prev, loading: true, error: null }));
		window.omp.sessions.messages(sessionPath, device).then(
			messages => {
				if (mine === generation.current) setState({ messages, loading: false, error: null });
			},
			cause => {
				if (mine === generation.current)
					setState(prev => ({
						...prev,
						loading: false,
						error: cause instanceof Error ? cause.message : String(cause),
					}));
			},
		);
	}, [sessionPath, device]);
	useEffect(() => {
		load();
		return () => {
			generation.current++;
		};
	}, [load]);
	return { ...state, busy: false, hasMore: false, loadMore: () => undefined, reload: load };
}

/**
 * The sheet a click on a stored session whose folder is gone opens instead of resuming work there (main refuses the
 * spawn: `folder-missing`): its transcript, read-only (no composer), and one action. Restore when disk care saved the
 * worktree (the reopen with `restoreSaved`), else Archive (the sidebar's own archive of that row, a paired host's
 * under its `hostOrderKey`).
 */
export function MissingFolderSheet({
	request,
	open,
	onClose,
}: {
	request: MissingFolderRequest;
	open: boolean;
	onClose: () => void;
}) {
	const t = useT();
	const phone = useShellMode() === "phone";
	const { sessionPath, device, folder, saved } = request;
	const { sessions } = useSessionList("global", device);
	const row = sessions.find(session => session.path === sessionPath);
	const title = row ? sessionDisplayTitle(row, t("sidebar.untitled")) : t("sidebar.untitled");
	const transcript = useStoredTranscript(sessionPath, device);

	const restore = () => {
		onClose();
		useTabsStore
			.getState()
			.openTab({
				sessionPath,
				kind: row?.kind === "chat" ? "chat" : "agent",
				restoreSaved: true,
				...(device === undefined ? {} : { device }),
			})
			.catch((error: unknown) => toastError({ title: t("tabs.newFailed"), error }));
	};
	const archive = () => {
		if (!row) return;
		onClose();
		useSidebarPrefs
			.getState()
			.setSessionsArchived([device === undefined ? row.id : hostOrderKey(device, row.id)], true)
			.catch((error: unknown) => toastError({ title: t("sidebar.archiveFailed"), error }));
	};

	return (
		<Sheet
			bodyClassName="flex min-h-0 flex-1 flex-col"
			footer={
				saved ? (
					<Button data-missing-folder-restore onClick={restore} variant="primary">
						{t("missingFolder.restore")}
					</Button>
				) : (
					<Button data-missing-folder-archive disabled={!row} onClick={archive} variant="primary">
						{t("missingFolder.archive")}
					</Button>
				)
			}
			onClose={onClose}
			open={open}
			placement={phone ? "full" : "right"}
			size="lg"
			title={title}
		>
			<div className="flex min-h-0 flex-1 flex-col" data-missing-folder-sheet={sessionPath}>
				<div className="shrink-0 px-4 pt-3 pb-1">
					<Banner variant="warning">
						{t(saved ? "missingFolder.bannerSaved" : "missingFolder.banner", { folder })}
					</Banner>
				</div>
				<PanelErrorBoundary>
					<SubagentTranscript live={false} transcript={transcript} />
				</PanelErrorBoundary>
			</div>
		</Sheet>
	);
}
