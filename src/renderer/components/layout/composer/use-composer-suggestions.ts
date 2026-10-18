/**
 * Prompt suggestions in the composer (hooks/use-next-prompt.ts, remembered per session in stores/next-prompt.ts):
 * the best candidate as the placeholder (mouse/keyboard) or as the first chip (touch), the runner-up chips, and
 * the legacy `next-prompt` widget feeding the memory while the built-in is off.
 */
import { useEffect, useMemo } from "react";
import { type NextPromptView, useNextPrompt } from "../../../hooks/use-next-prompt";
import { NEXT_PROMPT_WIDGET } from "../../../lib/next-prompt";
import { useExtensionUiStore } from "../../../stores/extension-ui";
import { useNextPromptStore } from "../../../stores/next-prompt";
import { MAX_NEXT_PROMPT_CHIPS } from "./NextPromptChips";

export interface ComposerSuggestions {
	view: NextPromptView;
	/** The session the suggestion memory is kept for. */
	key: string | undefined;
	/** The suggestion shown as the field's placeholder (never on touch). */
	placeholderPrompt: string | undefined;
	/** The chips under the composer: on touch the best candidate leads them. */
	chips: readonly string[];
}

export function useComposerSuggestions({
	isStreaming,
	sessionFile,
	sessionId,
	touchInput,
}: {
	isStreaming: boolean;
	sessionFile: string | null;
	sessionId: string | null;
	/** Touch (no Tab, →, ↓, Alt+N, Esc): the best candidate is the FIRST CHIP, never the placeholder, so one
	 * text is never shown twice; no inline ghost requests at all (the phone keyboard has its own suggestions
	 * and IME composition dominates). A tap on a chip fills the field, a long press offers "send now". */
	touchInput: boolean;
}): ComposerSuggestions {
	/** `next-prompt` extension suggestion: gray placeholder, Tab on an empty composer
	 * accepts it. Remembered per session (stores/next-prompt.ts) so a deleted draft or a
	 * session switch brings it back until a submit or a new run makes it stale. */
	const nextPromptLines = useExtensionUiStore(s => s.widgetPanels[NEXT_PROMPT_WIDGET]);
	const key = sessionFile || sessionId || undefined;
	const view = useNextPrompt();
	/** The built-in's best candidate (or, while it is off, the legacy widget's entry): already empty unless ready and idle. */
	const nextPrompt = view.best;
	const chips = useMemo(
		() =>
			touchInput
				? [...(nextPrompt === undefined ? [] : [nextPrompt]), ...view.chips].slice(0, MAX_NEXT_PROMPT_CHIPS)
				: view.chips,
		[touchInput, nextPrompt, view.chips],
	);
	// The legacy widget feeds the memory only while the built-in is off: with it on, a recorded
	// widget would overwrite the built-in's entry.
	useEffect(() => {
		if (key && !view.builtin) useNextPromptStore.getState().recordWidget(key, nextPromptLines);
	}, [key, nextPromptLines, view.builtin]);
	useEffect(() => {
		if (isStreaming) useNextPromptStore.getState().clear(key);
	}, [isStreaming, key]);
	return { view, key, placeholderPrompt: touchInput ? undefined : nextPrompt, chips };
}
