import type { SessionInfo } from "../../shared/ipc-types";
import { formatTimeAgo } from "./format";
import { translate } from "./i18n";
import { sessionDisplayTitle } from "./session-title";

/**
 * Where a forked session came from (stock's `parentSession` header, `parentSessionPath`: the parent's file path, or
 * its id after a move), so a fork never reads as a second copy of its original. The sidebar row and the title bar
 * both show it: the parent's title after their own (`session.fork.from`), its words for screen readers (`label`) and
 * one tooltip line naming the branch, the parent and when it was cut.
 */
export interface SessionForkOrigin {
	/** The parent's display title; null when the index does not list it (deleted, on another device). */
	parentTitle: string | null;
	label: string;
	tooltip: string;
}

export function sessionForkOrigin(
	session: Pick<SessionInfo, "parentSessionPath" | "created">,
	sessionsByPathOrId: ReadonlyMap<string, Pick<SessionInfo, "title" | "firstMessage">>,
): SessionForkOrigin | null {
	if (!session.parentSessionPath) return null;
	const parent = sessionsByPathOrId.get(session.parentSessionPath);
	const parentTitle = parent ? sessionDisplayTitle(parent, translate("sidebar.untitled")) : null;
	const time = formatTimeAgo(session.created);
	return parentTitle
		? {
				parentTitle,
				label: translate("sidebar.row.forkedFrom", { name: parentTitle }),
				tooltip: translate("session.fork.tooltip", { name: parentTitle, time }),
			}
		: {
				parentTitle: null,
				label: translate("sidebar.row.fork"),
				tooltip: translate("session.fork.tooltipNoParent", { time }),
			};
}
