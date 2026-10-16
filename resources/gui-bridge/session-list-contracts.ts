/**
 * What the bridge's session listing sends where a session has conversation but no prompt text (an image- or
 * file-only first message). A sentinel, never a display string: the renderer maps it to its localized label
 * (`session.noTextPrompt`). Dependency-free: the bridge and the renderer both import it.
 */
export const NO_TEXT_PROMPT = "\u0000no-text-prompt";
