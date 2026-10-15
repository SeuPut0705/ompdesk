/**
 * Cards for the `@path` mentions in the composer draft (A22's picker, drop and
 * paste insert them; the user may type them too): stock reads each one at
 * send time, so the card shows what will go along — type, pages/rows/lines,
 * size and a preview (FileCard). A mention that names no file gets no card
 * (stock skips it too). Removing a card removes its mentions from the draft.
 * The draft is read 300 ms after the last keystroke, so typing a path does not
 * stat every prefix of it.
 */

import { useEffect, useMemo, useState } from "react";
import { extractFileMentions } from "../../../shared/file-mentions";
import { useT } from "../../lib/i18n";
import { FileCard } from "../tools/FileCard";

const SETTLE_MS = 300;

export function DraftFileCards({ text, onRemove }: { text: string; onRemove: (path: string) => void }) {
	const t = useT();
	const [settled, setSettled] = useState(text);
	useEffect(() => {
		// An emptied draft (sent, cleared) drops its cards at once.
		if (!text.includes("@")) {
			setSettled(text);
			return;
		}
		const timer = setTimeout(() => setSettled(text), SETTLE_MS);
		return () => clearTimeout(timer);
	}, [text]);
	const paths = useMemo(() => extractFileMentions(settled), [settled]);
	if (paths.length === 0) return null;
	return (
		<div
			aria-label={t("input.fileCards")}
			className="flex gap-2 overflow-x-auto px-3 pt-3 empty:hidden"
			data-draft-file-cards
			role="group"
		>
			{paths.map(path => (
				<FileCard hideMissing key={path} onRemove={() => onRemove(path)} path={path} />
			))}
		</div>
	);
}
