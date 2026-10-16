import {
	ArrowUp,
	ChevronDown,
	ClipboardPaste,
	CornerDownRight,
	Cpu,
	ExternalLink,
	History,
	ListPlus,
	Maximize2,
	Mic,
	Minimize2,
	Paperclip,
	Plus,
	Sparkles,
	Square,
	Target,
	X,
} from "lucide-react";
import type { ClipboardEvent, DragEvent, KeyboardEvent } from "react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { removeFileMention } from "../../../../shared/file-mentions";
import type { AvailableCommand, ImageContent } from "../../../../shared/rpc-types";
import { useInlineCompletion } from "../../../hooks/use-inline-completion";
import { useNextPrompt } from "../../../hooks/use-next-prompt";
import { withGuiCommands } from "../../../lib/command-registry";
import { useDisplayPreference } from "../../../lib/display-preferences";
import { tryEmojiInlineReplace } from "../../../lib/emoji";
import { FILE_DRAG_TYPE, readFileDrag } from "../../../lib/file-drag";
import { cx } from "../../../lib/format";
import { historyImages } from "../../../lib/history-images";
import { useT } from "../../../lib/i18n";
import { isImeKeyEvent } from "../../../lib/ime";
import { parseComposerMode } from "../../../lib/input-modes";
import { chordFromEvent, formatShortcut, isComposerFollowUpKey, PLATFORM } from "../../../lib/keymap";
import { continueList } from "../../../lib/list-continue";
import { abortActiveTurn } from "../../../lib/messages";
import { NEXT_PROMPT_WIDGET } from "../../../lib/next-prompt";
import {
	dropReferencedPastes,
	editPaste,
	expandPasteMarkers,
	getPaste,
	isMarkerSized,
	pasteMarkerText,
	referencedPasteIds,
	shouldOfferPasteMenu,
	storePaste,
	wrapPasteInAttachmentBlock,
} from "../../../lib/paste-blobs";
import { parseQueueShorthand, splitQueuedMessages } from "../../../lib/queue-input";
import { useTabRpc } from "../../../lib/tab-rpc";
import {
	cancelVoiceRecording,
	evaluateSttSubmitTrigger,
	METER_BARS,
	readSttSubmitTrigger,
	recordAndTranscribe,
	stopVoiceRecording,
} from "../../../lib/voice";
import { type ComposerImage, type ComposerStore, prependToDraft, useComposerStore } from "../../../stores/composer";
import { useExtensionUiStore } from "../../../stores/extension-ui";
import { useFirstRunStore } from "../../../stores/first-run";
import { type InputHistoryContext, useInputHistoryStore } from "../../../stores/input-history";
import { useMessagesStore } from "../../../stores/messages";
import { useModelStore } from "../../../stores/model";
import { useNextPromptStore } from "../../../stores/next-prompt";
import { type SessionStore, useSessionStore } from "../../../stores/session";
import { sessionRuntimeStore, useRuntimeTabId } from "../../../stores/session-runtime-context";
import { useSettingsStore } from "../../../stores/settings";
import { useActiveTabKind, useTabsStore } from "../../../stores/tabs";
import { toast, toastError } from "../../../stores/toast";
import { useUiStore } from "../../../stores/ui";
import { Badge, Banner, Button, IconButton, Kbd, MenuButton, Tooltip, ZoomableImage } from "../../common";
import { AskDockSlot, BelowEditorDockSlot } from "../../dialogs/ask-dock";
import { ComposerLiveEdge, ComposerSend } from "./ComposerLive";
import { ComposerModes } from "./ComposerModes";
import { ComposerQueue } from "./ComposerQueue";
import { ContextUsagePopover } from "./ContextUsagePopover";
import { fileMentionFor, fileTextAttachment, intakeComposerFiles } from "./composer-files";
import { DelegationControl } from "./DelegationControl";
import { DictationOverlay, type DictationPhase } from "./DictationOverlay";
import { DraftFileCards } from "./DraftFileCards";
import { draftKeys, loadDraft, saveDraft } from "./draft-persistence";
import { HistorySearchOverlay } from "./HistorySearchOverlay";
import { cachedMentionFiles, editFieldText, fileToImage, listMentionFiles, mentionToken } from "./input-area-utils";
import { chipIndexForCode, NextPromptChips, type NextPromptChipsHandle } from "./NextPromptChips";
import { PastedTextDialog } from "./PastedTextDialog";
import { RunSettings } from "./RunSettings";
import { SkillPickerOverlay } from "./SkillPickerOverlay";
import { type CompletionItem, type CompletionMenu, sameCompletionMenu, useCompletionMenu } from "./use-completion-menu";
import { useComposerSubmit } from "./use-composer-submit";

type SendMode = "prompt" | "steer" | "followUp";

const MENTION_FS_DEBOUNCE_MS = 150;
/** Rows PageUp/PageDown move through the completion menu. */
const MENU_PAGE = 5;
/** Second Esc within this window clears the draft or runs the double-Esc action (stock uses 500 ms; a hint needs reading time). */
const DOUBLE_ESC_MS = 1500;
/** Typing pause before the draft is saved for a reload or relaunch. */
const DRAFT_SAVE_MS = 300;
/** The window's localStorage; absent (tests, a locked-down page) the draft only lives in memory. */
const browserStorage: Storage | undefined = (() => {
	try {
		return typeof localStorage === "undefined" ? undefined : localStorage;
	} catch {
		return undefined;
	}
})();

/** Below this field width the idle hint no longer fits on its line (ko, 14px: ~250px of text plus padding). */
const NARROW_FIELD_PX = 290;

/**
 * Grow the field to fit its text, up to ~40% of the pane (one line while empty); the expanded composer
 * fills the pane instead, its height is CSS's.
 */
function fitFieldHeight(el: HTMLTextAreaElement, expanded: boolean): void {
	if (expanded) {
		el.style.height = "";
		return;
	}
	el.style.height = "0px";
	const paneHeight = el.closest<HTMLElement>(".omp-session-pane")?.clientHeight ?? window.innerHeight;
	const maxHeight = el.value.length === 0 ? 24 : paneHeight * 0.4;
	el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
}

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
	const model = useModelStore(s => s.model);
	const settingUp = useFirstRunStore(s => s.phase !== "idle");
	const openModelPicker = useUiStore(s => s.openModelPicker);
	const openModes = useUiStore(s => s.openModes);
	const openSettings = useUiStore(s => s.openSettings);
	/** Agent `stt.enabled` setting: microphone dictation button in the composer. */
	const sttEnabled = useSettingsStore(s => s.sttEnabled);
	/** Agent `paste.largeMenuThreshold` setting: line count that triggers the paste menu. */
	const pasteMenuThreshold = useDisplayPreference("pasteMenuThreshold");
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
	const [menu, setMenu] = useState<CompletionMenu | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	/**
	 * A menu the user closed (Esc, ←/→, a click): the same token's menu stays closed while the draft is
	 * unchanged, so moving the caret back into the token does not bring it back; any edit lifts it.
	 */
	const dismissedMenu = useRef<{ source: CompletionMenu["source"]; rangeStart: number; draft: string } | null>(null);
	/** The menu re-derives on every command refresh and caret event: an unchanged one keeps its highlight. */
	const publishMenu = useCallback((next: CompletionMenu | null) => {
		const dismissed = dismissedMenu.current;
		if (dismissed && textareaRef.current?.value !== dismissed.draft) dismissedMenu.current = null;
		const shown =
			dismissedMenu.current?.source === next?.source && dismissedMenu.current?.rangeStart === next?.rangeStart
				? null
				: next;
		setMenu(current => (current && shown && sameCompletionMenu(current, shown) ? current : shown));
	}, []);
	const dismissMenu = () => {
		if (menu)
			dismissedMenu.current = {
				source: menu.source,
				rangeStart: menu.rangeStart,
				draft: textareaRef.current?.value ?? text,
			};
		setMenu(null);
	};
	const [commands, setCommands] = useState<AvailableCommand[]>([]);
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
	const [filePaths, setFilePaths] = useState<string[]>([]);
	const [historySearchOpen, setHistorySearchOpen] = useState(false);
	const [skillPickerOpen, setSkillPickerOpen] = useState(false);
	const [dictation, setDictation] = useState<DictationPhase>("idle");
	const [dictationLevels, setDictationLevels] = useState<readonly number[]>(() => Array(METER_BARS).fill(0));
	const [dictationStartedAt, setDictationStartedAt] = useState<number | null>(null);
	/** "Stop and send": submit the draft once the take is transcribed into it. */
	const sendAfterDictationRef = useRef(false);
	const recording = dictation !== "idle";
	/** Pending large-paste choice: the paste already happened, this picks the form. */
	const [pasteMenu, setPasteMenu] = useState<{ content: string; lineCount: number } | null>(null);
	const pasteMenuRef = useRef<HTMLDivElement>(null);
	/** The folded paste open in "Edit pasted text". */
	const [editingPaste, setEditingPaste] = useState<number | null>(null);
	const draftPastes = useMemo(() => referencedPasteIds(text), [text]);
	/** The draft's pictures while ↑/↓ shows history entries (restored on the way back). */
	const navDraftImages = useRef<ComposerImage[]>([]);
	/** ⌃G: the composer expands in place to fill the session pane (design-spec §2.2). */
	const [expanded, setExpanded] = useState(false);
	const [externalBusy, setExternalBusy] = useState(false);
	const [dragActive, setDragActive] = useState(false);
	/** First Esc of a double-Esc, and whether its "Esc again" hint shows. */
	const escArmedAt = useRef<number | null>(null);
	const [escHint, setEscHint] = useState(false);
	const isEmptySession = useMessagesStore(s => s.messages.length === 0);
	const focusedPane = contextTabId === null || contextTabId === activeTabId;

	// The unsent draft outlives a reload and a relaunch (draft-persistence.ts): the session's saved
	// text comes back into an empty field once the session is known, and every change is saved.
	const draftStore = useMemo(
		() => draftKeys({ device: historyDevice, sessionFile, sessionId, cwd, empty: isEmptySession }),
		[historyDevice, sessionFile, sessionId, cwd, isEmptySession],
	);
	/** The session key whose saved draft was read; saving waits for it so an empty first render never erases it. */
	const [draftLoadedFor, setDraftLoadedFor] = useState<string | null>(null);
	useEffect(() => {
		if (!draftStore || draftLoadedFor === draftStore.session || !browserStorage) return;
		const composer = sessionRuntimeStore<ComposerStore>(runtimeTabId, "composer") ?? useComposerStore;
		if (composer.getState().draft === "") {
			const saved = loadDraft(browserStorage, draftStore, performance.timeOrigin);
			if (saved !== undefined) composer.getState().setDraft(saved);
		}
		setDraftLoadedFor(draftStore.session);
	}, [draftStore, draftLoadedFor, runtimeTabId]);
	useEffect(() => {
		if (!draftStore || draftLoadedFor !== draftStore.session || !browserStorage) return;
		const storage = browserStorage;
		// A sent or cleared draft is dropped at once; typing is saved once it pauses.
		const timer = setTimeout(
			() => saveDraft(storage, draftStore, expandPasteMarkers(text)),
			text ? DRAFT_SAVE_MS : 0,
		);
		return () => clearTimeout(timer);
	}, [text, draftStore, draftLoadedFor]);

	/** True while the composer writes its own draft into the field: the field's onChange then only mirrors it. */
	const ownEdit = useRef(false);
	/**
	 * Write the draft and its caret in one task. A caret placed on a later frame moved
	 * whatever the next keys did meanwhile (a select-all, typed text); written here,
	 * React finds its value already in the field and leaves the caret alone. In the
	 * focused field the write is one native edit (editFieldText), so Cmd/Ctrl+Z undoes it
	 * and brings back what was there; a value set by script corrupted the undo stack.
	 */
	const placeDraft = useCallback(
		(next: string, caret: number) => {
			const el = textareaRef.current;
			if (el) {
				ownEdit.current = true;
				try {
					if (!editFieldText(el, next)) el.value = next;
				} finally {
					ownEdit.current = false;
				}
				el.setSelectionRange(caret, caret);
			}
			setText(next);
		},
		[setText],
	);
	/**
	 * Continue (or end) a markdown list at the caret for a newline key. The edit goes through the
	 * browser's own insertion so Cmd/Ctrl+Z restores the plain newline; a field that refuses it
	 * (no `execCommand`) takes the draft directly. False when the plain newline should stand.
	 */
	const continueListAtCaret = (): boolean => {
		const el = textareaRef.current;
		if (!el) return false;
		const value = el.value;
		const start = el.selectionStart ?? value.length;
		const edit = continueList(value, start, el.selectionEnd ?? start);
		if (!edit) return false;
		const next = value.slice(0, edit.from) + edit.insert + value.slice(edit.to);
		el.setSelectionRange(edit.from, edit.to);
		// The newline and the bullet are separate insertions: one undo then leaves the plain newline.
		const exec = typeof document.execCommand === "function" ? document.execCommand.bind(document) : undefined;
		let done = false;
		if (exec !== undefined) {
			if (edit.insert === "") done = exec("delete");
			else if (edit.insert.length === 1) done = exec("insertText", false, edit.insert);
			else if (exec("insertText", false, "\n")) {
				// Moving the caret closes the open typing command, so the bullet is its own undo step.
				el.setSelectionRange(edit.from + 1, edit.from + 1);
				done = exec("insertText", false, edit.insert.slice(1));
			}
		}
		if (!done || el.value !== next) placeDraft(next, edit.caret);
		else el.setSelectionRange(edit.caret, edit.caret);
		return true;
	};
	const chipsRef = useRef<NextPromptChipsHandle>(null);
	/** Runner-up suggestions: only over an empty, idle composer with nothing else open. */
	const chipsShown =
		nextPromptView.chips.length > 0 && text === "" && status === "ready" && !isStreaming && !menu && !pasteMenu;
	const pickChip = useCallback(
		(chip: string) => {
			textareaRef.current?.focus();
			placeDraft(chip, chip.length);
			nextPromptView.accepted();
		},
		[placeDraft, nextPromptView],
	);
	/** Ghost text after the caret while the user types (slash / `@` menus, IME, `!` `$` `/` drafts: never). */
	const inline = useInlineCompletion({
		enabled: nextPromptView.inline && status === "ready" && !isStreaming && routeReady,
		text,
		menuOpen: menu !== null || pasteMenu !== null,
		textareaRef,
		complete: nextPromptView.completeInline,
	});
	// A pane of a 2x2 split has a field narrower than the idle hint ("Ask anything · @ files · / commands"):
	// it shows the short prompt instead of a hint cut mid-glyph. A new width also rewraps the draft, so the
	// field's height is fitted again (a side panel opening made the draft scroll inside a too-short field).
	const [fieldNarrow, setFieldNarrow] = useState(false);
	useEffect(() => {
		const el = textareaRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		let width = el.clientWidth;
		const observer = new ResizeObserver(() => {
			setFieldNarrow(el.clientWidth > 0 && el.clientWidth < NARROW_FIELD_PX);
			if (el.clientWidth === width) return;
			width = el.clientWidth;
			fitFieldHeight(el, expanded);
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [expanded]);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const mountedRef = useRef(true);
	/** This composer started the take in flight: only then does its unmount discard it (another pane may be dictating). */
	const ownsTake = useRef(false);

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

	// A large-paste choice stays reversible until the user explicitly chooses a
	// representation. Outside click cancels it instead of silently inserting
	// the default form.
	useEffect(() => {
		if (!pasteMenu) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (target instanceof Node && pasteMenuRef.current?.contains(target)) return;
			setPasteMenu(null);
		};
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [pasteMenu]);

	// This composer's in-flight dictation is cancelled (never transcribed) if it unmounts; the
	// recording slot is app-wide, and closing one split pane must not end another pane's take.
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			if (ownsTake.current) cancelVoiceRecording();
		};
	}, []);

	// The "Esc again to clear" hint lasts as long as the second press counts; any edit disarms it.
	useEffect(() => {
		if (!escHint) return;
		const timer = setTimeout(() => setEscHint(false), DOUBLE_ESC_MS);
		return () => clearTimeout(timer);
	}, [escHint]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: an edit of the draft disarms a pending Esc
	useEffect(() => {
		escArmedAt.current = null;
		setEscHint(false);
	}, [text]);

	/** Stock `doubleEscapeAction` (default `rewind`): the rewind picker, the session tree, or nothing. */
	const runDoubleEscapeAction = async () => {
		const response = await rpc.getSettings(["doubleEscapeAction"]).catch(() => undefined);
		const values = response?.success
			? (response.data as { values?: Record<string, unknown> } | undefined)?.values
			: undefined;
		const action = values?.doubleEscapeAction ?? "rewind";
		if (action === "tree") useUiStore.getState().openSessionTree();
		else if (action === "rewind") useUiStore.getState().openBranchPicker();
	};

	// Refresh from this tab's omp machine when its bridge is ready.
	useEffect(() => {
		if (status === "ready") void useInputHistoryStore.getState().hydrate(rpc, historyDevice);
	}, [rpc, status, historyDevice]);

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

	// Keep slash commands current across sidecar startup and extension reloads.
	useEffect(() => {
		let cancelled = false;
		const unsubscribe = window.omp.events.onTabCommandsUpdate((next, tabId) => {
			if (!cancelled && tabId === runtimeTabId) setCommands(withGuiCommands(next));
		});
		const load = () => {
			if (status !== "ready" || !runtimeTabId) return;
			void rpc.getAvailableCommands().then(res => {
				if (
					cancelled ||
					sessionRuntimeStore<SessionStore>(runtimeTabId, "session")?.getState().sessionId !== sessionId ||
					!res.success
				)
					return;
				const data = res.data as { commands?: AvailableCommand[] } | undefined;
				setCommands(withGuiCommands(data?.commands ?? []));
			});
		};
		load();
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [status, sessionId, runtimeTabId, rpc]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: the field's height follows its text (read from the element)
	useEffect(() => {
		const el = textareaRef.current;
		if (el) fitFieldHeight(el, expanded);
	}, [text, expanded]);

	// Contextual argument hint (TUI ghost-text parity), from stock for builtins.
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
	}, [text, cwd, routeReady, runtimeTabId]);

	useEffect(() => {
		const onInsertMention = (event: Event) => {
			const detail = (event as CustomEvent<{ path?: string; tabId?: string }>).detail;
			if ((detail?.tabId ?? useTabsStore.getState().activeTabId) !== runtimeTabId) return;
			const path = detail?.path;
			if (!path) return;
			const mention = fileMentionFor(path, "");
			setText(current => `${current}${current && !current.endsWith(" ") ? " " : ""}${mention} `);
			requestAnimationFrame(() => textareaRef.current?.focus());
		};
		window.addEventListener("omp:insert-mention", onInsertMention);
		return () => window.removeEventListener("omp:insert-mention", onInsertMention);
	}, [setText, runtimeTabId]);

	useEffect(() => {
		const fillComposer = (event: Event) => {
			const detail = (
				event as CustomEvent<{
					text?: string;
					images?: ImageContent[];
					prepend?: boolean;
					clearPastes?: boolean;
					tabId?: string;
				}>
			).detail;
			if ((detail?.tabId ?? useTabsStore.getState().activeTabId) !== runtimeTabId) return;
			const next = detail?.text;
			const restoredImages = detail?.images ?? [];
			if (!next && restoredImages.length === 0) return;
			// The editor dialog writes back fully-inline text — consume the blobs.
			if (detail?.clearPastes)
				dropReferencedPastes(sessionRuntimeStore<ComposerStore>(runtimeTabId, "composer")?.getState().draft ?? "");
			if (next) {
				// prepend (dequeue restore): queued text goes ahead of any draft, TUI-style;
				// otherwise replace (starter cards, history recall).
				const current =
					textareaRef.current?.value ??
					sessionRuntimeStore<ComposerStore>(runtimeTabId, "composer")?.getState().draft ??
					"";
				placeDraft(detail?.prepend ? prependToDraft(next, current) : next, next.length);
			}
			if (restoredImages.length > 0) {
				setImages(current => [
					...current,
					...restoredImages.map(content => ({
						content,
						preview: `data:${content.mimeType};base64,${content.data}`,
					})),
				]);
			}
			// Focus waits a frame: the surface that sent the text (a dialog, a menu) may still
			// hand focus back as it closes. Focus keeps the caret placed above.
			requestAnimationFrame(() => {
				const el = textareaRef.current;
				if (!el) return;
				if (useTabsStore.getState().activeTabId !== runtimeTabId) return;
				el.focus();
			});
		};
		window.addEventListener("omp:fill-composer", fillComposer);
		return () => window.removeEventListener("omp:fill-composer", fillComposer);
	}, [placeDraft, setImages, runtimeTabId]);

	const insertCompletion = useCallback(
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
		[text, menu, placeDraft],
	);

	// Collapse a large paste into a `[Paste #N]` marker with the blob held in
	// memory; the marker expands back to full content at submit time (TUI
	// editor.ts parity). Inserted at the caret, replacing any selection.
	const insertPasteBlob = useCallback(
		(content: string) => {
			const blob = storePaste(content);
			const marker = pasteMarkerText(blob.id, blob.content);
			const el = textareaRef.current;
			const current = el?.value ?? text;
			const start = el?.selectionStart ?? current.length;
			const end = el?.selectionEnd ?? start;
			el?.focus();
			placeDraft(`${current.slice(0, start)}${marker}${current.slice(end)}`, start + marker.length);
		},
		[text, placeDraft],
	);

	// Paste menu actions — the paste always inserts something; the menu only
	// picks the form. Keep side effects outside state updaters: React may replay
	// updater functions, which must never duplicate a paste or an RPC write.
	const choosePasteInline = useCallback(() => {
		if (!pasteMenu) return;
		insertPasteBlob(pasteMenu.content);
		setPasteMenu(null);
	}, [insertPasteBlob, pasteMenu]);

	const choosePasteWrapped = useCallback(() => {
		if (!pasteMenu) return;
		insertPasteBlob(wrapPasteInAttachmentBlock(pasteMenu.content));
		setPasteMenu(null);
	}, [insertPasteBlob, pasteMenu]);

	// Save-as-file: the agent writes the blob into the session's local:// store
	// (counter allocated agent-side so two windows can never collide) and the
	// composer gets the returned literal reference. Any protocol or transport
	// failure falls back to the inline marker, so clipboard content is not lost.
	const choosePasteSaveFile = useCallback(() => {
		if (!pasteMenu) return;
		const pendingPaste = pasteMenu;
		setPasteMenu(null);
		// The menu's button leaves with it: typing goes on in the field while the file is written.
		textareaRef.current?.focus();
		// Capture tab AND session at click time: after the RPC resolves,
		// `setText` may belong to a different tab's draft (tab switch) or a
		// different session's draft (in-place session replace). Both success
		// and fallback paths are gated — a cross-session paste corrupts both.
		const origin = {
			tabId: runtimeTabId,
			sessionId: sessionRuntimeStore<SessionStore>(runtimeTabId, "session")?.getState().sessionId,
		};
		const stillOrigin = () =>
			origin.tabId !== null &&
			sessionRuntimeStore<SessionStore>(origin.tabId, "session")?.getState().sessionId === origin.sessionId;
		void (async () => {
			try {
				const response = await rpc.writeLocalPaste(pendingPaste.content);
				if (!stillOrigin()) return;
				if (!response.success) throw new Error(response.error);
				const data = response.data as { url?: string } | undefined;
				if (!data?.url) throw new Error("write_local_paste returned no URL");
				const el = textareaRef.current;
				const current = el?.value ?? text;
				const start = el?.selectionStart ?? current.length;
				const end = el?.selectionEnd ?? start;
				const insert = `${data.url} `;
				el?.focus();
				placeDraft(`${current.slice(0, start)}${insert}${current.slice(end)}`, start + insert.length);
			} catch (cause) {
				// The RPC threw (transport/permission): without the origin gate the
				// inline fallback would splice clipboard content into whichever
				// composer is now foreground.
				if (!stillOrigin()) return;
				toastError({ title: t("input.paste.saveFailed"), error: cause });
				insertPasteBlob(pendingPaste.content);
			}
		})();
	}, [insertPasteBlob, pasteMenu, text, t, placeDraft, runtimeTabId, rpc]);

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
	/** The send of the latest render: a take transcribed later sends what the composer holds then (pictures, mode, run). */
	const sendRef = useRef(send);
	useEffect(() => {
		sendRef.current = send;
	}, [send]);

	// Mic dictation (stt.enabled): click starts capture, click again (or Enter)
	// stops and transcribes, Esc discards; the transcript inserts at the
	// textarea caret. The send button's "Stop and send" and the
	// stt.submitTrigger setting submit the utterance (TUI parity).
	const handleMicClick = useCallback(() => {
		if (recording) {
			if (dictation === "starting") cancelVoiceRecording();
			else stopVoiceRecording();
			return;
		}
		setDictation("starting");
		ownsTake.current = true;
		sendAfterDictationRef.current = false;
		void recordAndTranscribe({
			onRecording: () => {
				if (!mountedRef.current) return;
				setDictationStartedAt(Date.now());
				setDictation("recording");
			},
			onLevels: levels => {
				if (mountedRef.current) setDictationLevels(levels);
			},
			onTranscribing: () => {
				if (mountedRef.current) setDictation("transcribing");
			},
		}).then(async result => {
			ownsTake.current = false;
			if (!mountedRef.current) return;
			const sendAfter = sendAfterDictationRef.current;
			sendAfterDictationRef.current = false;
			setDictation("idle");
			setDictationStartedAt(null);
			setDictationLevels(Array(METER_BARS).fill(0));
			if ("error" in result) {
				if (result.error) toastError({ title: t("voice.mic.failed"), error: result });
				return;
			}
			const utterance = result.text.trim();
			const trigger = await readSttSubmitTrigger();
			const evaluation = evaluateSttSubmitTrigger(utterance, trigger);
			const insert = (
				evaluation.trimTrailing > 0 ? utterance.slice(0, utterance.length - evaluation.trimTrailing) : utterance
			).trimEnd();
			if (!mountedRef.current) return;
			if (!insert) {
				// Nothing heard: "Stop and send" still sends what the draft already holds.
				if (sendAfter && textareaRef.current?.value.trim()) sendRef.current();
				return;
			}
			// Read the live DOM value/caret: the user may have typed mid-recording.
			const el = textareaRef.current;
			const current = el?.value ?? "";
			const start = el?.selectionStart ?? current.length;
			const end = el?.selectionEnd ?? start;
			const before = current.slice(0, start);
			const after = current.slice(end);
			const prefix = before.length > 0 && !before.endsWith(" ") ? " " : "";
			const suffix = after.length === 0 ? " " : "";
			const insertedText = `${prefix}${insert}${suffix}`;
			const next = `${before}${insertedText}${after}`;
			el?.focus();
			placeDraft(next, start + insertedText.length);
			if (evaluation.submit || sendAfter) sendRef.current(next);
		});
	}, [recording, dictation, t, placeDraft]);

	// While the mic is open, Enter ends the take (transcribe and insert) and Esc
	// discards it, before any other key handler (the composer's, App's abort).
	useEffect(() => {
		if (dictation !== "starting" && dictation !== "recording") return;
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (isImeKeyEvent(event)) return;
			const finish = event.key === "Enter" && !event.shiftKey && dictation === "recording";
			if (event.key !== "Escape" && !finish) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			if (finish) stopVoiceRecording();
			else cancelVoiceRecording();
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [dictation]);

	/**
	 * Expanded composer (TUI app.editor.external parity, GUI-native form): ⌃G
	 * or the + menu grows the composer in place to fill the session pane for
	 * long drafts — the same field, so completion, paste markers, IME and
	 * history keep working. Enter adds a line there; ⌘↵ sends; Esc collapses.
	 */
	const toggleExpanded = (next?: boolean) => {
		setExpanded(current => next ?? !current);
		requestAnimationFrame(() => textareaRef.current?.focus());
	};

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

	const historyContext = (): InputHistoryContext => ({
		cwd,
		owner: `${runtimeTabId}:${sessionId}`,
		device: historyDevice,
	});
	/** ↑/↓ (or a ⌃R pick) is showing history entries for this composer, the draft waiting in the stash. */
	const browsingHistory = (context: InputHistoryContext) => {
		const history = useInputHistoryStore.getState();
		return (
			history.navIndex !== -1 &&
			history.navContext?.owner === context.owner &&
			history.navContext?.cwd === context.cwd &&
			history.navContext?.device === context.device
		);
	};
	/**
	 * Show a history entry the history store moved to: the draft's own pictures step aside while
	 * browsing and come back with it, an entry brings the pictures it was sent with.
	 */
	const showRecalled = (recalled: string, wasBrowsing: boolean, caret: number) => {
		if (!wasBrowsing) navDraftImages.current = images;
		const backToDraft = useInputHistoryStore.getState().navIndex === -1;
		setImages(backToDraft ? navDraftImages.current : [...historyImages(recalled)]);
		placeDraft(recalled, caret);
	};

	const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		// IME composition (Chinese/Japanese/Korean input): while the candidate
		// window is open, Enter and friends belong to the IME — committing the
		// composition must never send the message.
		if (isImeKeyEvent(e)) return;
		// Pending paste choice: Enter takes the first form (inline), Esc cancels it. Keys that would edit
		// the field under the menu wait: the paste has no place in the draft until it has its form.
		if (pasteMenu) {
			if (e.key === "Escape") {
				e.preventDefault();
				setPasteMenu(null);
			} else if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
				e.preventDefault();
				choosePasteInline();
			} else if (
				e.key === "Enter" ||
				e.key === "Backspace" ||
				e.key === "Delete" ||
				(e.key.length === 1 && !e.metaKey && !e.ctrlKey) ||
				((e.metaKey || e.ctrlKey) && (e.code === "KeyZ" || e.code === "KeyY" || e.code === "KeyX"))
			)
				e.preventDefault();
			return;
		}
		// Ghost text: Tab takes it, Esc hides it (and only then keeps Esc's other meanings off);
		// any other key drops it and aborts the request (typing restarts the debounce).
		const plainKey = !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey;
		if (e.key === "Tab" && plainKey) {
			const accepted = inline.accept();
			if (accepted !== null) {
				e.preventDefault();
				placeDraft(accepted, accepted.length);
				return;
			}
		}
		if (e.key === "Escape" && plainKey && inline.dismiss()) {
			e.preventDefault();
			return;
		}
		if (!["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(e.key)) inline.drop();
		if (chipsShown) {
			const chipIndex = e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey ? chipIndexForCode(e.code) : undefined;
			const chip = chipIndex === undefined ? undefined : nextPromptView.chips[chipIndex];
			if (chip !== undefined) {
				e.preventDefault();
				pickChip(chip);
				return;
			}
			if (e.key === "ArrowDown" && plainKey) {
				e.preventDefault();
				chipsRef.current?.focusFirst();
				return;
			}
		}
		if (nextPrompt !== undefined && text === "" && (e.key === "Tab" || e.key === "ArrowRight") && plainKey) {
			e.preventDefault();
			placeDraft(nextPrompt, nextPrompt.length);
			nextPromptView.accepted();
			return;
		}
		if (menu && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
			dismissMenu();
			return;
		}
		// The menu takes plain keys only: Shift+Enter still adds a line, ⌘↵ still sends, Shift+Tab
		// and Shift+arrows keep their own meaning.
		if (menu && plainKey) {
			const count = menu.items.length;
			// Home/End jump to the ends, PageUp/PageDown move a page; the caret stays put.
			const paged =
				e.key === "Home"
					? 0
					: e.key === "End"
						? count - 1
						: e.key === "PageUp"
							? Math.max(0, menu.index - MENU_PAGE)
							: e.key === "PageDown"
								? Math.min(count - 1, menu.index + MENU_PAGE)
								: undefined;
			if (paged !== undefined) {
				e.preventDefault();
				setMenu({ ...menu, index: Math.max(0, paged) });
				return;
			}
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setMenu({ ...menu, index: (menu.index + 1) % Math.max(1, count) });
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setMenu({ ...menu, index: (menu.index - 1 + Math.max(1, count)) % Math.max(1, count) });
				return;
			}
			if (e.key === "Tab" || e.key === "Enter") {
				e.preventDefault();
				const item = menu.items[menu.index];
				if (item) insertCompletion(item);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				dismissMenu();
				return;
			}
		}
		// The composer's own chords are read from the physical key, as keymap.ts reads every chord:
		// `e.key` is "R" with Caps Lock on and another letter on a non-Latin layout.
		const chord = chordFromEvent(e);
		// Ctrl+R: history search overlay (TUI `app.history.search`).
		if (chord === "⌃R") {
			e.preventDefault();
			setHistorySearchOpen(open => !open);
			return;
		}
		// ⌃G: expand / collapse the composer in place.
		if (chord === "⌃G") {
			e.preventDefault();
			toggleExpanded();
			return;
		}
		if (expanded && e.key === "Escape") {
			// Claim the key: the app-wide Escape would abort a running turn.
			e.preventDefault();
			e.stopPropagation();
			toggleExpanded(false);
			return;
		}
		// ⌃J inserts a newline at the caret (macOS: on Windows Ctrl+J toggles the panel), continuing a list;
		// ⌃U deletes the selection, or back to the start of the line.
		const newline = chord === "⌃J" && PLATFORM === "mac";
		if (newline && continueListAtCaret()) {
			e.preventDefault();
			return;
		}
		if (newline || chord === "⌃U") {
			const el = textareaRef.current;
			if (!el) return;
			e.preventDefault();
			const start = el.selectionStart ?? text.length;
			const end = el.selectionEnd ?? start;
			const from = newline || start !== end ? start : start === 0 ? 0 : text.lastIndexOf("\n", start - 1) + 1;
			const insert = newline ? "\n" : "";
			placeDraft(`${text.slice(0, from)}${insert}${text.slice(end)}`, from + insert.length);
			return;
		}
		// Esc: a selection collapses first. While no turn runs, a draft clears on a
		// second Esc (the first shows a hint; the cleared draft stays in ↑ history),
		// and an empty composer runs stock's `doubleEscapeAction` (rewind picker or
		// session tree, as in the TUI). A running turn keeps the app-wide stop.
		if (e.key === "Escape" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
			const el = textareaRef.current;
			if (el && el.selectionStart !== el.selectionEnd) {
				e.preventDefault();
				el.setSelectionRange(el.selectionEnd, el.selectionEnd);
				return;
			}
			if (!isStreaming && !submitPending && !manualMaintenance) {
				e.preventDefault();
				const now = Date.now();
				const armed = escArmedAt.current !== null && now - escArmedAt.current < DOUBLE_ESC_MS;
				escArmedAt.current = armed ? null : now;
				if (text.trim() === "" && images.length === 0) {
					if (armed) void runDoubleEscapeAction();
					return;
				}
				if (!armed) {
					setEscHint(true);
					return;
				}
				useInputHistoryStore.getState().record(expandPasteMarkers(text), cwd, rpc, historyDevice);
				dropReferencedPastes(text);
				// One native edit: Cmd/Ctrl+Z brings the cleared text back.
				placeDraft("", 0);
				setImages([]);
				setEscHint(false);
				return;
			}
		}
		// Up/Down prompt-history recall, as in a terminal: ↑ recalls an older entry only from an empty
		// composer or with the caret at position 0, ↓ a newer entry (and finally the stashed draft) only
		// with the caret at the very end. Anywhere else the arrows move the caret through the text.
		// Browsing stays a run of plain presses because a recall places the caret on the edge the key
		// came from — ↑ at position 0, ↓ at the end (stock pi-tui's directional anchor, #99) — so the
		// next press in the same direction satisfies the same rule; turning around takes one caret move.
		if (
			!expanded &&
			(e.key === "ArrowUp" || e.key === "ArrowDown") &&
			!e.ctrlKey &&
			!e.metaKey &&
			!e.altKey &&
			!e.shiftKey
		) {
			const el = textareaRef.current;
			if (el) {
				const caretStart = el.selectionStart ?? 0;
				const caretEnd = el.selectionEnd ?? caretStart;
				const history = useInputHistoryStore.getState();
				const context = historyContext();
				const older = e.key === "ArrowUp";
				const wasBrowsing = browsingHistory(context);
				const recalled =
					older && caretEnd === 0
						? history.prev(text, context)
						: !older && caretStart === text.length
							? history.next(context)
							: undefined;
				if (recalled !== undefined) {
					e.preventDefault();
					showRecalled(recalled, wasBrowsing, older ? 0 : recalled.length);
					return;
				}
			}
		}
		// Line-adding keys (Shift+Enter, plain Enter while expanded) continue a markdown list.
		if (
			e.key === "Enter" &&
			!e.ctrlKey &&
			!e.metaKey &&
			!e.altKey &&
			(e.shiftKey || expanded) &&
			continueListAtCaret()
		) {
			e.preventDefault();
			return;
		}
		if (e.key === "Enter" && !e.shiftKey) {
			// The follow-up chord (⌃↵ on macOS, ⌥↵ on Windows) sends as a follow-up, queueing
			// behind the current yield (TUI app.message.followUp); idle sessions start
			// immediately either way. Every other Enter sends in the chip's mode, so the
			// platform's send chord (⌘↵, Ctrl+Enter on Windows) steers a running turn.
			const followUp = isComposerFollowUpKey(e);
			// Expanded: plain Enter is a newline; ⌘↵ sends and collapses.
			if (expanded && !e.metaKey && !e.ctrlKey && !followUp) return;
			e.preventDefault();
			// A held Enter sends once, never again on auto-repeat.
			if (e.repeat) return;
			// ⌘↵ collapses the expanded composer only once the draft went out.
			if (send(undefined, followUp ? "followUp" : undefined) && expanded) setExpanded(false);
		}
	};

	const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
		const files = Array.from(e.clipboardData.files);
		const pasted = e.clipboardData.getData("text/plain");
		if (files.length > 0) {
			e.preventDefault();
			// A clipboard may hold files and text together (a picture copied with its caption): the text
			// goes in too. A file manager's copy also carries the files' names as text: that text is the
			// files themselves, already attached.
			const names = new Set(files.map(file => file.name));
			const lines = pasted
				.split(/\r?\n/)
				.map(line => line.trim())
				.filter(line => line !== "");
			if (lines.some(line => !names.has(line) && !names.has(line.split(/[\\/]/).at(-1) ?? "")))
				pasteText(pasted, true);
			attachFiles(files);
			return;
		}
		if (pasted && pasteText(pasted, false)) e.preventDefault();
	};

	/**
	 * A clipboard's text. Large TEXT paste (TUI editor.ts:1996-2044 parity): sanitize, then collapse to a
	 * `[Paste #N]` marker past the marker threshold; past the (separate, line-count-only) menu threshold,
	 * offer the inline/wrapped choice first. A small paste is the field's own default unless `own` (the
	 * default was cancelled for a file beside it): then it goes in at the caret here. False when the
	 * field's default paste should run.
	 */
	const pasteText = (pasted: string, own: boolean): boolean => {
		const content = pasted
			.replace(/\r\n?/g, "\n")
			.normalize("NFC")
			.replace(/\t/g, "   ")
			.replace(/[\x00-\x08\x0B-\x1F]/g, "");
		if (!isMarkerSized(content)) {
			if (!own) return false;
			const el = textareaRef.current;
			const current = el?.value ?? text;
			const start = el?.selectionStart ?? current.length;
			const end = el?.selectionEnd ?? start;
			placeDraft(`${current.slice(0, start)}${content}${current.slice(end)}`, start + content.length);
			return true;
		}
		const lineCount = content.split("\n").length;
		if (shouldOfferPasteMenu(lineCount, pasteMenuThreshold)) setPasteMenu({ content, lineCount });
		else insertPasteBlob(content);
		return true;
	};

	const modeLabel = mode === "followUp" ? t("input.followUp") : t("input.steer");

	/** Splice text in at the caret (replacing a selection), space-separated from its neighbours. */
	const insertAtCaret = (insert: string) => {
		const el = textareaRef.current;
		const current = el?.value ?? text;
		const start = el?.selectionStart ?? current.length;
		const end = el?.selectionEnd ?? start;
		const before = current.slice(0, start);
		const after = current.slice(end);
		const inserted = `${before && !/\s$/.test(before) ? " " : ""}${insert}${/^\s/.test(after) ? "" : " "}`;
		el?.focus();
		placeDraft(`${before}${inserted}${after}`, start + inserted.length);
	};

	/**
	 * Picker, drop and clipboard files (composer-files.ts): images attach, other
	 * files and folders become `@path` mentions stock reads at send time (PDF and
	 * Office through its read tool), and a file this tab's machine cannot reach by
	 * path goes in as its text; the rest are refused with a reason.
	 */
	const attachFiles = (files: readonly File[]) => {
		if (files.length === 0) return;
		void intakeComposerFiles(files, {
			cwd,
			pathFor: file => window.omp.fs.pathForFile(file),
			remote: historyDevice !== undefined,
		}).then(async intake => {
			if (!mountedRef.current) return;
			const pieces = [
				...intake.mentions,
				...intake.texts.map(file => {
					const blob = storePaste(fileTextAttachment(file.name, file.content));
					return pasteMarkerText(blob.id, blob.content);
				}),
			];
			if (pieces.length > 0) insertAtCaret(pieces.join(" "));
			const reasons = {
				empty: "input.files.empty",
				tooLarge: "input.files.tooLarge",
				binary: historyDevice === undefined ? "input.files.noPath" : "input.files.remoteBinary",
				unreadable: "input.files.unreadable",
			} as const;
			for (const rejection of intake.rejected)
				toast({ variant: "warning", message: t(reasons[rejection.reason], { name: rejection.name }) });
			if (intake.images.length === 0) return;
			const added = await Promise.all(intake.images.map(fileToImage));
			setImages(previous => [...previous, ...added]);
		});
	};

	// Files dropped on the composer go through attachFiles like a paste; a Files
	// tree row becomes an @mention (C42); anything else keeps the browser
	// default (text drops insert into the field).
	const draggingFiles = (event: DragEvent<HTMLElement>) => {
		const types = Array.from(event.dataTransfer.types);
		return types.includes("Files") || types.includes(FILE_DRAG_TYPE);
	};
	const dropProps = {
		onDragEnter: (event: DragEvent<HTMLDivElement>) => {
			if (draggingFiles(event)) setDragActive(true);
		},
		onDragOver: (event: DragEvent<HTMLDivElement>) => {
			if (!draggingFiles(event)) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = "copy";
		},
		onDragLeave: (event: DragEvent<HTMLDivElement>) => {
			if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
		},
		onDrop: (event: DragEvent<HTMLDivElement>) => {
			setDragActive(false);
			if (!draggingFiles(event)) return;
			event.preventDefault();
			const row = readFileDrag(event.dataTransfer);
			if (row) {
				window.dispatchEvent(
					new CustomEvent("omp:insert-mention", { detail: { path: row.path, tabId: runtimeTabId } }),
				);
				return;
			}
			attachFiles(Array.from(event.dataTransfer.files));
		},
	};

	const sendDisabled =
		!routeReady || status !== "ready" || sending || submissionUncertain || (!text.trim() && images.length === 0);
	// While first-run setup runs, the live model is whatever omp fell back to
	// (e.g. a tiny on-device model); show the neutral prompt instead.
	const modelLabel = model && !settingUp ? model.name || model.id : t("input.chooseModel");
	const placeholder =
		status !== "ready"
			? t("input.placeholder.connecting")
			: nextPrompt !== undefined
				? nextPrompt
				: isStreaming
					? mode === "followUp"
						? t("input.placeholder.followUp")
						: t("input.placeholder.streaming")
					: isChat || fieldNarrow
						? t("input.placeholder.chat")
						: t("input.placeholder.idle");
	/** Tab-accept hint chip: only while the suggestion is the visible placeholder. */
	const showSuggestionHint = nextPrompt !== undefined && text === "";
	const suggestionHintId = useId();
	const menuId = useId();
	const menuIndex = menu?.index;
	// Home/End/PageDown/↓ can land on a row below the listbox's fold.
	useEffect(() => {
		if (menuIndex === undefined) return;
		document.getElementById(`${menuId}-${menuIndex}`)?.scrollIntoView?.({ block: "nearest" });
	}, [menuId, menuIndex]);
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
					<div
						ref={pasteMenuRef}
						role="dialog"
						aria-label={t("input.paste.title", { lines: pasteMenu.lineCount, chars: pasteMenu.content.length })}
						className="omp-pop-in absolute right-0 bottom-full left-0 z-(--sc-z-popover) mb-2 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) bg-(--sc-elevated) p-3 shadow-(--sc-shadow-md)"
					>
						<div className="flex items-baseline justify-between gap-3">
							<span className="text-sc-md font-medium text-(--sc-text)">
								{t("input.paste.title", { lines: pasteMenu.lineCount, chars: pasteMenu.content.length })}
							</span>
							<span className="shrink-0 text-sc-sm text-(--sc-text-muted)">{t("input.paste.hint")}</span>
						</div>
						<pre className="mt-2 max-h-32 overflow-hidden rounded-(--sc-radius-md) border border-(--sc-divider) bg-(--sc-surface-1) px-2.5 py-2 font-mono text-sc-sm break-all whitespace-pre-wrap text-(--sc-text-secondary)">
							{(() => {
								const lines = pasteMenu.content.split("\n");
								if (lines.length <= 6) return pasteMenu.content;
								const head = lines.slice(0, 3).join("\n");
								const tail = lines.slice(-2).join("\n");
								return `${head}\n${t("input.paste.moreLines", { count: lines.length - 5 })}\n${tail}`;
							})()}
						</pre>
						<div className="mt-3 flex flex-wrap gap-2">
							<Button onClick={choosePasteInline} size="sm" variant="primary">
								{t("input.paste.inline")}
							</Button>
							<Button onClick={choosePasteWrapped} size="sm">
								{t("input.paste.wrap")}
							</Button>
							<Button onClick={choosePasteSaveFile} size="sm">
								{t("input.paste.saveFile")}
							</Button>
							<Button
								onClick={() => {
									setPasteMenu(null);
									textareaRef.current?.focus();
								}}
								size="sm"
								variant="ghost"
							>
								{t("input.paste.cancel")}
							</Button>
						</div>
					</div>
				)}
				<ComposerQueue onSettled={() => textareaRef.current?.focus()} />

				{/* Anchoring context for completion/history overlays: they sit directly
				    above the input box instead of the surrounding composer region. */}
				<div className="omp-composer-anchor relative">
					{menu && (
						<div
							aria-label={t("input.completion.label")}
							className="absolute bottom-full left-0 z-(--sc-z-popover) mb-2 max-h-[60vh] w-[min(440px,100%)] overflow-y-auto rounded-(--sc-radius-lg) border border-(--sc-border-subtle) bg-(--sc-elevated) p-1 shadow-(--sc-shadow-md)"
							id={menuId}
							role="listbox"
						>
							{menu.items.map((item, index) => (
								<button
									aria-selected={index === menu.index}
									id={`${menuId}-${index}`}
									key={`${menu.source}:${item.label}`}
									type="button"
									role="option"
									onMouseDown={event => {
										event.preventDefault();
										insertCompletion(item);
									}}
									title={
										item.description
											? `${item.label}\n${item.description.replace(/\s+/g, " ").trim()}`
											: undefined
									}
									className={cx(
										"flex min-h-(--sc-control-md) w-full items-baseline gap-3 rounded-(--sc-radius-sm) px-2.5 py-1.5 text-left",
										index === menu.index ? "bg-(--sc-selected)" : "hover:bg-(--sc-hover)",
									)}
								>
									<span className="shrink-0 font-mono text-sc-md font-medium text-(--sc-text)">
										{item.label}
									</span>
									{item.description && (
										<span className="min-w-0 truncate text-sc-sm text-(--sc-text-muted)">
											{item.description}
										</span>
									)}
									{item.hint && (
										<span className="ml-auto shrink-0 font-mono text-sc-xs text-(--sc-text-subtle)">
											{item.hint}
										</span>
									)}
								</button>
							))}
						</div>
					)}

					{historySearchOpen && (
						<HistorySearchOverlay
							cwd={cwd}
							onSelect={prompt => {
								setHistorySearchOpen(false);
								textareaRef.current?.focus();
								// A pick replaces the draft the way ↑ does: the draft and its pictures wait in the
								// history's stash (↓ brings them back), and Cmd/Ctrl+Z restores the text.
								const context = historyContext();
								const wasBrowsing = browsingHistory(context);
								if (useInputHistoryStore.getState().recall(prompt, text, context))
									showRecalled(prompt, wasBrowsing, prompt.length);
								else placeDraft(prompt, prompt.length);
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
							chips={nextPromptView.chips}
							handleRef={chipsRef}
							onPick={pickChip}
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
						{images.length > 0 && (
							<ul aria-label={t("input.attachments")} className="flex flex-wrap gap-2.5 px-3 pt-3">
								{images.map((image, index) => (
									<li key={index} className="relative">
										<ZoomableImage
											src={image.preview}
											alt={t("input.attachmentAlt", { index: index + 1 })}
											className="size-14 rounded-(--sc-radius-lg) border border-(--sc-border-subtle) object-cover"
											gallery={images.map((item, itemIndex) => ({
												src: item.preview,
												alt: t("input.attachmentAlt", { index: itemIndex + 1 }),
											}))}
											onRemove={() =>
												setImages(previous => previous.filter((_, itemIndex) => itemIndex !== index))
											}
										/>
										<IconButton
											className="omp-composer-attachment-remove absolute -top-1.5 -right-1.5"
											icon={<X />}
											label={t("input.removeAttachment", { index: index + 1 })}
											onClick={() => {
												setImages(previous => previous.filter((_, itemIndex) => itemIndex !== index));
												// The button leaves with its picture: typing goes on in the field, never on <body>.
												textareaRef.current?.focus();
											}}
											size="sm"
											variant="secondary"
										/>
									</li>
								))}
							</ul>
						)}
						{draftPastes.length > 0 && (
							<ul aria-label={t("input.paste.listLabel")} className="flex flex-wrap gap-1.5 px-3 pt-3">
								{draftPastes.map(id => (
									<li key={id}>
										<button
											className="flex h-7 items-center gap-1.5 rounded-(--sc-radius-full) border border-(--sc-border-subtle) px-2.5 text-sc-xs text-(--sc-text-secondary) hover:bg-(--sc-hover) hover:text-(--sc-text) focus-visible:outline-2 focus-visible:outline-(--sc-accent)"
											data-paste-chip={id}
											onClick={() => setEditingPaste(id)}
											title={t("input.paste.edit")}
											type="button"
										>
											<ClipboardPaste aria-hidden className="size-(--sc-icon-sm) text-(--sc-text-muted)" />
											<span className="tabular-nums">
												{t("input.paste.chip", { id, lines: getPaste(id)?.lineCount ?? 0 })}
											</span>
										</button>
									</li>
								))}
							</ul>
						)}
						<DraftFileCards
							onRemove={path => {
								// The card leaves with its mention: one native edit in the focused field (⌘Z puts it back).
								const el = textareaRef.current;
								el?.focus();
								const next = removeFileMention(el?.value ?? text, path);
								placeDraft(next, next.length);
							}}
							text={text}
						/>
						<PastedTextDialog
							onClose={() => setEditingPaste(null)}
							onSave={(id, content) => {
								setText(current => editPaste(current, id, content));
								setEditingPaste(null);
							}}
							pasteId={editingPaste}
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
								onKeyDown={handleKeyDown}
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
								onPaste={handlePaste}
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
							{dictation !== "idle" && (
								<DictationOverlay levels={dictationLevels} phase={dictation} startedAt={dictationStartedAt} />
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

						{escHint ? (
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

						<div
							aria-busy={!routeReady}
							aria-label={t("input.toolbar")}
							className="omp-composer-toolbar flex min-h-11 flex-wrap items-center gap-1 pr-2.5 pb-2.5 pl-2"
							inert={!routeReady}
							role="toolbar"
						>
							<MenuButton
								icon={<Plus />}
								items={[
									{
										id: "attach",
										label: t("input.attach"),
										icon: Paperclip,
										onSelect: () => fileInputRef.current?.click(),
									},
									{
										id: "history",
										label: t("input.history.title"),
										description: t("input.history.menuDesc"),
										icon: History,
										shortcut: "⌃R",
										onSelect: () => setHistorySearchOpen(true),
									},
									{
										id: "expand",
										label: expanded ? t("input.expanded.collapse") : t("input.expanded.open"),
										icon: expanded ? Minimize2 : Maximize2,
										shortcut: "⌃G",
										onSelect: () => toggleExpanded(),
									},
									{
										id: "goal",
										label: t("input.addMenu.goal"),
										description: t("input.addMenu.goalDesc"),
										icon: Target,
										separatorBefore: true,
										onSelect: () => openModes("goal"),
									},
									{
										id: "skills",
										label: t("input.addMenu.skills"),
										icon: Sparkles,
										separatorBefore: true,
										onSelect: () => setSkillPickerOpen(true),
									},
								]}
								label={t("input.addMenu")}
								side="above"
								size="sm"
							/>
							<input
								ref={fileInputRef}
								type="file"
								multiple
								className="hidden"
								onChange={event => {
									attachFiles(Array.from(event.target.files ?? []));
									event.target.value = "";
								}}
							/>

							<ComposerModes />
							<RunSettings />
							<DelegationControl />

							{composerMode && (
								<Tooltip
									content={
										composerMode.mode === "bash" ? t("input.mode.bash.title") : t("input.mode.python.title")
									}
								>
									<span className="inline-flex">
										<Badge variant={composerMode.mode === "bash" ? "info" : "warning"}>
											{composerMode.mode === "bash"
												? t("input.mode.bash.badge")
												: t("input.mode.python.badge")}
										</Badge>
									</span>
								</Tooltip>
							)}
							{queueBody !== undefined && (
								<Tooltip content={t("input.queue.title")}>
									<span className="inline-flex">
										<Badge variant="warning">
											{queueSplitCount > 1
												? t("input.queue.badgeSplit", { count: queueSplitCount })
												: t("input.queue.badge")}
										</Badge>
									</span>
								</Tooltip>
							)}

							<div className="flex-1" />

							<div className="omp-composer-send-cluster flex shrink-0 items-center gap-1">
								<Tooltip content={model ? t("input.modelTooltip", { id: model.id }) : t("input.model")}>
									<Button
										aria-label={t("input.modelLabel", { model: modelLabel })}
										className="omp-composer-chip min-w-0 max-w-56"
										data-model-chip
										icon={<Cpu aria-hidden className="omp-composer-model-icon" />}
										onClick={() => openModelPicker()}
										size="sm"
										trailingIcon={
											<ChevronDown aria-hidden className="omp-composer-chevron text-(--sc-text-subtle)" />
										}
										variant="ghost"
									>
										<span className="omp-composer-model-label truncate">{modelLabel}</span>
									</Button>
								</Tooltip>
								{!settingUp && <ContextUsagePopover />}
								{sttEnabled && (
									<IconButton
										className={cx(
											recording && "bg-(--sc-danger-soft) text-(--sc-danger) hover:text-(--sc-danger)",
										)}
										icon={recording ? <Square className="omp-pulse-dot" fill="currentColor" /> : <Mic />}
										label={recording ? t("voice.mic.stop") : t("voice.mic.start")}
										onClick={handleMicClick}
										size="sm"
									/>
								)}
								{isStreaming && (
									<Tooltip content={t("input.sendModeHint")}>
										<Button
											aria-label={t("input.sendModeLabel", { mode: modeLabel })}
											className="omp-composer-chip"
											data-send-mode={mode === "followUp" ? "followUp" : "steer"}
											disabled={!routeReady}
											icon={mode === "followUp" ? <ListPlus aria-hidden /> : <CornerDownRight aria-hidden />}
											onClick={() => {
												setMode(current => (current === "followUp" ? "steer" : "followUp"));
												// The choice is for the message being typed: typing goes on in the field.
												textareaRef.current?.focus();
											}}
											size="sm"
											variant="ghost"
										>
											<span className="omp-composer-control-label omp-composer-label-early">
												{modeLabel}
											</span>
										</Button>
									</Tooltip>
								)}
								{/* The turn's primary actions: a round Send that turns into Stop while a
								    turn runs with nothing to send; with a draft, Stop steps back beside it. */}
								<div className="ml-1 flex items-center gap-1.5">
									{stoppable && (
										<IconButton
											className="omp-composer-action"
											disabled={!routeReady}
											icon={<Square className="omp-composer-stop-glyph" fill="currentColor" />}
											label={t("input.abort")}
											onClick={() => {
												void abortActiveTurn(rpc, runtimeTabId);
												// The button leaves with the run: typing goes on in the field, never on <body>.
												textareaRef.current?.focus();
											}}
											shortcut="Esc"
											variant={showSend ? "secondary" : "primary"}
										/>
									)}
									{dictation === "recording" ? (
										<IconButton
											className="omp-composer-action"
											data-dictation-send
											disabled={!routeReady}
											icon={<ArrowUp strokeWidth={2.25} />}
											label={t("voice.dictation.stopAndSend")}
											onClick={() => {
												sendAfterDictationRef.current = true;
												stopVoiceRecording();
											}}
											variant="primary"
										/>
									) : (
										showSend && (
											<ComposerSend label={t("input.send")}>
												<IconButton
													className="omp-composer-action"
													disabled={sendDisabled}
													icon={<ArrowUp strokeWidth={2.25} />}
													label={t("input.send")}
													onClick={() => {
														// The expanded composer collapses only once the draft went out.
														if (send() && expanded) setExpanded(false);
														// The button disables itself once the draft clears; a disabled
														// focused control swallows keystrokes (⌘, and friends), so keep
														// typing focus in the composer like Enter does.
														textareaRef.current?.focus();
													}}
													tooltip={false}
													variant="primary"
												/>
											</ComposerSend>
										)
									)}
								</div>
							</div>
						</div>
					</div>
				</div>
				<BelowEditorDockSlot />
			</div>
		</div>
	);
}
