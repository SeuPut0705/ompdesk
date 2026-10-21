/**
 * The session views that open as a sheet instead of living in the side panel: Background tasks, the plan document,
 * the Session tree, Logs and the Work tree. Each is the component the panel used to hold, unchanged, so its data and
 * scope are the panel's: ViewSheetHost renders it inside the runtime of the tab focused when it opened. A chunk of its
 * own, loaded on first open (the phone's first screen never needs it).
 */
import { useShellMode } from "../../hooks/use-shell-mode";
import { useT } from "../../lib/i18n";
import type { ViewSheetId } from "../../stores/ui";
import { PlanDockCard } from "../chat/dock/PlanDockCard";
import { PanelErrorBoundary, Sheet } from "../common";
import { JobsPanel } from "../panels/JobsPanel";
import { LogPanel } from "../panels/LogPanel";
import { SessionTreeSheet } from "../panels/SessionTreeSheet";
import { WorkTreePanel } from "../panels/work-tree/WorkTreePanel";

const TITLE: Record<Exclude<ViewSheetId, "tree">, string> = {
	jobs: "viewSheet.jobs",
	plan: "viewSheet.plan",
	logs: "viewSheet.logs",
	work: "viewSheet.work",
};

function SheetBody({ view }: { view: Exclude<ViewSheetId, "tree"> }) {
	switch (view) {
		case "jobs":
			return <JobsPanel />;
		case "plan":
			return <PlanDockCard presentation="sheet" />;
		case "logs":
			return <LogPanel />;
		case "work":
			return <WorkTreePanel />;
	}
}

export function ViewSheet({ view, open, onClose }: { view: ViewSheetId; open: boolean; onClose: () => void }) {
	const t = useT();
	const phone = useShellMode() === "phone";
	if (view === "tree") return <SessionTreeSheet onClose={onClose} open={open} />;
	return (
		<Sheet
			bodyClassName="flex min-h-0 flex-1 flex-col"
			onClose={onClose}
			open={open}
			placement={phone ? "full" : "right"}
			size="lg"
			title={t(TITLE[view])}
		>
			<div className="flex min-h-0 flex-1 flex-col" data-view-sheet={view}>
				<PanelErrorBoundary>
					<SheetBody view={view} />
				</PanelErrorBoundary>
			</div>
		</Sheet>
	);
}
