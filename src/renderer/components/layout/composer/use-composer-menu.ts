/**
 * The composer's completion menu (`/` commands, `@` files, `:` emoji; derived by use-completion-menu.ts): its
 * state, a dismissal that sticks to its token, taking a row, the `@` menu's file listing and the argument hint.
 */
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import type { AvailableCommand } from "../../../../shared/rpc-types";
import { type SessionStore, useSessionStore } from "../../../stores/session";
import { sessionRuntimeStore } from "../../../stores/session-runtime-context";
import { cachedMentionFiles, listMentionFiles, mentionToken } from "./input-area-utils";
import { type CompletionItem, type CompletionMenu, sameCompletionMenu, useCompletionMenu } from "./use-completion-menu";

const MENTION_FS_DEBOUNCE_MS = 150;

export interface ComposerMenu {
	menu: CompletionMenu | null;
	setMenu: (menu: CompletionMenu | null) => void;
	/** Close the menu so the same token's menu stays closed until the draft changes. */
	dismiss: () => void;
	/** Take a row: its value replaces the token (when the caret is still at the token's end). */
	insert: (item: CompletionItem) => void;
	/** Contextual argument hint (TUI ghost-text parity), from stock for builtins; empty for none. */
	argHint: string;
	/** A trigger (`/`, `@`, `$`, `:`) is typed and found no row: the menu is closed, and the status says so. */
	empty: boolean;
}

export function useComposerMenu({
	text,
	textareaRef,
	placeDraft,
	commands,
	emojiAutocomplete,
	cwd,
	routeReady,
	runtimeTabId,
}: {
	text: string;
	textareaRef: RefObject<HTMLTextAreaElement | null>;
	placeDraft: (next: string, caret: number) => void;
	commands: AvailableCommand[];
	emojiAutocomplete: boolean;
	cwd: string;
	routeReady: boolean;
	runtimeTabId: string | null;
}): ComposerMenu {
	const [menu, setMenu] = useState<CompletionMenu | null>(null);
	const [filePaths, setFilePaths] = useState<string[]>([]);
	/**
	 * A menu the user closed (Esc, ←/→, a click): the same token's menu stays closed while the draft is
	 * unchanged, so moving the caret back into the token does not bring it back; any edit lifts it.
	 */
	const dismissedMenu = useRef<{ source: CompletionMenu["source"]; rangeStart: number; draft: string } | null>(null);
	/** The menu re-derives on every command refresh and caret event: an unchanged one keeps its highlight. */
	const [empty, setEmpty] = useState(false);
	const publishMenu = useCallback(
		(next: CompletionMenu | null, foundNothing = false) => {
			const dismissed = dismissedMenu.current;
			if (dismissed && textareaRef.current?.value !== dismissed.draft) dismissedMenu.current = null;
			const shown =
				dismissedMenu.current?.source === next?.source && dismissedMenu.current?.rangeStart === next?.rangeStart
					? null
					: next;
			setMenu(current => (current && shown && sameCompletionMenu(current, shown) ? current : shown));
			setEmpty(foundNothing && shown === null);
		},
		[textareaRef],
	);
	const dismiss = () => {
		if (menu)
			dismissedMenu.current = {
				source: menu.source,
				rangeStart: menu.rangeStart,
				draft: textareaRef.current?.value ?? text,
			};
		setMenu(null);
	};

	// Rendered as a dim row under the textarea — an inline-after-cursor ghost
	// needs pixel-aligned overlay metrics that break with auto-grow/IME (same
	// tradeoff as the queue highlight).
	const argHint = useCompletionMenu({
		text,
		filePaths,
		commands,
		emojiAutocomplete,
		textareaRef,
		setMenu: publishMenu,
	});

	// The `@` menu's files: the last listing of this cwd at once, and while an `@` token is typed a
	// fresh one (debounced, so a fleeting "@" walks nothing; listMentionFiles walks again only once
	// its listing is old, so files the agent created show up).
	useEffect(() => {
		setFilePaths(cachedMentionFiles(cwd) ?? []);
	}, [cwd]);
	useEffect(() => {
		if (!routeReady) return;
		const el = textareaRef.current;
		if (!mentionToken(text.slice(0, el?.selectionStart ?? text.length))) return;
		const key = cwd;
		const timer = setTimeout(() => {
			void listMentionFiles(key, runtimeTabId).then(paths => {
				const session = sessionRuntimeStore<SessionStore>(runtimeTabId, "session") ?? useSessionStore;
				if (session.getState().cwd === key) setFilePaths(paths);
			});
		}, MENTION_FS_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [text, cwd, routeReady, runtimeTabId, textareaRef]);

	const insert = useCallback(
		(item: CompletionItem) => {
			const el = textareaRef.current;
			if (!el || !menu) return;
			const pos = el.selectionStart ?? text.length;
			if (pos !== menu.rangeEnd) {
				setMenu(null);
				return;
			}
			const replaced = `${text.slice(0, menu.rangeStart)}${item.value}${text.slice(pos)}`;
			el.focus();
			placeDraft(replaced, menu.rangeStart + item.value.length);
			setMenu(null);
		},
		[text, menu, placeDraft, textareaRef],
	);

	return { menu, setMenu, dismiss, insert, argHint, empty };
}
