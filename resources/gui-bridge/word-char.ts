/**
 * The one spelling of "a letter or a digit in any script": a text with none of them says nothing (a reply of only
 * punctuation or markup, a title cut down to symbols). Shared by the bridge (`answer-first.ts`,
 * `modes/auto-title-core.ts`) and the renderer's repeated-answer rule (`repeated-answer.ts`); no `g` flag, so `test`
 * keeps no state between calls.
 */
export const WORD_CHAR = /[\p{L}\p{N}]/u;
