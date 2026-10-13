import { PlanDockCard } from "../chat/dock/PlanDockCard";

/** The panel and composer dock share the stock plan state, file reader and review actions. */
export function PlanPanel() {
	return <PlanDockCard presentation="panel" />;
}
