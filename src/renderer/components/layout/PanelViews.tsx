/**
 * The side panel's views, one per `PanelTab`, plus a subagent's transcript. A chunk of its own (about half a
 * megabyte of the eager bundle): PanelContainer loads it lazily, at once on the desktop and in an idle moment on a
 * paired web page, so a phone neither downloads nor parses the terminal, preview, changes and files views before its
 * first screen.
 */
import type { PanelSubagent, PanelView as PanelViewId } from "../../stores/ui";
import { DiffPanel } from "../panels/DiffPanel";
import { FilesPanel } from "../panels/FilesPanel";
import { PreviewPanel } from "../panels/PreviewPanel";
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
			{panelTab === "diff" && <DiffPanel />}
			{panelTab === "files" && <FilesPanel />}
			{panelTab === "subagent" && <SubagentPanel subagent={subagent} />}
		</>
	);
}
