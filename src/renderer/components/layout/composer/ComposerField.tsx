/**
 * The composer's text field and what is drawn on it: the inline ghost continuation, the dictation overlay and the
 * Tab/→ hint of a suggestion shown as the placeholder; below it, the one-line hint row (Esc again, the command's
 * argument hint, or why suggestions are unavailable). Typing writes the draft store; the composer's own writes
 * (use-composer-field.ts `placeDraft`) are only mirrored.
 */
import type { ClipboardEvent, KeyboardEvent, RefObject } from "react";
import { useId } from "react";
import type { InlineCompletion } from "../../../hooks/use-inline-completion";
import type { NextPromptView } from "../../../hooks/use-next-prompt";
import { tryEmojiInlineReplace } from "../../../lib/emoji";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { useInputHistoryStore } from "../../../stores/input-history";
import { Kbd } from "../../common";
import { DictationOverlay } from "./DictationOverlay";
import type { ComposerDictation } from "./use-composer-dictation";

export function ComposerField({
	textareaRef,
	ownEdit,
	text,
	setText,
	placeDraft,
	emojiAutocomplete,
	listboxId,
	activeOption,
	onFieldClick,
	inline,
	onKeyDown,
	onPaste,
	placeholder,
	suggestionHint,
	expanded,
	monospace,
	dictation,
	enterKeyHint,
}: {
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	/** True while the composer writes its own draft into the field. */
	ownEdit: RefObject<boolean>;
	text: string;
	setText: (next: string) => void;
	placeDraft: (next: string, caret: number) => void;
	emojiAutocomplete: boolean;
	/** The completion listbox's id and its highlighted row, while it is open. */
	listboxId: string;
	activeOption: number | undefined;
	/** A click in the field (the caret moved): the completion menu closes. */
	onFieldClick: () => void;
	inline: InlineCompletion;
	onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
	onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
	placeholder: string;
	/** The placeholder is a suggestion Tab / → take: their hint shows at the field's end. */
	suggestionHint: boolean;
	expanded: boolean;
	/** A `!` / `$` draft: the field types in monospace. */
	monospace: boolean;
	dictation: Pick<ComposerDictation, "phase" | "levels" | "startedAt">;
	/** The return key's label on a soft keyboard: "enter" where Enter adds a line, undefined where it sends. */
	enterKeyHint?: "enter";
}) {
	const t = useT();
	const suggestionHintId = useId();
	const menuOpen = activeOption !== undefined;
	return (
		<div className={cx("relative px-4 pt-3 pb-1", expanded && "flex min-h-0 flex-1 flex-col")}>
			<textarea
				ref={textareaRef}
				data-composer-input
				aria-activedescendant={menuOpen ? `${listboxId}-${activeOption}` : undefined}
				aria-autocomplete={menuOpen ? "list" : undefined}
				aria-controls={menuOpen ? listboxId : undefined}
				aria-describedby={suggestionHint ? suggestionHintId : undefined}
				aria-label={t("input.ariaLabel")}
				autoCapitalize={monospace ? "off" : "sentences"}
				autoCorrect={monospace ? "off" : "on"}
				spellCheck={!monospace}
				enterKeyHint={enterKeyHint}
				value={text}
				onChange={event => {
					const value = event.target.value;
					// The composer's own write (placeDraft): only mirror it.
					if (ownEdit.current) {
						setText(value);
						return;
					}
					useInputHistoryStore.getState().resetNav();
					setText(value);
					// TUI parity (custom-editor.ts:1001-1007): the moment typing makes the buffer
					// exactly the queue prefix, a newline starts the list body. Only typing does:
					// Backspace or an undo back to `->` must leave it, or the prefix never goes.
					const inputType = (event.nativeEvent as InputEvent | undefined)?.inputType ?? "";
					if (
						(value === "->" || value === "=>") &&
						value.length > text.length &&
						!inputType.startsWith("history")
					) {
						// After this input event: the newline is the composer's own edit, its own undo step.
						queueMicrotask(() => {
							if (textareaRef.current?.value === value) placeDraft(`${value}\n`, value.length + 1);
						});
						return;
					}
					// Emoji inline replace (TUI parity): `:name:` fires on the closing
					// colon, emoticons fire on a trailing space/tab/newline.
					if (emojiAutocomplete) {
						const caret = event.target.selectionStart ?? value.length;
						const before = value.slice(0, caret);
						void tryEmojiInlineReplace(before).then(hit => {
							if (!hit) return;
							const el = textareaRef.current;
							if (!el) return;
							// Stale-check: the user typed on meanwhile.
							const currentBefore = el.value.slice(0, el.selectionStart ?? el.value.length);
							if (currentBefore !== before) return;
							const nextText =
								before.slice(0, before.length - hit.replaceLen) + hit.insert + el.value.slice(before.length);
							placeDraft(nextText, before.length - hit.replaceLen + hit.insert.length);
						});
					}
				}}
				onKeyDown={onKeyDown}
				onClick={() => {
					onFieldClick();
					inline.syncCaret();
				}}
				onFocus={inline.onFocus}
				onBlur={inline.onBlur}
				onCompositionStart={inline.onCompositionStart}
				onCompositionEnd={inline.onCompositionEnd}
				onKeyUp={inline.syncCaret}
				onSelect={inline.syncCaret}
				onPaste={onPaste}
				rows={expanded ? undefined : 2}
				placeholder={placeholder}
				className={cx(
					"omp-composer-input w-full resize-none bg-transparent text-sc-lg break-keep text-(--sc-text) outline-none placeholder:text-(--sc-text-subtle) focus-visible:outline-none",
					expanded ? "min-h-0 flex-1" : "max-h-[40vh] min-h-6",
					monospace && "font-mono",
					suggestionHint && "pr-24",
				)}
			/>
			{inline.ghost !== null && (
				<div aria-hidden className="omp-inline-ghost text-sc-lg break-keep" data-inline-ghost>
					<span>{text}</span>
					<span className="omp-inline-ghost-text">{inline.ghost}</span>
					<Kbd shortcut="Tab" />
				</div>
			)}
			{dictation.phase !== "idle" && (
				<DictationOverlay levels={dictation.levels} phase={dictation.phase} startedAt={dictation.startedAt} />
			)}
			{suggestionHint && (
				<span
					className="pointer-events-none absolute top-3 right-4 flex h-6 items-center gap-1.5 text-sc-xs text-(--sc-text-subtle)"
					id={suggestionHintId}
				>
					<Kbd shortcut="Tab" />
					<Kbd shortcut="→" />
					{t("input.suggestion.accept")}
				</span>
			)}
		</div>
	);
}

/**
 * The one-line hint under the field, first match wins: "Esc again to clear", "Esc again to stop the turn" (the first Esc of
 * a stop with a draft), "Deciding how to run this…" (the automatic mode choice), the command's argument hint, why
 * suggestions are off.
 */
export function ComposerFieldHint({
	escHint,
	stopArmed,
	deciding,
	argHint,
	unavailable,
}: {
	escHint: boolean;
	/** The first Esc of "Esc again to stop" waits for its second (`composer.stopArmedAt`). */
	stopArmed: boolean;
	/** The automatic mode choice runs for the prompt just sent (`composer.decidingMode`). */
	deciding: boolean;
	/** Shown only while no completion menu is open (empty: none). */
	argHint: string;
	/** Prompt suggestions are on but cannot run (only while the session is ready). */
	unavailable: NextPromptView["unavailable"];
}) {
	const t = useT();
	if (escHint)
		return (
			<div className="truncate px-4 pb-1 text-sc-xs text-(--sc-text-muted)" data-esc-hint role="status">
				{t("input.escAgainToClear")}
			</div>
		);
	if (stopArmed)
		return (
			<div className="truncate px-4 pb-1 text-sc-xs text-(--sc-text-muted)" data-stop-hint role="status">
				{t("input.escAgainToStop")}
			</div>
		);
	if (deciding)
		return (
			<div className="truncate px-4 pb-1 text-sc-xs text-(--sc-text-muted)" data-deciding-hint role="status">
				{t("input.deciding")}
			</div>
		);
	if (argHint) return <div className="truncate px-4 pb-1 font-mono text-sc-xs text-(--sc-text-muted)">{argHint}</div>;
	if (!unavailable) return null;
	return (
		<div
			className="truncate px-4 pb-1 text-sc-xs text-(--sc-text-muted)"
			data-next-prompt-unavailable
			role="status"
			title={unavailable.detail}
		>
			{t(`input.suggestion.unavailable.${unavailable.reason}`)}
		</div>
	);
}
