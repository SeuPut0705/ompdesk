/**
 * The dialogs only the person opens (a key, a menu, a button), in their own chunk rather than with the first screen:
 * each renders nothing until its store opens it and listens for nothing while closed, so App mounts them at once on
 * the desktop and on a paired web page once its first screen settled or at the first touch or key. Dialogs main or an
 * agent opens (asks, plan approval, worktree prompts, SSH prompts) stay in App.
 */
import { ActiveToolsDialog } from "./ActiveToolsDialog";
import { BranchPickerDialog } from "./BranchPickerDialog";
import { CommandPalette } from "./CommandPalette";
import { CopySelectorDialog } from "./CopySelectorDialog";
import { ForceToolDialog } from "./ForceToolDialog";
import { HandoffDialog } from "./HandoffDialog";
import { LiveVoiceDialog } from "./LiveVoiceDialog";
import { ModelPicker } from "./ModelPicker";
import { QuickOpenDialog } from "./QuickOpenDialog";
import { RenameSessionDialog } from "./RenameSessionDialog";
import { SessionPickerDialog } from "./SessionPickerDialog";
import { SessionSwitchDialog } from "./SessionSwitchDialog";
import { ShareSessionDialog } from "./ShareSessionDialog";
import { TabOverviewDialog } from "./TabOverviewDialog";
import { WorktreeCloseDialog } from "./WorktreeCloseDialog";
import { WorktreeDialog } from "./WorktreeDialog";

export function OnDemandDialogs() {
	return (
		<>
			<CommandPalette />
			<ModelPicker />
			<RenameSessionDialog />
			<WorktreeDialog />
			<WorktreeCloseDialog />
			<SessionPickerDialog />
			<QuickOpenDialog />
			<TabOverviewDialog />
			<SessionSwitchDialog />
			<BranchPickerDialog />
			<LiveVoiceDialog />
			<CopySelectorDialog />
			<ActiveToolsDialog />
			<ShareSessionDialog />
			<ForceToolDialog />
			<HandoffDialog />
		</>
	);
}
