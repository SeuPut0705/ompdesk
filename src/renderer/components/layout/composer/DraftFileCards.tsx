/**
 * Chips for the `@path` mentions in the composer draft (A22's picker, drop and
 * paste insert them; the user may type them too): stock reads each one at
 * send time, so the chip names what will go along (FileCard `compact`: a 28px
 * chip with the file's name, its type and size in the tooltip). A mention that
 * names no file gets no chip (stock skips it too). Removing a chip removes its
 * mentions from the draft. The draft is read 300 ms after the last keystroke,
 * so typing a path does not stat every prefix of it.
 */

import { useEffect, useMemo, useState } from "react";
import { extractFileMentions } from "../../../../shared/file-mentions";
import { useT } from "../../../lib/i18n";
import { Button } from "../../common";
import { FileCard } from "../../tools/media/FileCard";
import { useRovingStrip } from "./strip-roving";

const SETTLE_MS = 300;

export function DraftFileCards({
	text,
	onRemove,
	onRemoveAll,
	focusField,
}: {
	text: string;
	onRemove: (path: string) => void;
	/** Take every mention that has a chip out of the draft (offered from two chips on). */
	onRemoveAll: (paths: readonly string[]) => void;
	/** Focus goes back to the field once a chip is gone. */
	focusField: () => void;
}) {
	const t = useT();
	const [settled, setSettled] = useState(text);
	useEffect(() => {
		// An emptied draft (sent, cleared) drops its chips at once.
		if (!text.includes("@")) {
			setSettled(text);
			return;
		}
		const timer = setTimeout(() => setSettled(text), SETTLE_MS);
		return () => clearTimeout(timer);
	}, [text]);
	const paths = useMemo(() => extractFileMentions(settled), [settled]);
	// Which mentions name a file: only those have a chip (a mention of nothing is prose).
	const [present, setPresent] = useState<Readonly<Record<string, boolean>>>({});
	const shown = paths.filter(path => present[path]);
	const roving = useRovingStrip<HTMLDivElement>(focusField);
	if (paths.length === 0) return null;
	return (
		<div
			aria-label={t("input.fileCards")}
			className="omp-attach-row flex flex-wrap gap-1.5 px-3 pt-3 empty:hidden"
			data-draft-file-cards
			onFocus={roving.onFocus}
			onKeyDown={roving.onKeyDown}
			ref={roving.ref}
			role="group"
		>
			{paths.map(path => (
				<FileCard
					compact
					hideMissing
					key={path}
					onRemove={() => {
						onRemove(path);
						focusField();
					}}
					onResolved={exists =>
						setPresent(previous => (previous[path] === exists ? previous : { ...previous, [path]: exists }))
					}
					path={path}
				/>
			))}
			{shown.length > 1 && (
				<Button
					data-strip-stop=""
					onClick={() => {
						onRemoveAll(shown);
						focusField();
					}}
					size="sm"
					variant="ghost"
				>
					{t("input.attachments.removeAll")}
				</Button>
			)}
		</div>
	);
}
