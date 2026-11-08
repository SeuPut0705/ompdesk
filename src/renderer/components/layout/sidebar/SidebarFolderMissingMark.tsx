import { FolderX } from "lucide-react";
import { useT } from "../../../lib/i18n";

/**
 * "Folder missing" at a session row's end, before the age (this computer's rows and a paired device's section draw the
 * same mark, `SidebarRows.folderMissing`). Muted like the age; a glyph beside the words so it is not colour alone. The
 * row's tooltip names the folder.
 */
export function SidebarFolderMissingMark() {
	const t = useT();
	return (
		<span className="inline-flex shrink-0 items-center gap-1" data-folder-missing-mark>
			<FolderX aria-hidden className="size-(--sc-icon-sm)" />
			{t("sessionFolder.gone")}
		</span>
	);
}
