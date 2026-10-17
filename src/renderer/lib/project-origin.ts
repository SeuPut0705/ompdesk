import { useCallback, useEffect, useMemo } from "react";
import {
	type ProjectOrigin,
	projectDisplayName,
	type WorktreeKindLabels,
	worktreeFolderSlug,
} from "../../shared/project-origin";
import { useProjectOrigins } from "../stores/project-origins";
import { useT } from "./i18n";

/** How a folder presents itself: the name to show, the tooltip with the full path, and what git says it is. */
export interface ProjectName {
	/** `acme-web` for a main checkout's folder, `acme-web · Autopilot` for a linked worktree. */
	name: string;
	/** The full path; for a linked worktree also the project it was cut from. */
	tooltip: string;
	/** The origin when `cwd` is a linked worktree, else null. */
	worktree: ProjectOrigin | null;
	/** The main checkout the folder belongs to; the folder itself when git says nothing else. */
	root: string;
}

/** The kind words in the UI language. */
export function useWorktreeKindLabels(): WorktreeKindLabels {
	const t = useT();
	return useMemo(() => ({ autopilot: t("project.worktree.autopilot"), agent: t("project.worktree.agent") }), [t]);
}

/**
 * Names folders for display. Asks main (git) about `cwds` and re-renders as the answers land; until then, and for a
 * folder git cannot place, the folder's own name shows (a worktree folder without OMPdesk's `gui-…-<hash>` dressing).
 * The returned function reads any folder, asked for or not.
 */
export function useProjectNames(cwds: readonly string[]): (cwd: string, title?: string | null) => ProjectName {
	const t = useT();
	const labels = useWorktreeKindLabels();
	const origins = useProjectOrigins(state => state.origins);
	const key = cwds.join("\n");
	useEffect(() => {
		useProjectOrigins.getState().request(key === "" ? [] : key.split("\n"));
	}, [key]);
	return useCallback(
		(cwd, title) => {
			const origin = origins[cwd];
			const linked = origin?.worktree ? origin : null;
			const name = projectDisplayName(linked, worktreeFolderSlug(cwd) || cwd, labels, title);
			return {
				name,
				tooltip: linked ? t("project.worktree.tooltip", { project: linked.project, path: cwd }) : cwd,
				worktree: linked,
				root: origin?.root ?? cwd,
			};
		},
		[origins, labels, t],
	);
}
