/**
 * The quiet rows between the field and the toolbar that never cover the draft: the dictation bar (or the error a take
 * ended in) and, on a tab another device shows too, one line saying so.
 */
import { useT } from "../../../lib/i18n";
import { useRuntimeTabId } from "../../../stores/session-runtime-context";
import { useTabsStore } from "../../../stores/tabs";
import { DictationFailureNotice, DictationOverlay } from "./DictationOverlay";
import type { ComposerDictation } from "./use-composer-dictation";

export function ComposerUnderField({
	dictation,
}: {
	dictation: Pick<ComposerDictation, "phase" | "levels" | "startedAt" | "failure" | "dismissFailure">;
}) {
	return (
		<>
			{dictation.phase !== "idle" ? (
				<DictationOverlay levels={dictation.levels} phase={dictation.phase} startedAt={dictation.startedAt} />
			) : (
				dictation.failure && (
					<DictationFailureNotice failure={dictation.failure} onDismiss={dictation.dismissFailure} />
				)
			)}
			<SharedLine />
		</>
	);
}

/** "Shared with N other devices" while other windows or paired devices show this tab (owner and viewers alike). */
function SharedLine() {
	const t = useT();
	const tabId = useRuntimeTabId();
	const count = useTabsStore(state => state.tabs.find(tab => tab.id === tabId)?.viewerCount ?? 0);
	const viewer = useTabsStore(state => state.tabs.find(tab => tab.id === tabId)?.shared === true);
	if (count <= 0 && !viewer) return null;
	return (
		<div
			className="truncate px-4 pb-1 text-sc-xs text-(--sc-text-muted)"
			data-composer-shared={count > 0 ? count : "viewer"}
			role="status"
		>
			{count <= 0
				? t("viewers.composerViewer")
				: t(count === 1 ? "viewers.composerOne" : "viewers.composerMany", { count })}
		</div>
	);
}
