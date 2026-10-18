import { Paperclip } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useInlineCompletion } from "../../../hooks/use-inline-completion";
import { useShellInput, useShellMode } from "../../../hooks/use-shell-mode";
import type { ComposerWindowAction } from "../../../lib/composer-actions";
import { COMPOSER_BLOCKED_PLACEHOLDER, useComposerBlockedBy } from "../../../lib/composer-blocked";
import { useDisplayPreference } from "../../../lib/display-preferences";
import { cx } from "../../../lib/format";
import { composerEnterNewline } from "../../../lib/hardware-keyboard";
import { useT } from "../../../lib/i18n";
import { parseComposerMode } from "../../../lib/input-modes";
import { abortActiveTurn } from "../../../lib/messages";
import { parseQueueShorthand, splitQueuedMessages } from "../../../lib/queue-input";
import { useTabRpc } from "../../../lib/tab-rpc";
import { type ComposerStore, useComposerStore } from "../../../stores/composer";
import { useFirstRunStore } from "../../../stores/first-run";
import { useMessagesStore } from "../../../stores/messages";
import { useNextPromptStore } from "../../../stores/next-prompt";
import { useSessionStore } from "../../../stores/session";
import { sessionRuntimeStore, useRuntimeTabId } from "../../../stores/session-runtime-context";
import { useActiveTabKind, useTabsStore } from "../../../stores/tabs";
import { useUiStore } from "../../../stores/ui";
import { Banner, Button } from "../../common";
import { AskDockSlot, BelowEditorDockSlot } from "../../dialogs/ask-dock";
import { CompletionList, CompletionStatus } from "./CompletionList";
import { ComposerAttachments } from "./ComposerAttachments";
import { ComposerExpandedHeader, useExternalEditor } from "./ComposerExpandedHeader";
import { ComposerField, ComposerFieldHint } from "./ComposerField";
import { ComposerLiveEdge } from "./ComposerLive";
import { ComposerPickers } from "./ComposerPickers";
import { ComposerQueueLive, ComposerQueuePill } from "./ComposerQueue";
import { ComposerEditBanner, useComposerQueueEdit } from "./ComposerQueueEdit";
import { ComposerRestoredQueue } from "./ComposerRestoredQueue";
import { ComposerStatusRow } from "./ComposerStatusRow";
import { ComposerToolbar } from "./ComposerToolbar";
import { ComposerUnderField } from "./ComposerUnderField";
import { NextPromptChips, type NextPromptChipsHandle } from "./NextPromptChips";
import { PasteMenu } from "./PasteMenu";
import { useComposerAttach } from "./use-composer-attach";
import { useComposerCommands } from "./use-composer-commands";
import { useComposerDictation } from "./use-composer-dictation";
import { useComposerDraft } from "./use-composer-draft";
import { useComposerActionEvents, useComposerEvents } from "./use-composer-events";
import { useComposerField } from "./use-composer-field";
import { useComposerHistory } from "./use-composer-history";
import { useComposerKeys } from "./use-composer-keys";
import { useComposerMenu } from "./use-composer-menu";
import { useComposerPaste } from "./use-composer-paste";
import { useComposerSubmit } from "./use-composer-submit";
import { useComposerSuggestions } from "./use-composer-suggestions";
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
	/** Agent `emojiAutocomplete` setting: emoji popup/inline/submit expansion. */
	const emojiAutocomplete = useDisplayPreference("emojiAutocomplete");
	const sessionFile = useSessionStore(s => s.sessionFile);
	const touchInput = useShellInput() === "touch";
	/** A phone gets the status chip row above the box (model, Plan, Run, context + suggestions) and `[+] [field] [Send]`. */
	const phone = useShellMode() === "phone";
	/** "Enter sends on mobile": a touch device's Enter sends instead of adding a line. */
	const enterSends = useUiStore(state => state.displayPreferences.mobileEnterSends === true);
	const enterNewline = composerEnterNewline(touchInput, enterSends);
	const {
		view: nextPromptView,
		key: nextPromptKey,
		placeholderPrompt,
		chips: chipList,
	} = useComposerSuggestions({ isStreaming, sessionFile, sessionId, touchInput });

	// Draft lives in the composer store (not local state) so session-tab
	// switches snapshot/restore it per tab. Value + updater-form setter are
	// drop-in for the old useState pair.
	const text = useComposerStore(s => s.draft);
	const setText = useComposerStore(s => s.setDraft);
	const images = useComposerStore(s => s.images);
	const setImages = useComposerStore(s => s.setImages);
	/** A queued message is being edited in the field (ComposerQueueEdit.tsx): the saved draft is the one it replaced. */
	const editingQueued = useComposerStore(s => s.editingQueued);
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
		empty: menuEmpty,
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
	/** The phone's Run sheet (Tool approval, Delegation): opened by the Run chip or the + sheet's rows. */
	const [runSheetOpen, setRunSheetOpen] = useState(false);
	const isEmptySession = useMessagesStore(s => s.messages.length === 0);
	const focusedPane = contextTabId === null || contextTabId === activeTabId;

	// The unsent draft outlives a reload and a relaunch (draft-persistence.ts): the session's saved
	// text comes back into an empty field once the session is known, and every change is saved.
	useComposerDraft({
		// While a queued message is edited the field holds it, not the draft: the saved draft stays the one it replaced.
		text: editingQueued ? editingQueued.snapshot.draft : text,
		imageCount: images.length,
		runtimeTabId,
		device: historyDevice,
		sessionFile,
		sessionId,
		cwd,
		empty: isEmptySession,
	});

	/** False once the composer unmounted: uploads, dictation and the $EDITOR round trip check it before writing. */
	const mountedRef = useRef(true);
	const regionRef = useRef<HTMLDivElement>(null);
	const attachmentsRef = useRef<HTMLDivElement>(null);
	const { fileInputRef, onFilesPicked, openFilePicker, attachFiles, sendingFiles, dragActive } = useComposerAttach({
		cwd,
		historyDevice,
		runtimeTabId,
		mountedRef,
		insertAtCaret,
		setImages,
		textareaRef,
		regionRef,
	});
	const paste = useComposerPaste({ text, textareaRef, placeDraft, attachFiles, runtimeTabId });
	const pasteMenu = paste.pending;
	const chipsRef = useRef<NextPromptChipsHandle>(null);
	/** Runner-up suggestions: only over an empty, idle composer with nothing else open. */
	/** The suggestion row's place is kept while a draft is typed (its chips hide): the transcript never resizes on a keystroke. */
	const chipRow = chipList.length > 0 && status === "ready" && !isStreaming;
	const chipsShown = chipRow && text === "" && !menu && !pasteMenu;
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

	const queueEdit = useComposerQueueEdit();
	const blockedBy = useComposerBlockedBy();
	const deciding = useComposerStore(state => state.decidingMode);
	const stopArmed = useComposerStore(state => state.stopArmedAt !== null);
	/** The suggestion shows as the placeholder only while nothing more urgent owns it. */
	const shownPrompt = blockedBy === null && queueEdit.editing === null ? placeholderPrompt : undefined;
	const focusField = useCallback(() => textareaRef.current?.focus(), [textareaRef]);
	/** Cancel or Esc: the draft and pictures the edit took over come back exactly, and typing goes on in the field. */
	const cancelQueueEdit = useCallback(() => {
		queueEdit.cancel();
		textareaRef.current?.focus();
	}, [queueEdit.cancel, textareaRef]);
	const queueSlot = useMemo(() => <ComposerQueuePill onSettled={focusField} />, [focusField]);
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
			// Edit queued: Send saves the message back into the queue instead of sending the field.
			if (composer.getState().editingQueued) return queueEdit.save(composer.getState().draft);
			const hadContent = (overrideText ?? composer.getState().draft).trim() !== "" || images.length > 0;
			dispatchSend(overrideText, forceMode);
			const after = composer.getState();
			const sent = hadContent && after.draft === "" && after.images.length === 0;
			if (sent) useNextPromptStore.getState().clear(nextPromptKey);
			return sent;
		},
		[dispatchSend, queueEdit.save, runtimeTabId, images.length, nextPromptKey],
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

	const externalEditor = useExternalEditor({ text, placeDraft, mountedRef });

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
		placeholderPrompt: shownPrompt,
		acceptSuggestion: nextPromptView.accepted,
		menu: { menu, setMenu, dismiss: dismissMenu, insert: insertCompletion },
		history,
		expanded,
		toggleExpanded,
		collapse: () => setExpanded(false),
		toggleHistorySearch: () => setHistorySearchOpen(open => !open),
		runActive: isStreaming || submitPending || manualMaintenance,
		touchInput,
		attachmentsRef,
		enterSends,
		queueEdit: queueEdit.editing ? { cancel: cancelQueueEdit } : null,
		send,
	});
	const sendDisabled =
		!routeReady ||
		(status !== "ready" && status !== "starting") ||
		sending ||
		submissionUncertain ||
		(!text.trim() && images.length === 0);
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
	const openRunSheet = useCallback(() => setRunSheetOpen(true), []);
	const toggleExpandedFromMenu = useCallback(() => toggleExpanded(), [toggleExpanded]);
	// The palette's History / Expand / Attach rows reach this composer through one window event.
	const onPaletteAction = useStableCallback((action: ComposerWindowAction) => {
		if (action === "history") openHistorySearch();
		else if (action === "expand") toggleExpandedFromMenu();
		else openFilePicker();
	});
	useComposerActionEvents(runtimeTabId, onPaletteAction);
	// What the field's placeholder says, first match wins (RA-20): a question, approval or plan waits on the user, a queued
	// message is being edited, the suggestion the user can take, then the lane Enter sends to, then idle.
	const placeholder =
		status !== "ready" && status !== "starting"
			? t("input.placeholder.connecting")
			: blockedBy !== null
				? t(COMPOSER_BLOCKED_PLACEHOLDER[blockedBy])
				: queueEdit.editing
					? t("composerQueue.editPlaceholder")
					: shownPrompt !== undefined
						? shownPrompt
						: isStreaming
							? mode === "followUp"
								? t("input.placeholder.followUp")
								: t("input.placeholder.streaming")
							: isChat || fieldNarrow
								? t("input.placeholder.chat")
								: t("input.placeholder.idle");
	/** Tab-accept hint chip: only while the suggestion is the visible placeholder. */
	const showSuggestionHint = shownPrompt !== undefined && text === "";
	const menuId = useId();
	/** Streaming with nothing to send: Stop takes the send slot instead of a dead Send. */
	const showSend = !stoppable || text.trim() !== "" || images.length > 0 || queueEdit.editing !== null;

	return (
		<div
			ref={regionRef}
			className={cx(
				"omp-composer-region relative shrink-0 bg-transparent pb-3",
				expanded && "omp-composer-region--expanded",
			)}
		>
			<div className="omp-composer-shell relative w-full">
				<AskDockSlot />
				<ComposerQueueLive />

				{/* Anchoring context for completion/history overlays: they sit directly
				    above the input box instead of the surrounding composer region. */}
				<div className="omp-composer-anchor relative">
					{pasteMenu && (
						<PasteMenu
							active={paste.active}
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
					{menu && (
						<CompletionList
							menu={menu}
							menuId={menuId}
							onHover={index => setMenu({ ...menu, index })}
							onPick={insertCompletion}
						/>
					)}
					<CompletionStatus count={menu?.items.length ?? 0} empty={menuEmpty} />

					<ComposerPickers
						closeHistory={() => setHistorySearchOpen(false)}
						closeSkills={() => setSkillPickerOpen(false)}
						commands={commands}
						cwd={cwd}
						historyOpen={historySearchOpen}
						// A pick replaces the draft the way ↑ does.
						onPickHistory={prompt => history.pick(prompt, text)}
						onPickSkill={name => insertAtCaret(`/skill:${name}`)}
						skillsOpen={skillPickerOpen}
						textareaRef={textareaRef}
					/>
					{phone ? (
						<ComposerStatusRow
							onRunOpenChange={setRunSheetOpen}
							runOpen={runSheetOpen}
							shown={!expanded}
							trailing={
								chipRow ? (
									<NextPromptChips
										away={!chipsShown}
										bare
										chips={chipList}
										handleRef={chipsRef}
										onPick={pickChip}
										onReturn={() => textareaRef.current?.focus()}
										onSend={touchInput ? sendChip : undefined}
										touch={touchInput}
									/>
								) : undefined
							}
							trailingAway={!chipsShown}
						/>
					) : (
						chipRow && (
							<NextPromptChips
								away={!chipsShown}
								chips={chipList}
								handleRef={chipsRef}
								onPick={pickChip}
								onSend={touchInput ? sendChip : undefined}
								touch={touchInput}
								onReturn={() => textareaRef.current?.focus()}
							/>
						)
					)}
					{/* Focus and drag paint live in components.css (.omp-composer-box): the
					    field state follows the TEXT field, not any focused descendant, so a
					    focused toolbar control draws its own ring, never a ring in a ring. */}
					<div
						className="omp-composer-box relative flex flex-col rounded-(--sc-radius-xl) border border-(--sc-border-subtle) bg-(--sc-field) shadow-(--sc-shadow-sm) transition-[border-color,box-shadow] duration-(--sc-duration-fast)"
						data-composer-mode={composerMode?.mode}
						data-composer-draft={text !== "" || undefined}
						data-drag-active={dragActive || undefined}
					>
						<ComposerLiveEdge />
						{dragActive && (
							<div aria-hidden className="omp-composer-drop omp-fade-in">
								<Paperclip aria-hidden className="size-(--sc-icon-md)" />
								{t("input.dropFiles")}
							</div>
						)}
						{expanded && (
							<ComposerExpandedHeader editor={externalEditor} onCollapse={() => toggleExpanded(false)} />
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
						<ComposerEditBanner onCancel={cancelQueueEdit} />
						<ComposerRestoredQueue onSettled={focusField} />
						<ComposerAttachments
							images={images}
							placeDraft={placeDraft}
							sendingFiles={sendingFiles}
							setImages={setImages}
							setText={setText}
							text={text}
							textareaRef={textareaRef}
							containerRef={attachmentsRef}
							touch={touchInput}
						/>
						<ComposerField
							activeOption={menu?.index}
							emojiAutocomplete={emojiAutocomplete}
							expanded={expanded}
							inline={inline}
							listboxId={menuId}
							monospace={composerMode !== null}
							enterKeyHint={enterNewline ? "enter" : undefined}
							onFieldClick={() => setMenu(null)}
							onKeyDown={keys.onKeyDown}
							onPaste={paste.onPaste}
							ownEdit={ownEdit}
							placeDraft={placeDraft}
							placeholder={placeholder}
							setText={setText}
							suggestionHint={showSuggestionHint}
							text={text}
							textareaRef={textareaRef}
						/>
						<ComposerFieldHint
							argHint={menu ? "" : argHint}
							deciding={deciding}
							escHint={keys.escHint}
							stopArmed={stopArmed}
							unavailable={status === "ready" ? nextPromptView.unavailable : undefined}
						/>
						<ComposerUnderField dictation={dictation} />

						<ComposerToolbar
							composerMode={composerMode?.mode}
							composerExcluded={composerMode?.excluded}
							dictationPhase={dictation.phase}
							editingQueued={editingQueued !== null}
							expanded={expanded}
							fileInputRef={fileInputRef}
							followUp={mode === "followUp"}
							onFilesPicked={filesPicked}
							onMic={dictation.toggle}
							onOpenFilePicker={openFilePicker}
							onOpenHistory={openHistorySearch}
							onOpenSkills={openSkillPicker}
							onOpenRunSheet={openRunSheet}
							onSend={sendFromToolbar}
							onStop={stopFromToolbar}
							onStopAndSend={dictation.stopAndSend}
							onToggleExpanded={toggleExpandedFromMenu}
							onToggleSendMode={toggleSendMode}
							queueSplitCount={queueSplitCount}
							queued={queueBody !== undefined}
							queueSlot={queueSlot}
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
