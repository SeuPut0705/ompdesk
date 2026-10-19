/** The quiet row between the field and the toolbar that never covers the draft: the dictation bar, or the error a take ended in. */
import { DictationFailureNotice, DictationOverlay } from "./DictationOverlay";
import type { ComposerDictation } from "./use-composer-dictation";

export function ComposerUnderField({
	dictation,
}: {
	dictation: Pick<ComposerDictation, "phase" | "levels" | "startedAt" | "failure" | "dismissFailure">;
}) {
	return dictation.phase !== "idle" ? (
		<DictationOverlay levels={dictation.levels} phase={dictation.phase} startedAt={dictation.startedAt} />
	) : (
		dictation.failure && <DictationFailureNotice failure={dictation.failure} onDismiss={dictation.dismissFailure} />
	);
}
