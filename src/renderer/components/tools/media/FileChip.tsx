import type { ReactNode } from "react";
import { basename } from "../../../lib/format";
import { useUiStore } from "../../../stores/ui";
import { FileActions } from "./file-actions";
import { PathLink } from "./PathLink";

/**
 * A file the transcript names but does not draw: its icon and basename. The
 * name opens the file natively (falling back to revealing it; a remote tab's
 * file opens in the Files viewer) or, with `opensIn="viewer"`, in the Files
 * viewer. `note` says why there is no preview (missing, too large); `actions`
 * adds the file's own buttons (file-actions.tsx) for one that is there.
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
	const content = (
		<>
			{note ? <span className="sr-only">{note}: </span> : null}
			{name}
		</>
	);
	return (
		<span {...data} className="omp-file-chip" title={[note, path].filter(Boolean).join(" · ") || undefined}>
			{icon}
			{opensIn === "viewer" ? (
				// controls-ok: the omp-file-chip-name class draws the whole control
				<button
					type="button"
					className="omp-file-chip-name font-mono"
					title={path}
					onClick={event => {
						event.stopPropagation();
						useUiStore.getState().openFilePreview(path);
					}}
				>
					{content}
				</button>
			) : (
				<PathLink path={path} className="omp-file-chip-name font-mono">
					{content}
				</PathLink>
			)}
			{actions ? <FileActions name={name} path={path} /> : null}
		</span>
	);
}
