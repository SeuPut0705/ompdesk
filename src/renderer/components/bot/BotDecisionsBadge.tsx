/**
 * The open-decision count on a bot's sidebar row, this computer's and a paired host's alike: the warning badge that
 * takes the age slot while the bot has decisions waiting on the owner.
 */
import { Inbox } from "lucide-react";
import { useT } from "../../lib/i18n";
import { Badge } from "../common";

export function BotDecisionsBadge({ count }: { count: number }) {
	const t = useT();
	return (
		<Badge className="omp-sidebar-approval" variant="warning">
			<Inbox aria-hidden className="size-3 shrink-0" />
			<span
				className="min-w-0 truncate"
				data-sidebar-bot-decisions={count}
				title={t("sidebar.botDecisionsTip", { count })}
			>
				{t("sidebar.botDecisions", { count })}
			</span>
		</Badge>
	);
}
