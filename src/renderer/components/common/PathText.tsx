/**
 * PathText — one line of a file path or URL that never wraps: when the line is too narrow the MIDDLE gives way
 * ("/var/folders/…/fake omp/omp"), because the tail (the file or folder name) is what a person needs. The full text
 * is the tooltip and stays selectable. The head shrinks with an ellipsis and the last `tail` characters (the
 * file name, at least) never shrink. Mono, muted, `min-w-0`: give it a flexible parent.
 */

import { cx } from "../../lib/format";

export interface PathTextProps {
	path: string;
	/** Characters kept at the end however narrow the line gets (default 24, at least the whole last segment). */
	tail?: number;
	className?: string;
}

export function PathText({ path, tail = 24, className }: PathTextProps) {
	const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	// Keep the last segment whole, and at least `tail` characters, so a short name is not cut from its folder.
	const cut = Math.min(Math.max(path.length - tail, 0), lastSlash >= 0 ? lastSlash : path.length);
	const head = path.slice(0, cut);
	const end = path.slice(cut);
	return (
		<span
			className={cx("flex min-w-0 font-mono whitespace-nowrap text-(--sc-text-muted) select-text", className)}
			data-path-text
			title={path}
		>
			{head && <span className="min-w-0 truncate">{head}</span>}
			<span className="shrink-0">{end}</span>
		</span>
	);
}
