/**
 * The side panel's views, one per `PanelTab`. A chunk of its own (about half a megabyte of the eager bundle):
 * PanelContainer loads it lazily, at once on the desktop and in an idle moment on a paired web page, so a phone
 * neither downloads nor parses the terminal, preview, changes and files views before its first screen.
 */
import type { PanelSubagent, PanelView as PanelViewId } from "../../stores/ui";
import { AiMemoryPanel } from "../panels/AiMemoryPanel";
import { AutopilotPanel } from "../panels/autopilot/AutopilotPanel";
import { DiffPanel } from "../panels/DiffPanel";
import { FilesPanel } from "../panels/FilesPanel";
import { JobsPanel } from "../panels/JobsPanel";
import { LogPanel } from "../panels/LogPanel";
import { PlanPanel } from "../panels/PlanPanel";
import { PreviewPanel } from "../panels/PreviewPanel";
import { QueuePanel } from "../panels/QueuePanel";
import { SessionTreePanel } from "../panels/SessionTreePanel";
import { SubagentPanel } from "../panels/SubagentPanel";
import { TerminalPanel } from "../panels/TerminalPanel";

export interface PanelViewProps {
	panelTab: PanelViewId;
	subagent: PanelSubagent | null;
}

export function PanelView({ panelTab, subagent }: PanelViewProps) {
	return (
		<>
			{panelTab === "terminal" && <TerminalPanel />}
			{panelTab === "preview" && <PreviewPanel />}
			{panelTab === "plan" && <PlanPanel />}
			{panelTab === "diff" && <DiffPanel />}
			{panelTab === "files" && <FilesPanel />}
			{panelTab === "logs" && <LogPanel />}
			{panelTab === "queue" && <QueuePanel />}
			{panelTab === "tree" && <SessionTreePanel />}
			{panelTab === "memory" && <AiMemoryPanel />}
			{panelTab === "jobs" && <JobsPanel />}
			{panelTab === "subagent" && <SubagentPanel subagent={subagent} />}
			{panelTab === "autopilot" && <AutopilotPanel />}
		</>
	);
}
