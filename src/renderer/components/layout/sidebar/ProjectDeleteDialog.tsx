/**
 * The confirm of a project's one Delete (`project-menu.ts`, flow in `project-delete.ts`), the same on this computer's
 * list, a paired host's and the phone. Delete takes the project out of its computer's list; the opt-in checkbox (off
 * every time it opens) also deletes its saved sessions, which says it is permanent.
 */
import { useEffect, useState } from "react";
import { useT } from "../../../lib/i18n";
import { Checkbox } from "../../common/Checkbox";
import { ConfirmDialog } from "../../common/ConfirmDialog";

export interface ProjectDeleteDialogProps {
	/** The project asked about; null closes the dialog. */
	project: { name: string; saved: number; open: number } | null;
	busy: boolean;
	onConfirm: (alsoSessions: boolean) => void;
	onCancel: () => void;
}

export function ProjectDeleteDialog({ project, busy, onConfirm, onCancel }: ProjectDeleteDialogProps) {
	const t = useT();
	const [alsoSessions, setAlsoSessions] = useState(false);
	useEffect(() => {
		if (project === null) setAlsoSessions(false);
	}, [project]);
	const saved = project?.saved ?? 0;
	return (
		<ConfirmDialog
			busy={busy}
			message={
				<div className="space-y-3">
					<p>{t("sidebar.deleteProjectMessage", { name: project?.name ?? "" })}</p>
					{saved > 0 && (
						<label className="flex items-start gap-2" data-project-delete-sessions>
							<Checkbox
								checked={alsoSessions}
								className="mt-0.5"
								disabled={busy}
								onChange={event => setAlsoSessions(event.target.checked)}
							/>
							<span>{t("sidebar.deleteProjectSessions", { count: saved })}</span>
						</label>
					)}
					{!alsoSessions && (project?.open ?? 0) > 0 && (
						<p className="text-sc-sm text-(--sc-text-muted)">{t("sidebar.deleteProjectOpenNote")}</p>
					)}
				</div>
			}
			onCancel={onCancel}
			onConfirm={() => onConfirm(alsoSessions && saved > 0)}
			open={project !== null}
			title={t("sidebar.deleteProjectConfirm")}
			warning={alsoSessions && saved > 0 ? t("sidebar.deleteGroupWarning") : undefined}
		/>
	);
}
