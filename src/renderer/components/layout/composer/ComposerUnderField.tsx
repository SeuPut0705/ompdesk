/** The quiet row between the field and the toolbar that never covers the draft: the dictation bar, or the error a take ended in. */
import { useRef } from "react";
import { Collapse } from "../../common/Collapse";
import { DictationFailureNotice, DictationOverlay } from "./DictationOverlay";
import type { ComposerDictation } from "./use-composer-dictation";

export function ComposerUnderField({
	dictation,
}: {
	dictation: Pick<ComposerDictation, "phase" | "levels" | "startedAt" | "failure" | "dismissFailure">;
}) {
	const bar =
		dictation.phase !== "idle"
			? { phase: dictation.phase, levels: dictation.levels, startedAt: dictation.startedAt }
			: null;
	// The bar folds away with its last content (`Collapse` keeps it mounted for that).
	const held = useRef(bar);
	if (bar) held.current = bar;
	return (
		<>
			<Collapse open={bar !== null}>
				{held.current && (
					<DictationOverlay
						levels={held.current.levels}
						phase={held.current.phase}
						startedAt={held.current.startedAt}
					/>
				)}
			</Collapse>
			{bar === null && dictation.failure && (
				<DictationFailureNotice failure={dictation.failure} onDismiss={dictation.dismissFailure} />
			)}
		</>
	);
}
