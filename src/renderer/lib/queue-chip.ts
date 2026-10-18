/**
 * Stock's `queueChipText` for a queued message that is only pictures: the English "[Image]" (main's
 * `src/main/local/queue.ts` knows the same string). It is a placeholder, not content: nothing to edit or re-queue,
 * and never something to show a Korean reader as is.
 */
import { translate } from "./i18n";

export const IMAGE_ONLY_CHIP = "[Image]";

/**
 * What a queued or held message shows as its text: its own text, or for a picture-only message the UI language's
 * word (with the count when the renderer knows more than one picture went with it).
 */
export function queueChipLabel(text: string, imageCount = 0): string {
	if (text !== IMAGE_ONLY_CHIP && text !== "") return text;
	if (imageCount > 1) return translate("composerQueue.imageOnlyMany", { count: imageCount });
	return translate("composerQueue.imageOnly");
}
