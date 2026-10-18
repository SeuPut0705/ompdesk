import { ExternalLink, Minimize2, Paperclip } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useInlineCompletion } from "../../../hooks/use-inline-completion";
import { useNextPrompt } from "../../../hooks/use-next-prompt";
import { useShellInput } from "../../../hooks/use-shell-mode";
import { useDisplayPreference } from "../../../lib/display-preferences";
import { tryEmojiInlineReplace } from "../../../lib/emoji";
import { cx } from "../../../lib/format";
import { useT } from "../../../lib/i18n";
import { parseComposerMode } from "../../../lib/input-modes";
import { formatShortcut } from "../../../lib/keymap";
import { abortActiveTurn } from "../../../lib/messages";
import { NEXT_PROMPT_WIDGET } from "../../../lib/next-prompt";
import { dropReferencedPastes, expandPasteMarkers } from "../../../lib/paste-blobs";
import { parseQueueShorthand, splitQueuedMessages } from "../../../lib/queue-input";
import { useTabRpc } from "../../../lib/tab-rpc";
import { type ComposerStore, useComposerStore } from "../../../stores/composer";
import { useExtensionUiStore } from "../../../stores/extension-ui";
import { useFirstRunStore } from "../../../stores/first-run";
import { useInputHistoryStore } from "../../../stores/input-history";
import { useMessagesStore } from "../../../stores/messages";
import { useNextPromptStore } from "../../../stores/next-prompt";
import { useSessionStore } from "../../../stores/session";
import { sessionRuntimeStore, useRuntimeTabId } from "../../../stores/session-runtime-context";
import { useActiveTabKind, useTabsStore } from "../../../stores/tabs";
import { toast, toastError } from "../../../stores/toast";
import { useUiStore } from "../../../stores/ui";
import { Banner, Button, IconButton, Kbd } from "../../common";
import { AskDockSlot, BelowEditorDockSlot } from "../../dialogs/ask-dock";
import { CompletionList } from "./CompletionList";
import { ComposerAttachments } from "./ComposerAttachments";
import { ComposerLiveEdge } from "./ComposerLive";
import { ComposerQueue } from "./ComposerQueue";
import { ComposerToolbar } from "./ComposerToolbar";
import { DictationOverlay } from "./DictationOverlay";
import { HistorySearchOverlay } from "./HistorySearchOverlay";
import { MAX_NEXT_PROMPT_CHIPS, NextPromptChips, type NextPromptChipsHandle } from "./NextPromptChips";
import { PasteMenu } from "./PasteMenu";
import { SkillPickerOverlay } from "./SkillPickerOverlay";
import { useComposerAttach } from "./use-composer-attach";
import { useComposerCommands } from "./use-composer-commands";
import { useComposerDictation } from "./use-composer-dictation";
import { useComposerDraft } from "./use-composer-draft";
import { useComposerEvents } from "./use-composer-events";
import { useComposerField } from "./use-composer-field";
import { useComposerHistory } from "./use-composer-history";
import { useComposerKeys } from "./use-composer-keys";
import { useComposerMenu } from "./use-composer-menu";
import { useComposerPaste } from "./use-composer-paste";
import { useComposerSubmit } from "./use-composer-submit";
import { useStableCallback } from "./use-stable-callback";

type SendMode = "prompt" | "steer" | "followUp";

/**
 * Composer: auto-growing textarea, Enter to send / Shift+Enter for newline,
 * image paste, @file mentions, /command completion, steering-mode selector,
 * and an abort button while the agent streams.
 */
export function InputArea() {
	const isStreaming = useSessionStore(s => s.isStreaming);
	const t = useT();
	const rpc = useTabRpc();
	const contextTabId = useRuntimeTabId();
	const activeTabId = useTabsStore(state => state.activeTabId);
	const runtimeTabId = contextTabId ?? activeTabId;
	const historyDevice = useTabsStore(state => state.tabs.find(tab => tab.id === runtimeTabId)?.device);
	const routeReady = runtimeTabId !== null;
	/** A chat tab only differs in wording: it has no project to work in. */
	const isChat = useActiveTabKind() === "chat";
	const status = useSessionStore(s => s.status);
	const sessionId = useSessionStore(s => s.sessionId);
	const queuedMessageCount = useSessionStore(s => s.queuedMessageCount);
	const cwd = useSessionStore(s => s.cwd);
	const settingUp = useFirstRunStore(s => s.phase !== "idle");
	const openSettings = useUiStore(s => s.openSettings);
	/** Agent `emojiAutocomplete` setting: emoji popup/inline/submit expansion. */
	const emojiAutocomplete = useDisplayPreference("emojiAutocomplete");
	/** `next-prompt` extension suggestion: gray placeholder, Tab on an empty composer
	 * accepts it. Remembered per session (stores/next-prompt.ts) so a deleted draft or a
	 * session switch brings it back until a submit or a new run makes it stale. */
	const nextPromptLines = useExtensionUiStore(s => s.widgetPanels[NEXT_PROMPT_WIDGET]);
	const sessionFile = useSessionStore(s => s.sessionFile);
	const nextPromptKey = sessionFile || sessionId || undefined;
	const nextPromptView = useNextPrompt();
	/** The built-in's best candidate (or, while it is off, the legacy widget's entry): already empty unless ready and idle. */
	const nextPrompt = nextPromptView.best;
	/** Touch (no Tab, →, ↓, Alt+N, Esc): the best candidate is the FIRST CHIP, never the placeholder, so one
	 * text is never shown twice; no inline ghost requests at all (the phone keyboard has its own suggestions
	 * and IME composition dominates). A tap on a chip fills the field, a long press offers "send now". */
	const touchInput = useShellInput() === "touch";
	const placeholderPrompt = touchInput ? undefined : nextPrompt;
	const chipList = useMemo(
		() =>
			touchInput
				? [...(nextPrompt === undefined ? [] : [nextPrompt]), ...nextPromptView.chips].slice(
						0,
						MAX_NEXT_PROMPT_CHIPS,
					)
				: nextPromptView.chips,
		[touchInput, nextPrompt, nextPromptView.chips],
	);
	// The legacy widget feeds the memory only while the built-in is off: with it on, a recorded
	// widget would overwrite the built-in's entry.
	useEffect(() => {
		if (nextPromptKey && !nextPromptView.builtin)
			useNextPromptStore.getState().recordWidget(nextPromptKey, nextPromptLines);
	}, [nextPromptKey, nextPromptLines, nextPromptView.builtin]);
	useEffect(() => {
		if (isStreaming) useNextPromptStore.getState().clear(nextPromptKey);
	}, [isStreaming, nextPromptKey]);

	// Draft lives in the composer store (not local state) so session-tab
	// switches snapshot/restore it per tab. Value + updater-form setter are
	// drop-in for the old useState pair.
	const text = useComposerStore(s => s.draft);
	const setText = useComposerStore(s => s.setDraft);
	const images = useComposerStore(s => s.images);
	const setImages = useComposerStore(s => s.setImages);
	const [mode, setMode] = useState<SendMode>("prompt");
	// The chip says how messages join the run on screen: a Follow-up picked there lasts until that run
	// ends, and the next run starts as Steer again (the chip is hidden between runs, so a choice that
	// carried over sent every later message to the follow-up lane unseen).
	useEffect(() => {
		if (!isStreaming) setMode("prompt");
	}, [isStreaming]);
	/** ⌃G: the composer expands in place to fill the session pane (design-spec §2.2). */
	const [expanded, setExpanded] = useState(false);
	const { textareaRef, ownEdit, placeDraft, continueListAtCaret, insertAtCaret, fieldNarrow } = useComposerField({
		text,
		setText,
		expanded,
	});
	const commands = useComposerCommands({ rpc, status, sessionId, runtimeTabId });
	const {
		menu,
		setMenu,
		dismiss: dismissMenu,
		insert: insertCompletion,
		argHint,
	} = useComposerMenu({ text, textareaRef, placeDraft, commands, emojiAutocomplete, cwd, routeReady, runtimeTabId });
	const sending = useComposerStore(state => state.sending);
	const setSending = useComposerStore(state => state.setSending);
	const submissionUncertain = useComposerStore(state => state.submissionUncertain);
	const setSubmissionUncertain = useComposerStore(state => state.setSubmissionUncertain);
	/** A prompt waits on the automatic mode choice: Stop and Esc withdraw it (lib/messages.ts abortActiveTurn). */
	const submitPending = useComposerStore(state => state.cancelSubmit !== null);
	/** A manual /compact or handoff runs: Esc is its cancel (the status row says so), not the draft's double Esc. */
	const manualMaintenance = useSessionStore(s => s.compactionInfo?.reason === "manual");
	/** Something Stop and Esc can end: the run, or a prompt not yet sent. */
	const stoppable = isStreaming || submitPending;
	const [historySearchOpen, setHistorySearchOpen] = useState(false);
	const [skillPickerOpen, setSkillPickerOpen] = useState(false);
	const [externalBusy, setExternalBusy] = useState(false);
	const isEmptySession = useMessagesStore(s => s.messages.length === 0);
	const focusedPane = contextTabId === null || contextTabId === activeTabId;

	// The unsent draft outlives a reload and a relaunch (draft-persistence.ts): the session's saved
	// text comes back into an empty field once the session is known, and every change is saved.
	useComposerDraft({
		text,
		runtimeTabId,
		device: historyDevice,
		sessionFile,
		sessionId,
		cwd,
		empty: isEmptySession,
	});

	const mountedRef = useRef(true);
	const { fileInputRef, onFilesPicked, openFilePicker, attachFiles, sendingFiles, dragActive, dropProps } =
		useComposerAttach({ cwd, historyDevice, runtimeTabId, mountedRef, insertAtCaret, setImages });
	const paste = useComposerPaste({ text, textareaRef, placeDraft, attachFiles, runtimeTabId });
	const pasteMenu = paste.pending;
	const chipsRef = useRef<NextPromptChipsHandle>(null);
	/** Runner-up suggestions: only over an empty, idle composer with nothing else open. */
	const chipsShown = chipList.length > 0 && text === "" && status === "ready" && !isStreaming && !menu && !pasteMenu;
	const pickChip = useCallback(
		(chip: string) => {
			textareaRef.current?.focus();
			placeDraft(chip, chip.length);
			nextPromptView.accepted();
		},
		[placeDraft, nextPromptView, textareaRef],
	);
	/** Ghost text after the caret while the user types (slash / `@` menus, IME, `!` `$` `/` drafts: never). */
	const inline = useInlineCompletion({
		enabled: nextPromptView.inline && !touchInput && status === "ready" && !isStreaming && routeReady,
		text,
		menuOpen: menu !== null || pasteMenu !== null,
		textareaRef,
		complete: nextPromptView.completeInline,
	});
	// New and empty sessions start with the caret in the composer, unless
	// something else (a dialog, another field) already holds focus. The end of
	// first-run setup counts as a new start: its button unmounted with focus on it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: setup ending re-runs the check
	useEffect(() => {
		if (!routeReady || !focusedPane || !isEmptySession || !sessionId) return;
		const active = document.activeElement;
		if (active && active !== document.body) return;
		textareaRef.current?.focus();
	}, [routeReady, focusedPane, isEmptySession, sessionId, settingUp]);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	const history = useComposerHistory({
		rpc,
		ready: status === "ready",
		cwd,
		owner: `${runtimeTabId}:${sessionId}`,
		device: historyDevice,
		images,
		setImages,
		placeDraft,
	});

	// `!` → bash / `$` → python composer mode (TUI parity): drives the toolbar
	// badge and reroutes sending. Detected from the prefix alone so the badge
	// appears while the user is still typing.
	const composerMode = useMemo(() => parseComposerMode(text), [text]);

	// `->` / `=>` yield-queue shorthand (TUI queue-input.ts parity). The badge
	// preview and the send-path dispatch share this one parser so the "splits
	// into N" promise always matches what actually gets queued.
	const queueBody = useMemo(() => parseQueueShorthand(text), [text]);
	const queueSplitCount = useMemo(() => {
		if (queueBody === undefined || queueBody.length === 0) return 0;
		const items = splitQueuedMessages(queueBody);
		return items.length > 1 ? items.length : 0;
	}, [queueBody]);

	useComposerEvents({ runtimeTabId, textareaRef, setText, setImages, placeDraft });

	const dispatchSend = useComposerSubmit({
		text,
		images,
		sending,
		status,
		isStreaming,
		mode,
		queuedMessageCount,
		commands,
		emojiAutocomplete,
		routeReady,
		setText,
		setImages,
		setMenu,
		setSending,
	});
	/**
	 * Send the draft; true when it went out (the draft emptied), which also makes this session's
	 * suggestion stale. False when nothing left: empty, still sending or connecting, delivery unknown.
	 */
	const send = useCallback(
		(overrideText?: string, forceMode?: SendMode): boolean => {
			const composer = sessionRuntimeStore<ComposerStore>(runtimeTabId, "composer") ?? useComposerStore;
			const hadContent = (overrideText ?? composer.getState().draft).trim() !== "" || images.length > 0;
			dispatchSend(overrideText, forceMode);
			const after = composer.getState();
			const sent = hadContent && after.draft === "" && after.images.length === 0;
			if (sent) useNextPromptStore.getState().clear(nextPromptKey);
			return sent;
		},
		[dispatchSend, runtimeTabId, images.length, nextPromptKey],
	);
	/** Touch long press on a suggestion chip, "send now": the chip's text goes out as it is. */
	const sendChip = useCallback((chip: string) => void send(chip), [send]);
	/** The send of the latest render: a take transcribed later sends what the composer holds then (pictures, mode, run). */
	const sendRef = useRef(send);
	useEffect(() => {
		sendRef.current = send;
	}, [send]);

	const dictation = useComposerDictation({ textareaRef, placeDraft, sendRef, mountedRef });

	/**
	 * Expanded composer (TUI app.editor.external parity, GUI-native form): ⌃G
	 * or the + menu grows the composer in place to fill the session pane for
	 * long drafts — the same field, so completion, paste markers, IME and
	 * history keep working. Enter adds a line there; ⌘↵ sends; Esc collapses.
	 */
	const toggleExpanded = useCallback(
		(next?: boolean) => {
			setExpanded(current => next ?? !current);
			requestAnimationFrame(() => textareaRef.current?.focus());
		},
		[textareaRef],
	);

	/** Round-trip the draft (paste markers resolved) through the user's $VISUAL/$EDITOR. */
	const openExternalEditor = async () => {
		if (externalBusy) return;
		setExternalBusy(true);
		const draft = text;
		try {
			const response = await window.omp.editor.openExternal(expandPasteMarkers(draft));
			if (!mountedRef.current) return;
			if (!response.ok) {
				if (response.unavailable) toast({ variant: "info", message: t("editor.externalUnavailable") });
				else toastError({ title: t("editor.externalFailed"), error: response });
				return;
			}
			// null text = the editor exited non-zero; keep the draft as it was.
			if (response.text === null) return;
			// The written-back text is fully inline: consume the draft's paste blobs.
			dropReferencedPastes(draft);
			placeDraft(response.text, response.text.length);
		} finally {
			if (mountedRef.current) setExternalBusy(false);
		}
	};

	const keys = useComposerKeys({
		rpc,
		text,
		images,
		setImages,
		textareaRef,
		placeDraft,
		continueListAtCaret,
		paste,
		inline,
		chips: { shown: chipsShown, list: chipList, pick: pickChip, ref: chipsRef },
		placeholderPrompt,
		acceptSuggestion: nextPromptView.accepted,
		menu: { menu, setMenu, dismiss: dismissMenu, insert: insertCompletion },
		history,
		expanded,
		toggleExpanded,
		collapse: () => setExpanded(false),
		toggleHistorySearch: () => setHistorySearchOpen(open => !open),
		runActive: isStreaming || submitPending || manualMaintenance,
		send,
	});
	const sendDisabled =
		!routeReady || status !== "ready" || sending || submissionUncertain || (!text.trim() && images.length === 0);
	// The toolbar is memoised: its handlers keep their identity while the draft changes.
	const sendFromToolbar = useStableCallback(() => {
		// The expanded composer collapses only once the draft went out.
		if (send() && expanded) setExpanded(false);
		// The button disables itself once the draft clears; a disabled
		// focused control swallows keystrokes (⌘, and friends), so keep
		// typing focus in the composer like Enter does.
		textareaRef.current?.focus();
	});
	const stopFromToolbar = useStableCallback(() => {
		void abortActiveTurn(rpc, runtimeTabId);
		// The button leaves with the run: typing goes on in the field, never on <body>.
		textareaRef.current?.focus();
	});
	const toggleSendMode = useCallback(() => {
		setMode(current => (current === "followUp" ? "steer" : "followUp"));
		// The choice is for the message being typed: typing goes on in the field.
		textareaRef.current?.focus();
	}, [textareaRef]);
	const filesPicked = useStableCallback(onFilesPicked);
	const openHistorySearch = useCallback(() => setHistorySearchOpen(true), []);
	const openSkillPicker = useCallback(() => setSkillPickerOpen(true), []);
	const toggleExpandedFromMenu = useCallback(() => toggleExpanded(), [toggleExpanded]);
	const placeholder =
		status !== "ready"
			? t("input.placeholder.connecting")
			: placeholderPrompt !== undefined
				? placeholderPrompt
				: isStreaming
					? mode === "followUp"
						? t("input.placeholder.followUp")
						: t("input.placeholder.streaming")
					: isChat || fieldNarrow
						? t("input.placeholder.chat")
						: t("input.placeholder.idle");
	/** Tab-accept hint chip: only while the suggestion is the visible placeholder. */
	const showSuggestionHint = placeholderPrompt !== undefined && text === "";
	const suggestionHintId = useId();
	const menuId = useId();
	/** Streaming with nothing to send: Stop takes the send slot instead of a dead Send. */
	const showSend = !stoppable || text.trim() !== "" || images.length > 0;

	return (
		<div
			className={cx(
				"omp-composer-region relative shrink-0 bg-transparent pb-3",
				expanded && "omp-composer-region--expanded",
			)}
		>
			<div className="omp-composer-shell relative w-full">
				<AskDockSlot />
				{pasteMenu && (
					<PasteMenu
						menuRef={paste.menuRef}
						onCancel={() => {
							paste.cancel();
							textareaRef.current?.focus();
						}}
						onInline={paste.chooseInline}
						onSaveFile={paste.chooseSaveFile}
						onWrap={paste.chooseWrapped}
						paste={pasteMenu}
					/>
				)}
				<ComposerQueue onSettled={() => textareaRef.current?.focus()} />

				{/* Anchoring context for completion/history overlays: they sit directly
				    above the input box instead of the surrounding composer region. */}
				<div className="omp-composer-anchor relative">
					{menu && <CompletionList menu={menu} menuId={menuId} onPick={insertCompletion} />}

					{historySearchOpen && (
						<HistorySearchOverlay
							cwd={cwd}
							onSelect={prompt => {
								setHistorySearchOpen(false);
								textareaRef.current?.focus();
								// A pick replaces the draft the way ↑ does.
								history.pick(prompt, text);
							}}
							onClose={() => {
								setHistorySearchOpen(false);
								requestAnimationFrame(() => textareaRef.current?.focus());
							}}
						/>
					)}
					{skillPickerOpen && (
						<SkillPickerOverlay
							skills={commands
								.filter(command => command.name.startsWith("skill:"))
								.map(command => ({
									name: command.name.slice("skill:".length),
									description: command.description ?? "",
								}))
								.sort((a, b) => a.name.localeCompare(b.name))}
							onClose={() => {
								setSkillPickerOpen(false);
								requestAnimationFrame(() => textareaRef.current?.focus());
							}}
							onManage={() => {
								setSkillPickerOpen(false);
								openSettings("tools:skills");
							}}
							onSelect={name => {
								setSkillPickerOpen(false);
								textareaRef.current?.focus();
								insertAtCaret(`/skill:${name}`);
							}}
						/>
					)}
					{chipsShown && (
						<NextPromptChips
							chips={chipList}
							handleRef={chipsRef}
							onPick={pickChip}
							onSend={touchInput ? sendChip : undefined}
							touch={touchInput}
							onReturn={() => textareaRef.current?.focus()}
						/>
					)}
					{/* Focus and drag paint live in components.css (.omp-composer-box): the
					    field state follows the TEXT field, not any focused descendant, so a
					    focused toolbar control draws its own ring, never a ring in a ring. */}
					<div
						className="omp-composer-box relative flex flex-col rounded-(--sc-radius-xl) border border-(--sc-border-subtle) bg-(--sc-field) shadow-(--sc-shadow-sm) transition-[border-color,box-shadow] duration-(--sc-duration-fast)"
						data-composer-mode={composerMode?.mode}
						data-composer-draft={text !== "" || undefined}
						data-drag-active={dragActive || undefined}
						{...dropProps}
					>
						<ComposerLiveEdge />
						{dragActive && (
							<div aria-hidden className="omp-composer-drop omp-fade-in">
								<Paperclip aria-hidden className="size-(--sc-icon-md)" />
								{t("input.dropFiles")}
							</div>
						)}
						{expanded && (
							<div className="flex items-center gap-2 border-b border-(--sc-divider) py-1.5 pr-2 pl-4">
								<span className="min-w-0 flex-1 truncate text-sc-sm font-medium text-(--sc-text-secondary)">
									{t("editor.title")}
								</span>
								<span className="text-sc-xs text-(--sc-text-muted) max-sm:hidden">
									{t("input.expanded.hint", { send: formatShortcut("⌘↵") })}
								</span>
								<Button
									icon={<ExternalLink aria-hidden />}
									loading={externalBusy}
									onClick={() => void openExternalEditor()}
									size="sm"
									variant="ghost"
								>
									{externalBusy ? t("editor.externalBusy") : t("editor.external")}
								</Button>
								<IconButton
									icon={<Minimize2 />}
									label={t("input.expanded.collapse")}
									onClick={() => toggleExpanded(false)}
									shortcut="⌃G"
									size="sm"
								/>
							</div>
						)}
						{submissionUncertain && (
							<Banner
								actions={
									<Button onClick={() => setSubmissionUncertain(false)} size="sm">
										{t("input.allowResend")}
									</Button>
								}
								className="m-2 mb-0"
								live
								variant="warning"
							>
								{t("input.deliveryUnknown")}
							</Banner>
						)}
						<ComposerAttachments
							images={images}
							placeDraft={placeDraft}
							sendingFiles={sendingFiles}
							setImages={setImages}
							setText={setText}
							text={text}
							textareaRef={textareaRef}
						/>
						<div className={cx("relative px-4 pt-3 pb-1", expanded && "flex min-h-0 flex-1 flex-col")}>
							<textarea
								ref={textareaRef}
								data-composer-input
								aria-activedescendant={menu ? `${menuId}-${menu.index}` : undefined}
								aria-autocomplete={menu ? "list" : undefined}
								aria-controls={menu ? menuId : undefined}
								aria-describedby={showSuggestionHint ? suggestionHintId : undefined}
								aria-label={t("input.ariaLabel")}
								autoCapitalize="sentences"
								autoCorrect="on"
								spellCheck
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
												before.slice(0, before.length - hit.replaceLen) +
												hit.insert +
												el.value.slice(before.length);
											placeDraft(nextText, before.length - hit.replaceLen + hit.insert.length);
										});
									}
								}}
								onKeyDown={keys.onKeyDown}
								onClick={() => {
									setMenu(null);
									inline.syncCaret();
								}}
								onFocus={inline.onFocus}
								onBlur={inline.onBlur}
								onCompositionStart={inline.onCompositionStart}
								onCompositionEnd={inline.onCompositionEnd}
								onKeyUp={inline.syncCaret}
								onSelect={inline.syncCaret}
								onPaste={paste.onPaste}
								rows={expanded ? undefined : 2}
								placeholder={placeholder}
								className={cx(
									"omp-composer-input w-full resize-none bg-transparent text-sc-lg break-keep text-(--sc-text) outline-none placeholder:text-(--sc-text-subtle) focus-visible:outline-none",
									expanded ? "min-h-0 flex-1" : "max-h-[40vh] min-h-6",
									composerMode && "font-mono",
									showSuggestionHint && "pr-24",
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
								<DictationOverlay
									levels={dictation.levels}
									phase={dictation.phase}
									startedAt={dictation.startedAt}
								/>
							)}
							{showSuggestionHint && (
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

						{keys.escHint ? (
							<div className="truncate px-4 pb-1 text-sc-xs text-(--sc-text-muted)" data-esc-hint role="status">
								{t("input.escAgainToClear")}
							</div>
						) : !menu && argHint ? (
							<div className="truncate px-4 pb-1 font-mono text-sc-xs text-(--sc-text-muted)">{argHint}</div>
						) : (
							nextPromptView.unavailable &&
							status === "ready" && (
								<div
									className="truncate px-4 pb-1 text-sc-xs text-(--sc-text-muted)"
									data-next-prompt-unavailable
									role="status"
									title={nextPromptView.unavailable.detail}
								>
									{t(`input.suggestion.unavailable.${nextPromptView.unavailable.reason}`)}
								</div>
							)
						)}

						<ComposerToolbar
							composerMode={composerMode?.mode}
							dictationPhase={dictation.phase}
							expanded={expanded}
							fileInputRef={fileInputRef}
							followUp={mode === "followUp"}
							onFilesPicked={filesPicked}
							onMic={dictation.toggle}
							onOpenFilePicker={openFilePicker}
							onOpenHistory={openHistorySearch}
							onOpenSkills={openSkillPicker}
							onSend={sendFromToolbar}
							onStop={stopFromToolbar}
							onStopAndSend={dictation.stopAndSend}
							onToggleExpanded={toggleExpandedFromMenu}
							onToggleSendMode={toggleSendMode}
							queueSplitCount={queueSplitCount}
							queued={queueBody !== undefined}
							routeReady={routeReady}
							sendDisabled={sendDisabled}
							showSend={showSend}
							stoppable={stoppable}
							touchInput={touchInput}
						/>
					</div>
				</div>
				<BelowEditorDockSlot />
			</div>
		</div>
	);
}
