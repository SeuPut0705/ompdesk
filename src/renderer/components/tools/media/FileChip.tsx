import type { ReactNode } from "react";
import { basename } from "../../../lib/format";
import { useUiStore } from "../../../stores/ui";
import { LinkButton, Tooltip } from "../../common";
import { FileActions } from "./file-actions";
import { PathLink } from "./PathLink";

/**
 * A file the transcript names but does not draw: its icon and basename. The
 * name opens the file natively (falling back to revealing it; a remote tab's
 * file opens in the Files viewer) or, with `opensIn="viewer"`, in the Files
 * viewer; the whole path is the name's tooltip. `note` says, after the name,
 * why there is no preview (missing, too large); `actions` adds the file's own
 * buttons (file-actions.tsx) for one that is there.
 */
export function FileChip({
	path,
	label,
	icon,
	note,
	opensIn = "native",
	actions = false,
	...data
}: {
	path: string;
	label?: string;
	icon: ReactNode;
	note?: string;
	opensIn?: "native" | "viewer";
	actions?: boolean;
} & Record<`data-${string}`, string | boolean | undefined>) {
	const name = label || basename(path) || path;
	return (
		<span {...data} className="omp-file-chip">
			{icon}
			{opensIn === "viewer" ? (
				<Tooltip content={path}>
					<LinkButton
						className="omp-file-chip-name min-w-0 font-mono"
						onClick={event => {
							event.stopPropagation();
							useUiStore.getState().openFilePreview(path);
						}}
						tone="inherit"
					>
						{name}
					</LinkButton>
				</Tooltip>
			) : (
				<PathLink path={path} className="omp-file-chip-name font-mono">
					{name}
				</PathLink>
			)}
			{note ? <span className="omp-file-chip-note">{note}</span> : null}
			{actions ? <FileActions name={name} path={path} /> : null}
		</span>
	);
}
